import express from 'express'
import { randomUUID } from 'crypto'
import {
  countRecords,
  deleteRecord,
  escapeFilterValue,
  getRecord,
  hybridSearch,
  insertRecord,
  queryRecords,
  resetCollection
} from '../../../src/lib/lancedb.js'
import { buildMemoryStats } from '../../../src/lib/memory-stats.js'
import { getRetrievalActivity } from '../../../src/lib/retrieval-events.js'
import { getTokenUsageActivity, backfillFromExtractionRuns } from '../../../src/lib/token-usage-events.js'
import { getStatsHistory } from '../../../src/lib/stats-snapshots.js'
import type { TimeBucketPeriod } from '../../../src/lib/time-buckets.js'
import { EMBEDDING_DIM } from '../../../src/lib/types.js'
import {
  asBoolean,
  asConfidence,
  asNumber,
  asOutcome,
  asScope,
  asSeverity,
  asStringArray,
  asTrimmedString
} from '../../../src/lib/parsing.js'
import type { MemoryRecord, RecordType, TokenUsageSource } from '../../../shared/types.js'
import type { ServerContext } from '../context.js'
import { createLogger } from '../lib/logger.js'
import { getRequestConfig } from '../utils/config.js'
import { isPlainObject, parseNonNegativeInt } from '../utils/params.js'
import { ensureConfigInitialized } from '../utils/lancedb.js'

const logger = createLogger('memory')

export function createMemoryRouter(context: ServerContext): express.Router {
  const router = express.Router()
  const { config: baseConfig, memoryTypes } = context

  router.get('/api/memory-types', (_req, res) => {
    res.json({ types: memoryTypes })
  })

  router.get('/api/stats', async (req, res) => {
    try {
      const config = await ensureConfigInitialized(req, baseConfig)
      const stats = await buildMemoryStats(config)
      res.json(stats)
    } catch (error) {
      logger.error('Failed to get stats', error)
      res.status(500).json({ error: 'Failed to get stats' })
    }
  })

  router.get('/api/retrieval-activity', (req, res) => {
    try {
      const period = parsePeriod(req.query.period, 'day')
      const limit = parseNonNegativeInt(req.query.limit, period === 'week' ? 12 : 30)
      const config = getRequestConfig(req, baseConfig)

      const activity = getRetrievalActivity(period, {
        limit,
        collection: config.lancedb.table
      })

      res.json(activity)
    } catch (error) {
      logger.error('Failed to get retrieval activity', error)
      res.status(500).json({ error: 'Failed to get retrieval activity' })
    }
  })

  router.get('/api/stats-history', async (req, res) => {
    try {
      const period = parsePeriod(req.query.period, 'day')
      const limit = parseNonNegativeInt(req.query.limit, period === 'week' ? 12 : 30)
      const requestConfig = getRequestConfig(req, baseConfig)

      const history = getStatsHistory(period, {
        limit,
        collection: requestConfig.lancedb.table
      })

      res.json(history)
    } catch (error) {
      logger.error('Failed to get stats history', error)
      res.status(500).json({ error: 'Failed to get stats history' })
    }
  })

  router.get('/api/token-usage', (req, res) => {
    try {
      const period = parsePeriod(req.query.period, 'day')
      const limit = parseNonNegativeInt(req.query.limit, period === 'week' ? 12 : 30)
      const source = parseTokenUsageSource(req.query.source, 'all')
      const config = getRequestConfig(req, baseConfig)

      const activity = getTokenUsageActivity(period, {
        limit,
        source,
        collection: config.lancedb.table
      })

      res.json(activity)
    } catch (error) {
      logger.error('Failed to get token usage activity', error)
      res.status(500).json({ error: 'Failed to get token usage activity' })
    }
  })

  router.post('/api/token-usage/backfill', (req, res) => {
    try {
      const config = getRequestConfig(req, baseConfig)
      const count = backfillFromExtractionRuns(config.lancedb.table)
      res.json({ backfilledEvents: count })
    } catch (error) {
      logger.error('Failed to backfill token usage', error)
      res.status(500).json({ error: 'Failed to backfill token usage' })
    }
  })

  router.get('/api/memories', async (req, res) => {
    try {
      const config = await ensureConfigInitialized(req, baseConfig)

      const limit = Math.min(parseNonNegativeInt(req.query.limit, 100), 1000)
      const offset = parseNonNegativeInt(req.query.offset, 0)
      const type = req.query.type as RecordType | undefined
      const project = req.query.project as string | undefined
      const deprecated = req.query.deprecated === 'true'

      const filterParts: string[] = []
      if (type) filterParts.push(`type = '${escapeFilterValue(type)}'`)
      if (project) filterParts.push(`project = '${escapeFilterValue(project)}'`)
      if (!deprecated) filterParts.push('deprecated = false')

      const filter = filterParts.length > 0 ? filterParts.join(' AND ') : undefined

      const [records, total] = await Promise.all([
        queryRecords({ filter, limit, offset, orderBy: 'timestamp_desc' }, config),
        countRecords({ filter }, config)
      ])

      res.json({
        records,
        count: records.length,
        total,
        offset,
        limit
      })
    } catch (error) {
      logger.error('Failed to list memories', error)
      res.status(500).json({ error: 'Failed to list memories' })
    }
  })

  router.get('/api/memories/:id', async (req, res) => {
    try {
      const config = await ensureConfigInitialized(req, baseConfig)
      const record = await getRecord(req.params.id, config)
      if (!record) {
        return res.status(404).json({ error: 'Memory not found' })
      }
      res.json(record)
    } catch (error) {
      logger.error('Failed to get memory', error)
      res.status(500).json({ error: 'Failed to get memory' })
    }
  })

  router.delete('/api/memories/:id', async (req, res) => {
    try {
      const config = await ensureConfigInitialized(req, baseConfig)
      const record = await getRecord(req.params.id, config)
      if (!record) {
        return res.status(404).json({ error: 'Memory not found' })
      }
      await deleteRecord(req.params.id, config)
      res.json({ success: true })
    } catch (error) {
      logger.error('Failed to delete memory', error)
      res.status(500).json({ error: 'Failed to delete memory' })
    }
  })

  router.post('/api/reset-collection', async (req, res) => {
    try {
      const config = await ensureConfigInitialized(req, baseConfig)
      await resetCollection(config)
      res.json({ success: true })
    } catch (error) {
      logger.error('Failed to reset collection', error)
      res.status(500).json({ error: 'Failed to reset collection' })
    }
  })

  /**
   * POST /api/memories - Insert a new memory record.
   * Used by evaluation frameworks to programmatically add memories.
   *
   * Supports X-LanceDB-Table header for table isolation.
   */
  router.post('/api/memories', async (req, res) => {
    try {
      const config = await ensureConfigInitialized(req, baseConfig)
      const body = req.body

      if (!isPlainObject(body)) {
        return res.status(400).json({ error: 'Invalid payload' })
      }

      // Validate required fields based on type
      const type = body.type as RecordType
      if (!type || !memoryTypes.includes(type)) {
        return res.status(400).json({
          error: `Invalid or missing type. Must be one of: ${memoryTypes.join(', ')}`
        })
      }

      const sourceExcerpt = asTrimmedString(body.sourceExcerpt)
      if (!sourceExcerpt) {
        return res.status(400).json({ error: 'sourceExcerpt required' })
      }

      const hasEmbedding = Object.prototype.hasOwnProperty.call(body, 'embedding')
      const embedding = hasEmbedding ? asNumberArray(body.embedding) : undefined
      if (hasEmbedding && !embedding) {
        return res.status(400).json({ error: 'embedding must be an array of numbers' })
      }
      if (embedding && embedding.length !== EMBEDDING_DIM) {
        return res.status(400).json({
          error: `embedding must be length ${EMBEDDING_DIM}`
        })
      }

      const hasScope = Object.prototype.hasOwnProperty.call(body, 'scope')
      const scope = hasScope ? asScope(body.scope) : undefined
      if (hasScope && !scope) {
        return res.status(400).json({ error: 'scope must be global or project' })
      }

      // Build the record with defaults
      const now = Date.now()
      const id = asTrimmedString(body.id) ?? randomUUID()
      const baseRecord = {
        id,
        timestamp: asNumber(body.timestamp) ?? now,
        scope,
        sourceSessionId: asTrimmedString(body.sourceSessionId),
        sourceExcerpt,
        project: asTrimmedString(body.project),
        successCount: asNumber(body.successCount) ?? undefined,
        failureCount: asNumber(body.failureCount) ?? undefined,
        retrievalCount: asNumber(body.retrievalCount) ?? undefined,
        usageCount: asNumber(body.usageCount) ?? undefined,
        lastUsed: asNumber(body.lastUsed) ?? undefined,
        deprecated: asBoolean(body.deprecated) ?? undefined,
        generalized: asBoolean(body.generalized) ?? undefined,
        lastGeneralizationCheck: asNumber(body.lastGeneralizationCheck) ?? undefined,
        lastGlobalCheck: asNumber(body.lastGlobalCheck) ?? undefined,
        lastConsolidationCheck: asNumber(body.lastConsolidationCheck) ?? undefined,
        lastConflictCheck: asNumber(body.lastConflictCheck) ?? undefined,
        lastWarningSynthesisCheck: asNumber(body.lastWarningSynthesisCheck) ?? undefined,
        embedding
      }

      // Type-specific fields
      let record: MemoryRecord
      switch (type) {
        case 'command': {
          const command = asTrimmedString(body.command)
          const exitCode = asNumber(body.exitCode)
          const outcome = asOutcome(body.outcome)
          const contextInput = isPlainObject(body.context) ? body.context : undefined
          const contextProject = asTrimmedString(contextInput?.project)
          const contextCwd = asTrimmedString(contextInput?.cwd)
          const contextIntent = asTrimmedString(contextInput?.intent)

          if (!command) {
            return res.status(400).json({ error: 'command required' })
          }
          if (exitCode === null) {
            return res.status(400).json({ error: 'exitCode required' })
          }
          if (!outcome) {
            return res.status(400).json({ error: 'outcome must be success, failure, or partial' })
          }
          if (!contextProject || !contextCwd || !contextIntent) {
            return res.status(400).json({ error: 'context.project, context.cwd, and context.intent required' })
          }

          record = {
            ...baseRecord,
            type: 'command',
            command,
            exitCode: Math.trunc(exitCode),
            outcome,
            context: {
              project: contextProject,
              cwd: contextCwd,
              intent: contextIntent
            }
          }
          const truncatedOutput = asTrimmedString(body.truncatedOutput)
          if (truncatedOutput) record.truncatedOutput = truncatedOutput
          const resolution = asTrimmedString(body.resolution)
          if (resolution) record.resolution = resolution
          break
        }
        case 'error': {
          const errorText = asTrimmedString(body.errorText)
          const errorType = asTrimmedString(body.errorType)
          const resolution = asTrimmedString(body.resolution)
          const contextInput = isPlainObject(body.context) ? body.context : undefined
          const contextProject = asTrimmedString(contextInput?.project)

          if (!errorText) {
            return res.status(400).json({ error: 'errorText required' })
          }
          if (!errorType) {
            return res.status(400).json({ error: 'errorType required' })
          }
          if (!resolution) {
            return res.status(400).json({ error: 'resolution required' })
          }
          if (!contextProject) {
            return res.status(400).json({ error: 'context.project required' })
          }

          record = {
            ...baseRecord,
            type: 'error',
            errorText,
            errorType,
            resolution,
            context: {
              project: contextProject
            }
          }
          const cause = asTrimmedString(body.cause)
          if (cause) record.cause = cause
          const file = asTrimmedString(contextInput?.file)
          if (file) record.context.file = file
          const tool = asTrimmedString(contextInput?.tool)
          if (tool) record.context.tool = tool
          break
        }
        case 'discovery': {
          const what = asTrimmedString(body.what)
          const where = asTrimmedString(body.where)
          const evidence = asTrimmedString(body.evidence)
          const confidence = asConfidence(body.confidence)

          if (!what) {
            return res.status(400).json({ error: 'what required' })
          }
          if (!where) {
            return res.status(400).json({ error: 'where required' })
          }
          if (!evidence) {
            return res.status(400).json({ error: 'evidence required' })
          }
          if (!confidence) {
            return res.status(400).json({ error: 'confidence must be verified, inferred, or tentative' })
          }

          record = {
            ...baseRecord,
            type: 'discovery',
            what,
            where,
            evidence,
            confidence
          }
          break
        }
        case 'procedure': {
          const name = asTrimmedString(body.name)
          const steps = asStringArray(body.steps)
          const contextInput = isPlainObject(body.context) ? body.context : undefined
          const contextProject = asTrimmedString(contextInput?.project) ?? asTrimmedString(body.project)

          if (!name) {
            return res.status(400).json({ error: 'name required' })
          }
          if (steps.length === 0 || !steps.some(step => step.trim().length > 0)) {
            return res.status(400).json({ error: 'steps required' })
          }

          record = {
            ...baseRecord,
            type: 'procedure',
            name,
            steps,
            context: {
              ...(contextProject ? { project: contextProject } : {})
            }
          }
          const prerequisites = asStringArray(body.prerequisites)
          if (prerequisites && prerequisites.length > 0) record.prerequisites = prerequisites
          const verification = asTrimmedString(body.verification)
          if (verification) record.verification = verification
          break
        }
        case 'warning': {
          const avoid = asTrimmedString(body.avoid)
          const useInstead = asTrimmedString(body.useInstead)
          const reason = asTrimmedString(body.reason)
          const severity = asSeverity(body.severity)

          if (!avoid) {
            return res.status(400).json({ error: 'avoid required' })
          }
          if (!useInstead) {
            return res.status(400).json({ error: 'useInstead required' })
          }
          if (!reason) {
            return res.status(400).json({ error: 'reason required' })
          }
          if (!severity) {
            return res.status(400).json({ error: 'severity must be caution, warning, or critical' })
          }

          record = {
            ...baseRecord,
            type: 'warning',
            avoid,
            useInstead,
            reason,
            severity
          }
          const sourceRecordIds = asStringArray(body.sourceRecordIds)
          if (sourceRecordIds && sourceRecordIds.length > 0) {
            record.sourceRecordIds = sourceRecordIds
          }
          const synthesizedAt = asNumber(body.synthesizedAt)
          if (synthesizedAt !== null) record.synthesizedAt = synthesizedAt
          break
        }
        default:
          return res.status(400).json({ error: `Unsupported type: ${type}` })
      }

      // Build and insert
      await insertRecord(record, config)

      res.status(201).json({ id: record.id, success: true })
    } catch (error) {
      logger.error('Failed to insert memory', error)
      res.status(500).json({ error: 'Failed to insert memory' })
    }
  })

  router.get('/api/search', async (req, res) => {
    try {
      const config = await ensureConfigInitialized(req, baseConfig)

      const rawQuery = req.query.q as string
      const query = rawQuery?.trim()
      if (!query) {
        return res.status(400).json({ error: 'Query required' })
      }

      const limit = Math.min(parseNonNegativeInt(req.query.limit, 20), 200)
      const offset = parseNonNegativeInt(req.query.offset, 0)
      const type = req.query.type as RecordType | undefined
      const project = req.query.project as string | undefined
      const deprecated = req.query.deprecated === 'true'

      const windowLimit = offset + limit + 1

      const results = await hybridSearch({
        query,
        limit: windowLimit,
        type,
        project,
        excludeDeprecated: !deprecated
      }, config)

      const page = results.slice(offset, offset + limit)
      const hasMore = results.length > offset + limit
      const total = offset + page.length + (hasMore ? 1 : 0)

      res.json({
        query,
        total,
        offset,
        hasMore,
        results: page.map(r => ({
          record: r.record,
          score: r.score,
          similarity: r.similarity,
          keywordMatch: r.keywordMatch
        }))
      })
    } catch (error) {
      logger.error('Failed to search', error)
      res.status(500).json({ error: 'Failed to search' })
    }
  })

  return router
}

function parsePeriod(value: unknown, fallback: TimeBucketPeriod): TimeBucketPeriod {
  const raw = Array.isArray(value) ? value[0] : value
  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase()
    if (normalized === 'day' || normalized === 'week') {
      return normalized
    }
  }
  return fallback
}

function parseTokenUsageSource(
  value: unknown,
  fallback: TokenUsageSource | 'all'
): TokenUsageSource | 'all' {
  const raw = Array.isArray(value) ? value[0] : value
  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase()
    if (
      normalized === 'all'
      || normalized === 'extraction'
      || normalized === 'haiku-query'
      || normalized === 'usefulness-rating'
    ) {
      return normalized
    }
  }
  return fallback
}

function asNumberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined
  if (!value.every(item => typeof item === 'number' && Number.isFinite(item))) return undefined
  return value
}
