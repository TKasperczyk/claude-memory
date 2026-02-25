import express from 'express'
import { deleteExtractionRun, getExtractionRun, listExtractionRuns } from '../../../src/lib/extraction-log.js'
import { reviewExtraction, reviewExtractionStreaming } from '../../../src/lib/extraction-review.js'
import { deleteRecord, fetchRecordsByIds } from '../../../src/lib/lancedb.js'
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

  return router
}
