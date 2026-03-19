import express from 'express'
import fs from 'fs'
import path from 'path'
import { homedir } from 'os'
import { deleteExtractionRun, getExtractionRun, saveExtractionRun } from '../../../src/lib/extraction-log.js'
import { getRecordSummary } from '../../../src/lib/record-summary.js'
import { getFirstUserPrompt } from '../../../src/lib/transcript.js'
import { reviewExtraction, reviewExtractionStreaming } from '../../../src/lib/extraction-review.js'
import { deleteRecord } from '../../../src/lib/lancedb.js'
import { paginateExtractionRuns, loadExtractionRunDetail } from '../lib/extraction-helpers.js'
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
      const limit = Math.min(parseNonNegativeInt(req.query.limit, 50), 500)
      const offset = parseNonNegativeInt(req.query.offset, 0)
      res.json(paginateExtractionRuns(requestConfig.lancedb.table, limit, offset))
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
      const config = await ensureConfigInitialized(req, baseConfig)
      const detail = await loadExtractionRunDetail(req.params.runId, config, { includeReview: false })
      if (!detail) {
        return res.status(404).json({ error: 'Extraction run not found' })
      }
      res.json({ run: detail.run, records: detail.records ?? [] })
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

      // Delete old records that the re-extract will replace
      const oldInsertedIds = run.extractedRecordIds ?? []
      const oldUpdatedIds = run.updatedRecordIds ?? []
      const oldIds = Array.from(new Set([...oldInsertedIds, ...oldUpdatedIds]))
      for (const id of oldIds) {
        try { await deleteRecord(id, config) } catch { /* already gone */ }
      }

      // Clear stale review
      deleteReview(runId, requestConfig.lancedb.table)

      const result = await handlePostSession({
        hook_event_name: 'SessionEnd',
        session_id: run.sessionId,
        transcript_path: run.transcriptPath,
        cwd
      }, config, { flush: 'always' })

      // Update the existing extraction run with new results
      const insertedIds = result.insertedIds ?? []
      const updatedIds = result.updatedIds ?? []
      const allIds = Array.from(new Set([...insertedIds, ...updatedIds]))
      const extractedRecords = result.records
        .map(r => {
          const summary = getRecordSummary(r)
          if (!r.id || !summary) return null
          return { id: r.id, type: r.type, summary, timestamp: r.timestamp }
        })
        .filter((r): r is NonNullable<typeof r> => r !== null)

      saveExtractionRun({
        ...run,
        timestamp: Date.now(),
        recordCount: allIds.length,
        parseErrorCount: result.transcript?.parseErrors ?? 0,
        extractedRecordIds: insertedIds,
        updatedRecordIds: updatedIds.length > 0 ? updatedIds : undefined,
        extractedRecords: extractedRecords.length > 0 ? extractedRecords : undefined,
        duration: 0,
        firstPrompt: result.transcript ? getFirstUserPrompt(result.transcript) : run.firstPrompt,
        tokenUsage: result.tokenUsage,
        extractedEventCount: result.extractedEventCount,
        hasRememberMarker: result.hasRememberMarker,
        skipReason: result.reason === 'too_short' ? 'too_short'
          : (result.reason === 'no_records' && allIds.length === 0) ? 'no_records'
          : undefined
      }, requestConfig.lancedb.table)

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
