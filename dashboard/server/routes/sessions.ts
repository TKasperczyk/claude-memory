import express from 'express'
import { reviewInjection, reviewInjectionStreaming } from '../../../src/lib/injection-review.js'
import { getRecordStats } from '../../../src/lib/milvus.js'
import { getInjectionReview, saveInjectionReview } from '../../../src/lib/review-storage.js'
import { dedupeInjectedMemories, listAllSessions, loadSessionTracking } from '../../../src/lib/session-tracking.js'
import type { ServerContext } from '../context.js'
import { createLogger } from '../lib/logger.js'
import { ensureConfigInitialized } from '../utils/milvus.js'

const logger = createLogger('sessions')

export function createSessionsRouter(context: ServerContext): express.Router {
  const router = express.Router()
  const { config: baseConfig } = context

  router.get('/api/sessions', async (req, res) => {
    try {
      const config = await ensureConfigInitialized(req, baseConfig)
      const sessions = listAllSessions().map(session => ({
        ...session,
        memoriesRaw: session.memories,
        memories: dedupeInjectedMemories(session.memories)
      }))

      const allIds = sessions.flatMap(session => session.memories.map(memory => memory.id))
      const statsMap = await getRecordStats(allIds, config)

      const enrichedSessions = sessions.map(session => {
        const applyStats = (memory: typeof session.memories[number]) => ({
          ...memory,
          stats: statsMap.get(memory.id) ?? null
        })

        return {
          ...session,
          hasReview: Boolean(session.hasReview),
          memories: session.memories.map(applyStats),
          memoriesRaw: session.memoriesRaw.map(applyStats)
        }
      })

      res.json({
        sessions: enrichedSessions,
        count: sessions.length
      })
    } catch (error) {
      logger.error('Failed to list sessions', error)
      res.status(500).json({ error: 'Failed to list sessions' })
    }
  })

  router.get('/api/sessions/:sessionId/review', (req, res) => {
    try {
      const review = getInjectionReview(req.params.sessionId)
      if (!review) {
        return res.status(404).json({ error: 'Review not found' })
      }
      res.json(review)
    } catch (error) {
      logger.error('Injection review error', error)
      res.status(500).json({ error: 'Failed to get injection review' })
    }
  })

  router.post('/api/sessions/:sessionId/review', async (req, res) => {
    try {
      const sessionId = req.params.sessionId
      const session = loadSessionTracking(sessionId)
      if (!session) {
        return res.status(404).json({ error: 'Session not found' })
      }

      const wantsStream = req.query.stream === 'true'
      if (wantsStream) {
        res.setHeader('Content-Type', 'text/event-stream')
        res.setHeader('Cache-Control', 'no-cache')
        res.setHeader('Connection', 'keep-alive')
        res.flushHeaders()

        const abortController = new AbortController()
        res.on('close', () => {
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
          const config = await ensureConfigInitialized(req, baseConfig)
          const review = await reviewInjectionStreaming(sessionId, config, onThinking, abortController.signal)
          saveInjectionReview(review)
          send({ result: review })
          if (!abortController.signal.aborted && !res.writableEnded) {
            res.write('data: [DONE]\n\n')
          }
        } catch (error) {
          if (abortController.signal.aborted) return
          const message = error instanceof Error ? error.message : String(error)
          logger.error('Injection review error', error)
          send({ error: message || 'Failed to run injection review' })
          if (!abortController.signal.aborted && !res.writableEnded) {
            res.write('data: [DONE]\n\n')
          }
        } finally {
          res.end()
        }
        return
      }

      const config = await ensureConfigInitialized(req, baseConfig)
      const review = await reviewInjection(sessionId, config)
      saveInjectionReview(review)
      res.json(review)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error('Injection review error', error)
      res.status(500).json({ error: message || 'Failed to run injection review' })
    }
  })

  return router
}
