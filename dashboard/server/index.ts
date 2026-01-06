/**
 * Dashboard API server - queries Milvus and serves data to frontend.
 * Run with: pnpm run server
 */

import express from 'express'
import cors from 'cors'
import {
  initMilvus,
  queryRecords,
  hybridSearch,
  getRecord,
  deleteRecord,
  resetCollection,
  countRecords,
  escapeFilterValue,
  getRecordStats
} from '../../src/lib/milvus.js'
import { dedupeInjectedMemories, listAllSessions, loadSessionTracking } from '../../src/lib/session-tracking.js'
import { findGitRoot } from '../../src/lib/context.js'
import { handlePrePrompt } from '../../src/hooks/pre-prompt.js'
import { loadConfig } from '../../src/lib/config.js'
import { type MemoryRecord, type RecordType } from '../../src/lib/types.js'
import { getExtractionRun, listExtractionRuns } from '../../src/lib/extraction-log.js'
import { reviewExtraction } from '../../src/lib/extraction-review.js'
import { reviewInjection } from '../../src/lib/injection-review.js'
import { getInjectionReview, getReview, saveInjectionReview, saveReview } from '../../src/lib/review-storage.js'
import {
  MAINTENANCE_OPERATIONS,
  MAINTENANCE_OPERATION_DEFINITIONS,
  runAllMaintenance,
  runMaintenanceOperation,
  type MaintenanceOperation
} from '../../src/lib/maintenance-api.js'

const app = express()
const PORT = process.env.PORT ?? 3001
const CONFIG_ROOT = findGitRoot(process.cwd()) ?? process.cwd()
const CONFIG = loadConfig(CONFIG_ROOT)

app.use(cors({ origin: ['http://localhost:5173', 'http://127.0.0.1:5173'] }))
app.use(express.json())

// Initialize Milvus on startup
let initialized = false

async function ensureInitialized(): Promise<void> {
  if (!initialized) {
    await initMilvus(CONFIG)
    initialized = true
  }
}

function parseNonNegativeInt(value: unknown, fallback: number): number {
  const raw = Array.isArray(value) ? value[0] : value
  if (raw === undefined || raw === null) return fallback
  const parsed = typeof raw === 'string' && raw.trim() === '' ? Number.NaN : Number(raw)
  if (!Number.isInteger(parsed) || parsed < 0) return fallback
  return parsed
}

// Get aggregate stats
app.get('/api/stats', async (_req, res) => {
  try {
    await ensureInitialized()
    // Use orderBy to trigger iterator path which handles >16384 records
    const records = await queryRecords({ limit: 100000, orderBy: 'timestamp_desc' }, CONFIG)

    const stats = {
      total: records.length,
      byType: {} as Record<string, number>,
      byProject: {} as Record<string, number>,
      byDomain: {} as Record<string, number>,
      avgRetrievalCount: 0,
      avgUsageCount: 0,
      avgUsageRatio: 0,
      deprecated: 0
    }

    let totalRetrieval = 0
    let totalUsage = 0
    let recordsWithRetrieval = 0

    for (const record of records) {
      // By type
      stats.byType[record.type] = (stats.byType[record.type] ?? 0) + 1

      // By project
      const project = record.project ?? 'unknown'
      stats.byProject[project] = (stats.byProject[project] ?? 0) + 1

      // By domain
      const domain = record.domain ?? 'unknown'
      stats.byDomain[domain] = (stats.byDomain[domain] ?? 0) + 1

      // Deprecated
      if (record.deprecated) stats.deprecated++

      // Usage stats
      const retrieval = record.retrievalCount ?? 0
      const usage = record.usageCount ?? 0
      if (retrieval > 0) {
        recordsWithRetrieval++
        totalRetrieval += retrieval
        totalUsage += usage
      }
    }

    if (recordsWithRetrieval > 0) {
      stats.avgRetrievalCount = totalRetrieval / recordsWithRetrieval
      stats.avgUsageCount = totalUsage / recordsWithRetrieval
      stats.avgUsageRatio = totalUsage / totalRetrieval
    }

    res.json(stats)
  } catch (error) {
    console.error('Stats error:', error)
    res.status(500).json({ error: 'Failed to get stats' })
  }
})

// List memories with filtering
app.get('/api/memories', async (req, res) => {
  try {
    await ensureInitialized()

    const limit = Math.min(parseNonNegativeInt(req.query.limit, 100), 1000)
    const offset = parseNonNegativeInt(req.query.offset, 0)
    const type = req.query.type as RecordType | undefined
    const project = req.query.project as string | undefined
    const deprecated = req.query.deprecated === 'true'

    const filterParts: string[] = []
    if (type) filterParts.push(`type == "${escapeFilterValue(type)}"`)
    if (project) filterParts.push(`project == "${escapeFilterValue(project)}"`)
    if (!deprecated) filterParts.push('deprecated == false')

    const filter = filterParts.length > 0 ? filterParts.join(' && ') : undefined

    const [records, total] = await Promise.all([
      queryRecords({ filter, limit, offset, orderBy: 'timestamp_desc' }, CONFIG),
      countRecords({ filter }, CONFIG)
    ])

    res.json({
      records,
      count: records.length,
      total,
      offset,
      limit
    })
  } catch (error) {
    console.error('List memories error:', error)
    res.status(500).json({ error: 'Failed to list memories' })
  }
})

// Get single memory by ID
app.get('/api/memories/:id', async (req, res) => {
  try {
    await ensureInitialized()
    const record = await getRecord(req.params.id, CONFIG)
    if (!record) {
      return res.status(404).json({ error: 'Memory not found' })
    }
    res.json(record)
  } catch (error) {
    console.error('Get memory error:', error)
    res.status(500).json({ error: 'Failed to get memory' })
  }
})

// Delete memory by ID
app.delete('/api/memories/:id', async (req, res) => {
  try {
    await ensureInitialized()
    const record = await getRecord(req.params.id, CONFIG)
    if (!record) {
      return res.status(404).json({ error: 'Memory not found' })
    }
    await deleteRecord(req.params.id, CONFIG)
    res.json({ success: true })
  } catch (error) {
    console.error('Delete memory error:', error)
    res.status(500).json({ error: 'Failed to delete memory' })
  }
})

// Reset Milvus collection (drop + recreate)
app.post('/api/reset-collection', async (_req, res) => {
  try {
    await ensureInitialized()
    await resetCollection(CONFIG)
    res.json({ success: true })
  } catch (error) {
    console.error('Reset collection error:', error)
    res.status(500).json({ error: 'Failed to reset collection' })
  }
})

// Preview context injection for a prompt (uses same logic as pre-prompt hook)
app.post('/api/preview', async (req, res) => {
  try {
    const { prompt, cwd = '/tmp' } = req.body
    if (!prompt) {
      return res.status(400).json({ error: 'Prompt required' })
    }

    // Use the same handlePrePrompt function as the actual hook
    const result = await handlePrePrompt({
      hook_event_name: 'UserPromptSubmit',
      prompt,
      cwd,
      session_id: 'preview'
    }, CONFIG)

    res.json({
      signals: result.signals,
      results: result.results.map(r => ({
        record: r.record,
        score: r.score,
        similarity: r.similarity,
        keywordMatch: r.keywordMatch
      })),
      injectedRecords: result.injectedRecords,
      context: result.context,
      timedOut: result.timedOut
    })
  } catch (error) {
    console.error('Preview error:', error)
    res.status(500).json({ error: 'Failed to preview context' })
  }
})

// Search memories
app.get('/api/search', async (req, res) => {
  try {
    await ensureInitialized()

    const query = req.query.q as string
    if (!query) {
      return res.status(400).json({ error: 'Query required' })
    }

    const limit = Math.min(parseNonNegativeInt(req.query.limit, 20), 100)
    const type = req.query.type as RecordType | undefined
    const project = req.query.project as string | undefined
    const deprecated = req.query.deprecated === 'true'

    const results = await hybridSearch({
      query,
      limit,
      type,
      project,
      excludeDeprecated: !deprecated
    }, CONFIG)

    res.json({
      query,
      total: results.length,
      results: results.map(r => ({
        record: r.record,
        score: r.score,
        similarity: r.similarity,
        keywordMatch: r.keywordMatch
      }))
    })
  } catch (error) {
    console.error('Search error:', error)
    res.status(500).json({ error: 'Failed to search' })
  }
})

// List active sessions with their injected memories and stats
app.get('/api/sessions', async (_req, res) => {
  try {
    await ensureInitialized()
    const sessions = listAllSessions().map(session => ({
      ...session,
      memories: dedupeInjectedMemories(session.memories)
    }))

    // Collect all memory IDs to fetch stats
    const allIds = sessions.flatMap(s => s.memories.map(m => m.id))
    const statsMap = await getRecordStats(allIds)

    // Enrich memories with stats
    const enrichedSessions = sessions.map(session => ({
      ...session,
      memories: session.memories.map(memory => ({
        ...memory,
        stats: statsMap.get(memory.id) ?? null
      }))
    }))

    res.json({
      sessions: enrichedSessions,
      count: sessions.length
    })
  } catch (error) {
    console.error('Sessions error:', error)
    res.status(500).json({ error: 'Failed to list sessions' })
  }
})

// Get cached injection review if available
app.get('/api/sessions/:sessionId/review', (req, res) => {
  try {
    const review = getInjectionReview(req.params.sessionId)
    if (!review) {
      return res.status(404).json({ error: 'Review not found' })
    }
    res.json(review)
  } catch (error) {
    console.error('Injection review error:', error)
    res.status(500).json({ error: 'Failed to get injection review' })
  }
})

// Trigger Opus review for a session injection
app.post('/api/sessions/:sessionId/review', async (req, res) => {
  try {
    const sessionId = req.params.sessionId
    const session = loadSessionTracking(sessionId)
    if (!session) {
      return res.status(404).json({ error: 'Session not found' })
    }

    await ensureInitialized()
    const review = await reviewInjection(sessionId, CONFIG)
    saveInjectionReview(review)
    res.json(review)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('Injection review error:', error)
    res.status(500).json({ error: message || 'Failed to run injection review' })
  }
})

// List extraction runs with pagination
app.get('/api/extractions', (req, res) => {
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

// Get single extraction run with associated records
app.get('/api/extractions/:runId', async (req, res) => {
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
      }, CONFIG)
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

// Get cached extraction review if available
app.get('/api/extractions/:runId/review', (req, res) => {
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

// Trigger Opus review for an extraction run
app.post('/api/extractions/:runId/review', async (req, res) => {
  try {
    const runId = req.params.runId
    const run = getExtractionRun(runId)
    if (!run) {
      return res.status(404).json({ error: 'Extraction run not found' })
    }

    await ensureInitialized()
    const review = await reviewExtraction(runId, CONFIG)
    saveReview(review)
    res.json(review)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('Extraction review error:', error)
    res.status(500).json({ error: message || 'Failed to run extraction review' })
  }
})

// List maintenance operations for the dashboard
app.get('/api/maintenance/operations', (_req, res) => {
  res.json({ operations: MAINTENANCE_OPERATION_DEFINITIONS })
})

// Run a single maintenance operation
app.post('/api/maintenance/run', async (req, res) => {
  try {
    await ensureInitialized()
    const { operation, dryRun } = req.body ?? {}
    if (!operation || typeof operation !== 'string') {
      return res.status(400).json({ error: 'Operation required' })
    }

    if (!MAINTENANCE_OPERATIONS.includes(operation as MaintenanceOperation)) {
      return res.status(400).json({ error: 'Unknown operation' })
    }

    const result = await runMaintenanceOperation(
      operation as MaintenanceOperation,
      Boolean(dryRun),
      CONFIG
    )
    res.json(result)
  } catch (error) {
    console.error('Maintenance run error:', error)
    res.status(500).json({ error: 'Failed to run maintenance operation' })
  }
})

// Run all maintenance operations
app.post('/api/maintenance/run-all', async (req, res) => {
  try {
    await ensureInitialized()
    const { dryRun } = req.body ?? {}
    const results = await runAllMaintenance(Boolean(dryRun), CONFIG)
    res.json(results)
  } catch (error) {
    console.error('Maintenance run-all error:', error)
    res.status(500).json({ error: 'Failed to run maintenance operations' })
  }
})

// Stream all maintenance operations with progress updates (SSE)
app.get('/api/maintenance/stream', async (req, res) => {
  const dryRun = req.query.dryRun === 'true'

  // Set up SSE headers
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const sendEvent = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`)
    res.write(`data: ${JSON.stringify(data)}\n\n`)
  }

  try {
    await ensureInitialized()

    // Send start event with operation list
    sendEvent('start', {
      operations: MAINTENANCE_OPERATIONS,
      dryRun
    })

    // Run each operation and stream progress
    for (const operation of MAINTENANCE_OPERATIONS) {
      sendEvent('progress', { operation, status: 'running' })

      try {
        const effectiveDryRun = operation === 'promotion-suggestions' ? true : dryRun
        const result = await runMaintenanceOperation(operation, effectiveDryRun, CONFIG)
        sendEvent('result', result)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        sendEvent('error', { operation, error: message })
      }
    }

    sendEvent('complete', { success: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    sendEvent('error', { error: message })
  } finally {
    res.end()
  }
})

app.listen(PORT, () => {
  console.error(`Dashboard API server running on http://localhost:${PORT}`)
})
