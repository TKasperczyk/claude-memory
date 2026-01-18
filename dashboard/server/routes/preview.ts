import express from 'express'
import { mergeNearMisses } from '../../../src/lib/diagnostics.js'
import { retrieveContext } from '../../../src/lib/retrieval.js'
import { coerceRetrievalSettings, loadSettings } from '../../../src/lib/settings.js'
import type { NearMissRecord } from '../../../shared/types.js'
import type { ServerContext } from '../context.js'
import { isPlainObject, parseOptionalBoolean } from '../utils/params.js'

export function createPreviewRouter(context: ServerContext): express.Router {
  const router = express.Router()
  const { config } = context

  router.post('/api/preview', async (req, res) => {
    try {
      const { prompt, cwd = '/tmp', settings: rawSettingsOverride } = req.body
      if (!prompt) {
        return res.status(400).json({ error: 'Prompt required' })
      }

      const diagnostic = parseOptionalBoolean(req.query.diagnostic ?? req.body?.diagnostic)
      const settingsOverride = isPlainObject(rawSettingsOverride)
        ? coerceRetrievalSettings(rawSettingsOverride as Record<string, unknown>, loadSettings())
        : undefined

      const result = await retrieveContext({ prompt, cwd }, config, { settingsOverride, diagnostic })

      const scoredResults = result.results.map(r => ({
        record: r.record,
        score: r.score,
        similarity: r.similarity,
        keywordMatch: r.keywordMatch
      }))

      const diagnosticPayload = diagnostic && result.diagnostics
        ? {
            injected: result.diagnostics.context.injectedRecords.map(r => ({
              record: r.record,
              score: r.score,
              similarity: r.similarity,
              keywordMatch: r.keywordMatch
            })),
            nearMisses: combineNearMisses(
              result.diagnostics.search.nearMisses,
              result.diagnostics.context.exclusions
            )
          }
        : undefined

      res.json({
        signals: result.signals,
        results: scoredResults,
        injectedRecords: result.injectedRecords,
        context: result.context ?? null,
        timedOut: result.timedOut,
        ...diagnosticPayload
      })
    } catch (error) {
      console.error('Preview error:', error)
      res.status(500).json({ error: 'Failed to preview context' })
    }
  })

  return router
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
