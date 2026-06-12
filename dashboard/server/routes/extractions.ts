import express from 'express'
import fs from 'fs'
import path from 'path'
import { buildExtractionRecordSummaries, deleteExtractionRun, getExtractionRun, listExtractionRuns, listInProgressExtractions, saveExtractionRun } from '../../../src/lib/extraction-log.js'
import { getFirstUserPrompt } from '../../../src/lib/transcript.js'
import { reviewExtraction, reviewExtractionStreaming } from '../../../src/lib/extraction-review.js'
import { sanitizeExtractionFailure } from '../../../src/lib/extract.js'
import { deleteRecord } from '../../../src/lib/lancedb.js'
import { paginateExtractionRuns, loadExtractionRunDetail } from '../../../src/lib/extraction-query.js'
import { handlePostSession } from '../../../src/hooks/post-session.js'
import { parseTranscript } from '../../../src/lib/transcript.js'
import { deleteReview, getReview, saveReview } from '../../../src/lib/review-storage.js'
import { isTrueExtractionFailure } from '../../../src/lib/extraction-status.js'
import type { ServerContext } from '../context.js'
import { createLogger } from '../lib/logger.js'
import { createSseStream, sendSseError } from '../lib/sse.js'
import { buildExtractionWarnings } from '../lib/extraction-warnings.js'
import { parseNonNegativeInt } from '../utils/params.js'
import { getRequestConfig } from '../utils/config.js'
import { ensureConfigInitialized } from '../utils/lancedb.js'
import { formatStageTimings, sumStageTimings } from '../../../src/lib/extraction-timings.js'

const logger = createLogger('extractions')

export function createExtractionsRouter(context: ServerContext): express.Router {
  const router = express.Router()
  const { config: baseConfig } = context

  router.get('/api/extractions', (req, res) => {
    try {
      const requestConfig = getRequestConfig(req, baseConfig)
      const limit = Math.min(parseNonNegativeInt(req.query.limit, 50), 500)
      const offset = parseNonNegativeInt(req.query.offset, 0)
      const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId.trim() : undefined
      res.json(paginateExtractionRuns(requestConfig.lancedb.table, limit, offset, sessionId || undefined))
    } catch (error) {
      logger.error('Failed to list extractions', error)
      res.status(500).json({ error: 'Failed to list extractions' })
    }
  })

  router.get('/api/extractions/in-progress', (_req, res) => {
    try {
      res.json({ inProgress: listInProgressExtractions() })
    } catch (error) {
      logger.error('Failed to check in-progress extractions', error)
      res.json({ inProgress: [] })
    }
  })

  router.get('/api/extractions/warnings', (req, res) => {
    try {
      const requestConfig = getRequestConfig(req, baseConfig)
      const runs = listExtractionRuns(requestConfig.lancedb.table)
      const inProgress = listInProgressExtractions()
      res.json({
        collection: requestConfig.lancedb.table,
        ...buildExtractionWarnings(runs, inProgress.length, Date.now())
      })
    } catch (error) {
      logger.error('Failed to build extraction warnings', error)
      res.status(500).json({ error: 'Failed to build extraction warnings' })
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
      }, config, { flush: 'always', plannedRunId: run.runId })

      const stages = formatStageTimings(result.timings)
      if (stages) {
        logger.info(`Re-extraction timings runId=${run.runId} ${stages}`)
      }
      for (const diagnostic of result.diagnostics ?? []) {
        if (diagnostic.level === 'warn') {
          const records = typeof diagnostic.records === 'number' ? ` records=${diagnostic.records}` : ''
          logger.warn(`Re-extraction diagnostic runId=${run.runId} stage=${diagnostic.stage}${records} cause=${diagnostic.cause}`)
        }
      }

      // Update the existing extraction run with new results
      const recordOutcomes = result.recordOutcomes ?? []
      const insertedIds = Array.from(new Set(result.insertedIds ?? []))
      const updatedIds = Array.from(new Set(result.updatedIds ?? []))
      const allIds = Array.from(new Set([...insertedIds, ...updatedIds]))
      const persistedRecordCount = allIds.length
      const skippedRecordCount = recordOutcomes.filter(outcome => outcome.outcome === 'skipped').length
      const failedRecordCount = recordOutcomes.filter(outcome => outcome.outcome === 'failed').length
      const extractionError = sanitizeExtractionFailure(result.extractionError)
      const trueFailure = isTrueExtractionFailure(extractionError, persistedRecordCount)
      const extractedRecords = buildExtractionRecordSummaries(result.records, recordOutcomes)

      saveExtractionRun({
        ...run,
        isReExtract: true,
        timestamp: Date.now(),
        recordCount: persistedRecordCount,
        parseErrorCount: result.transcript?.parseErrors ?? 0,
        skippedRecordCount,
        failedRecordCount,
        extractedRecordIds: insertedIds,
        updatedRecordIds: updatedIds.length > 0 ? updatedIds : undefined,
        extractedRecords: extractedRecords.length > 0 ? extractedRecords : undefined,
        duration: sumStageTimings(result.timings),
        firstPrompt: result.transcript ? getFirstUserPrompt(result.transcript) : run.firstPrompt,
        tokenUsage: result.tokenUsage,
        extractedEventCount: trueFailure ? undefined : result.extractedEventCount,
        hasRememberMarker: result.hasRememberMarker,
        skipReason: extractionError ? undefined
          : result.reason === 'too_short' ? 'too_short'
          : (result.reason === 'no_records' && persistedRecordCount === 0) ? 'no_records'
          : undefined,
        error: extractionError
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
