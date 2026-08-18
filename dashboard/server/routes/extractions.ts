import express from 'express'
import { deleteExtractionRun, getExtractionRun, listExtractionRuns, listInProgressExtractions } from '../../../src/lib/extraction-log.js'
import { reviewExtraction, reviewExtractionStreaming } from '../../../src/lib/extraction-review.js'
import { deleteRecordsByIds } from '../../../src/lib/lancedb.js'
import { paginateExtractionRuns, loadExtractionRunDetail } from '../../../src/lib/extraction-query.js'
import { deleteReview, getReview, saveReview } from '../../../src/lib/review-storage.js'
import type { ServerContext } from '../context.js'
import { createLogger } from '../lib/logger.js'
import { createSseStream, sendSseError } from '../lib/sse.js'
import { buildExtractionWarnings } from '../lib/extraction-warnings.js'
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
      await deleteRecordsByIds([...insertedIds, ...updatedIds], config)

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

  return router
}
