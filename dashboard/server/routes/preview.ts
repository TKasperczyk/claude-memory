import express from 'express'
import { mergeNearMisses } from '../../../src/lib/diagnostics.js'
import { retrieveContext } from '../../../src/lib/retrieval.js'
import { coerceRetrievalSettings, loadSettings } from '../../../src/lib/settings.js'
import { stripRecordEmbedding, stripSearchResultEmbedding } from '../../../src/lib/shared.js'
import type { NearMissRecord } from '../../../shared/types.js'
import type { ServerContext } from '../context.js'
import { createLogger } from '../lib/logger.js'
import { resolveBaseConfig, validateCollectionHeaderMiddleware } from '../utils/config.js'
import { isPlainObject, parseOptionalBoolean } from '../utils/params.js'
import { ensureConfigInitialized } from '../utils/lancedb.js'

const logger = createLogger('preview')

export function createPreviewRouter(context: ServerContext): express.Router {
  const router = express.Router()
  router.use(validateCollectionHeaderMiddleware)
  const getBaseConfig = () => resolveBaseConfig(context)

  router.post('/api/preview', async (req, res) => {
    try {
      const body = isPlainObject(req.body) ? req.body as Record<string, unknown> : {}
      const rawPrompt = body.prompt
      if (typeof rawPrompt !== 'string' || rawPrompt.trim().length === 0) {
        return res.status(400).json({ error: 'Prompt required' })
      }
      const prompt = rawPrompt.trim()
      const cwd = typeof body.cwd === 'string' && body.cwd.trim().length > 0 ? body.cwd : '/tmp'
      const rawSettingsOverride = body.settings

      const config = await ensureConfigInitialized(req, getBaseConfig())

      const diagnostic = parseOptionalBoolean(req.query.diagnostic ?? body.diagnostic)
      const settingsOverride = isPlainObject(rawSettingsOverride)
        ? coerceRetrievalSettings(rawSettingsOverride as Record<string, unknown>, loadSettings())
        : undefined

      const result = await retrieveContext({ prompt, cwd, skipSuppressionWriteback: true }, config, { settingsOverride, diagnostic })

      const scoredResults = result.results.map(stripSearchResultEmbedding)

      const diagnosticPayload = diagnostic && result.diagnostics
        ? {
            injected: result.diagnostics.context.injectedRecords.map(stripSearchResultEmbedding),
            nearMisses: combineNearMisses(
              result.diagnostics.search.nearMisses,
              result.diagnostics.context.exclusions
            ).map(stripNearMissEmbedding),
            queryInfo: result.diagnostics.search.queryInfo
          }
        : undefined

      res.json({
        signals: result.signals,
        results: scoredResults,
        injectedRecords: result.injectedRecords.map(stripRecordEmbedding),
        context: result.context ?? null,
        timedOut: result.timedOut,
        ...diagnosticPayload
      })
    } catch (error) {
      logger.error('Failed to preview context', error)
      res.status(500).json({ error: 'Failed to preview context' })
    }
  })

  return router
}

function stripNearMissEmbedding(nearMiss: NearMissRecord): NearMissRecord {
  return {
    ...nearMiss,
    record: stripSearchResultEmbedding(nearMiss.record)
  }
}

function combineNearMisses(...sources: Array<NearMissRecord[] | undefined>): NearMissRecord[] {
  const merged = new Map<string, NearMissRecord>()
  for (const entries of sources) {
    if (!entries) continue
    mergeNearMisses(merged, entries)
  }
  // Sort by similarity descending so most relevant near misses appear first
  return Array.from(merged.values()).sort((a, b) => b.record.similarity - a.record.similarity)
}
