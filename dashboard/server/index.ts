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
  countRecords,
  escapeFilterValue,
  getRecordStats
} from '../../src/lib/milvus.js'
import { listAllSessions } from '../../src/lib/session-tracking.js'
import { buildContext, extractSignals } from '../../src/lib/context.js'
import { embed } from '../../src/lib/embed.js'
import { DEFAULT_CONFIG, type MemoryRecord, type RecordType } from '../../src/lib/types.js'

const app = express()
const PORT = process.env.PORT ?? 3001

app.use(cors())
app.use(express.json())

// Initialize Milvus on startup
let initialized = false

async function ensureInitialized(): Promise<void> {
  if (!initialized) {
    await initMilvus(DEFAULT_CONFIG)
    initialized = true
  }
}

// Get aggregate stats
app.get('/api/stats', async (_req, res) => {
  try {
    await ensureInitialized()
    // Use orderBy to trigger iterator path which handles >16384 records
    const records = await queryRecords({ limit: 100000, orderBy: 'timestamp_desc' }, DEFAULT_CONFIG)

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

    const limit = Math.min(Number(req.query.limit) || 100, 1000)
    const offset = Number(req.query.offset) || 0
    const type = req.query.type as RecordType | undefined
    const project = req.query.project as string | undefined
    const deprecated = req.query.deprecated === 'true'

    const filterParts: string[] = []
    if (type) filterParts.push(`type == "${escapeFilterValue(type)}"`)
    if (project) filterParts.push(`project == "${escapeFilterValue(project)}"`)
    if (!deprecated) filterParts.push('deprecated == false')

    const filter = filterParts.length > 0 ? filterParts.join(' && ') : undefined

    const [records, total] = await Promise.all([
      queryRecords({ filter, limit, offset, orderBy: 'timestamp_desc' }, DEFAULT_CONFIG),
      countRecords({ filter }, DEFAULT_CONFIG)
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
    const record = await getRecord(req.params.id, DEFAULT_CONFIG)
    if (!record) {
      return res.status(404).json({ error: 'Memory not found' })
    }
    res.json(record)
  } catch (error) {
    console.error('Get memory error:', error)
    res.status(500).json({ error: 'Failed to get memory' })
  }
})

// Preview context injection for a prompt
app.post('/api/preview', async (req, res) => {
  try {
    await ensureInitialized()

    const { prompt, cwd = '/tmp' } = req.body
    if (!prompt) {
      return res.status(400).json({ error: 'Prompt required' })
    }

    const signals = extractSignals(prompt, cwd)

    const embedding = await embed(prompt, DEFAULT_CONFIG)
    const results = await hybridSearch({
      query: prompt,
      embedding,
      limit: DEFAULT_CONFIG.injection.maxRecords,
      project: signals.projectRoot,
      domain: signals.domain
    }, DEFAULT_CONFIG)

    const { context, records } = buildContext(
      results.map(r => r.record),
      DEFAULT_CONFIG
    )

    res.json({
      signals,
      results: results.map(r => ({
        record: r.record,
        score: r.score,
        similarity: r.similarity,
        keywordMatch: r.keywordMatch
      })),
      injectedRecords: records,
      context
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

    const limit = Math.min(Number(req.query.limit) || 20, 100)
    const type = req.query.type as RecordType | undefined
    const project = req.query.project as string | undefined
    const deprecated = req.query.deprecated === 'true'

    const results = await hybridSearch({
      query,
      limit,
      type,
      project,
      excludeDeprecated: !deprecated
    }, DEFAULT_CONFIG)

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
    const sessions = listAllSessions()

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

app.listen(PORT, () => {
  console.log(`Dashboard API server running on http://localhost:${PORT}`)
})
