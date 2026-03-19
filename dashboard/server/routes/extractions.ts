import express from 'express'
import fs from 'fs'
import path from 'path'
import { homedir } from 'os'
import { deleteExtractionRun, getExtractionRun, listExtractionRuns } from '../../../src/lib/extraction-log.js'
import { reviewExtraction, reviewExtractionStreaming } from '../../../src/lib/extraction-review.js'
import { deleteRecord, fetchRecordsByIds } from '../../../src/lib/lancedb.js'
import { handlePostSession } from '../../../src/hooks/post-session.js'
import { parseTranscript } from '../../../src/lib/transcript.js'
import { deleteReview, getReview, saveReview } from '../../../src/lib/review-storage.js'
import type { ServerContext } from '../context.js'
import { createLogger } from '../lib/logger.js'
import { createSseStream, sendSseError } from '../lib/sse.js'
import { parseNonNegativeInt } from '../utils/params.js'
import { getRequestConfig } from '../utils/config.js'
import { ensureConfigInitialized } from '../utils/lancedb.js'

const logger = createLogger('extractions')

export function createExtractionsRouter(context: ServerContext): express.Router {
  const router = express.Router()
  const { config: baseConfig } = context

  router.get('/api/extractions', (req, res) => {
    try {
      const requestConfig = getRequestConfig(req, baseConfig)
      const runs = listExtractionRuns(requestConfig.lancedb.table)
      const limit = Math.min(parseNonNegativeInt(req.query.limit, 50), 500)
      const offset = parseNonNegativeInt(req.query.offset, 0)
      const page = runs.slice(offset, offset + limit)

      res.json({
        runs: page,
        count: page.length,
        total: runs.length,
        offset,
        limit
      })
    } catch (error) {
      logger.error('Failed to list extractions', error)
      res.status(500).json({ error: 'Failed to list extractions' })
    }
  })

  router.get('/api/extractions/in-progress', (_req, res) => {
    try {
      const locksDir = path.join(homedir(), '.claude-memory', 'locks')
      if (!fs.existsSync(locksDir)) {
        return res.json({ inProgress: [] })
      }

      const files = fs.readdirSync(locksDir)
      const staleMs = 5 * 60 * 1000
      const now = Date.now()
      const inProgress: Array<{ sessionId: string; pid: number; startedAt: number; elapsedMs: number }> = []

      for (const file of files) {
        if (!file.endsWith('.lock') || file === 'auto-maintenance.lock') continue
        const lockPath = path.join(locksDir, file)
        try {
          const content = fs.readFileSync(lockPath, 'utf-8').trim()
          const lines = content.split('\n')
          const pid = parseInt(lines[0], 10)
          const startedAt = parseInt(lines[1], 10)
          if (!Number.isFinite(pid) || !Number.isFinite(startedAt)) continue
          if (now - startedAt > staleMs) continue
          const sessionId = file.replace(/\.lock$/, '')
          inProgress.push({ sessionId, pid, startedAt, elapsedMs: now - startedAt })
        } catch {
          continue
        }
      }

      res.json({ inProgress })
    } catch (error) {
      logger.error('Failed to check in-progress extractions', error)
      res.json({ inProgress: [] })
    }
  })

  router.get('/api/extractions/:runId', async (req, res) => {
    try {
      const requestConfig = getRequestConfig(req, baseConfig)
      const run = getExtractionRun(req.params.runId, requestConfig.lancedb.table)
      if (!run) {
        return res.status(404).json({ error: 'Extraction run not found' })
      }

      const insertedIds = run.extractedRecordIds ?? []
      const updatedIds = run.updatedRecordIds ?? []
      const ids = Array.from(new Set([...insertedIds, ...updatedIds]))
      if (ids.length === 0) {
        return res.json({ run, records: [] })
      }

      const config = await ensureConfigInitialized(req, baseConfig)

      const records = await fetchRecordsByIds(ids, config)

      res.json({ run, records })
    } catch (error) {
      logger.error('Failed to get extraction run', error)
      res.status(500).json({ error: 'Failed to get extraction run' })
    }
  })

  router.delete('/api/extractions/:runId', async (req, res) => {
    try {
      const runId = req.params.runId
      const requestConfig = getRequestConfig(req, baseConfig)
      const run = getExtractionRun(runId, requestConfig.lancedb.table)
      if (!run) {
        return res.status(404).json({ error: 'Extraction run not found' })
      }

      const config = await ensureConfigInitialized(req, baseConfig)
      const insertedIds = run.extractedRecordIds ?? []
      const updatedIds = run.updatedRecordIds ?? []
      const ids = Array.from(new Set([...insertedIds, ...updatedIds]))

      for (const id of ids) {
        await deleteRecord(id, config)
      }

      deleteExtractionRun(runId, requestConfig.lancedb.table)
      deleteReview(runId, requestConfig.lancedb.table)
      res.json({ success: true })
    } catch (error) {
      logger.error('Failed to delete extraction run', error)
      res.status(500).json({ error: 'Failed to delete extraction run' })
    }
  })

  router.get('/api/extractions/:runId/review', (req, res) => {
    try {
      const requestConfig = getRequestConfig(req, baseConfig)
      const review = getReview(req.params.runId, requestConfig.lancedb.table)
      if (!review) {
        return res.status(404).json({ error: 'Review not found' })
      }
      res.json(review)
    } catch (error) {
      logger.error('Extraction review error', error)
      res.status(500).json({ error: 'Failed to get extraction review' })
    }
  })

  router.post('/api/extractions/:runId/review', async (req, res) => {
    try {
      const runId = req.params.runId
      const requestConfig = getRequestConfig(req, baseConfig)
      const run = getExtractionRun(runId, requestConfig.lancedb.table)
      if (!run) {
        return res.status(404).json({ error: 'Extraction run not found' })
      }

      const wantsStream = req.query.stream === 'true'
      if (wantsStream) {
        const stream = createSseStream(res)

        try {
          const config = await ensureConfigInitialized(req, baseConfig)
          const review = await reviewExtractionStreaming(runId, config, stream.onThinking, stream.signal)
          saveReview(review, config.lancedb.table)
          stream.sendData({ result: review })
          stream.done()
        } catch (error) {
          if (stream.signal.aborted) return
          logger.error('Extraction review error', error)
          sendSseError(stream, error, 'Failed to run extraction review')
        } finally {
          stream.end()
        }
        return
      }

      const config = await ensureConfigInitialized(req, baseConfig)
      const review = await reviewExtraction(runId, config)
      saveReview(review, config.lancedb.table)
      res.json(review)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error('Extraction review error', error)
      res.status(500).json({ error: message || 'Failed to run extraction review' })
    }
  })

  router.post('/api/extractions/:runId/re-extract', async (req, res) => {
    try {
      const runId = req.params.runId
      const requestConfig = getRequestConfig(req, baseConfig)
      const run = getExtractionRun(runId, requestConfig.lancedb.table)
      if (!run) {
        return res.status(404).json({ error: 'Extraction run not found' })
      }

      if (!run.transcriptPath || !fs.existsSync(run.transcriptPath)) {
        return res.status(400).json({ error: `Transcript file not found: ${run.transcriptPath || '(empty)'}` })
      }

      const config = await ensureConfigInitialized(req, baseConfig)

      // Recover the original cwd from transcript events (transcript path is under ~/.claude/, not the project)
      const transcript = await parseTranscript(run.transcriptPath)
      const firstCwd = transcript.events.find(e => e.cwd)?.cwd
      const cwd = firstCwd ?? path.dirname(run.transcriptPath)

      const result = await handlePostSession({
        hook_event_name: 'SessionEnd',
        session_id: run.sessionId,
        transcript_path: run.transcriptPath,
        cwd
      }, config, { flush: 'always' })

      res.json({
        success: true,
        inserted: result.inserted,
        updated: result.updated,
        skipped: result.skipped,
        failed: result.failed,
        reason: result.reason
      })
    } catch (error) {
      logger.error('Re-extraction failed', error)
      const message = error instanceof Error ? error.message : String(error)
      res.status(500).json({ error: message || 'Re-extraction failed' })
    }
  })

  return router
}
