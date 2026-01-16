import express from 'express'
import { getExtractionRun, listExtractionRuns } from '../../../src/lib/extraction-log.js'
import { reviewExtraction, reviewExtractionStreaming } from '../../../src/lib/extraction-review.js'
import { escapeFilterValue, queryRecords } from '../../../src/lib/milvus.js'
import { getReview, saveReview } from '../../../src/lib/review-storage.js'
import type { MemoryRecord } from '../../../shared/types.js'
import type { ServerContext } from '../context.js'
import { parseNonNegativeInt } from '../utils/params.js'

export function createExtractionsRouter(context: ServerContext): express.Router {
  const router = express.Router()
  const { config, ensureInitialized } = context

  router.get('/api/extractions', (req, res) => {
    try {
      const runs = listExtractionRuns()
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
      console.error('Extractions error:', error)
      res.status(500).json({ error: 'Failed to list extractions' })
    }
  })

  router.get('/api/extractions/:runId', async (req, res) => {
    try {
      const run = getExtractionRun(req.params.runId)
      if (!run) {
        return res.status(404).json({ error: 'Extraction run not found' })
      }

      const ids = run.extractedRecordIds ?? []
      if (ids.length === 0) {
        return res.json({ run, records: [] })
      }

      await ensureInitialized()

      const records: MemoryRecord[] = []
      const batchSize = 1000

      for (let i = 0; i < ids.length; i += batchSize) {
        const batchIds = ids.slice(i, i + batchSize)
        const idFilter = batchIds.map(id => `"${escapeFilterValue(id)}"`).join(', ')
        const batch = await queryRecords({
          filter: `id in [${idFilter}]`,
          limit: batchIds.length,
          orderBy: 'timestamp_desc'
        }, config)
        records.push(...batch)
      }

      const byId = new Map(records.map(record => [record.id, record]))
      const ordered = ids.map(id => byId.get(id)).filter((record): record is typeof records[number] => Boolean(record))

      res.json({ run, records: ordered })
    } catch (error) {
      console.error('Extraction run error:', error)
      res.status(500).json({ error: 'Failed to get extraction run' })
    }
  })

  router.get('/api/extractions/:runId/review', (req, res) => {
    try {
      const review = getReview(req.params.runId)
      if (!review) {
        return res.status(404).json({ error: 'Review not found' })
      }
      res.json(review)
    } catch (error) {
      console.error('Extraction review error:', error)
      res.status(500).json({ error: 'Failed to get extraction review' })
    }
  })

  router.post('/api/extractions/:runId/review', async (req, res) => {
    try {
      const runId = req.params.runId
      const run = getExtractionRun(runId)
      if (!run) {
        return res.status(404).json({ error: 'Extraction run not found' })
      }

      const wantsStream = req.query.stream === 'true'
      if (wantsStream) {
        res.setHeader('Content-Type', 'text/event-stream')
        res.setHeader('Cache-Control', 'no-cache')
        res.setHeader('Connection', 'keep-alive')
        res.flushHeaders()

        const abortController = new AbortController()
        req.on('close', () => {
          abortController.abort()
        })

        const send = (payload: unknown) => {
          if (abortController.signal.aborted || res.writableEnded) return
          res.write(`data: ${JSON.stringify(payload)}\n\n`)
        }
        const onThinking = (chunk: string) => {
          if (!chunk || abortController.signal.aborted || res.writableEnded) return
          send({ thinking: chunk })
        }

        try {
          await ensureInitialized()
          const review = await reviewExtractionStreaming(runId, config, onThinking, abortController.signal)
          saveReview(review)
          send({ result: review })
          if (!abortController.signal.aborted && !res.writableEnded) {
            res.write('data: [DONE]\n\n')
          }
        } catch (error) {
          if (abortController.signal.aborted) return
          const message = error instanceof Error ? error.message : String(error)
          console.error('Extraction review error:', error)
          send({ error: message || 'Failed to run extraction review' })
          if (!abortController.signal.aborted && !res.writableEnded) {
            res.write('data: [DONE]\n\n')
          }
        } finally {
          res.end()
        }
        return
      }

      await ensureInitialized()
      const review = await reviewExtraction(runId, config)
      saveReview(review)
      res.json(review)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('Extraction review error:', error)
      res.status(500).json({ error: message || 'Failed to run extraction review' })
    }
  })

  return router
}
