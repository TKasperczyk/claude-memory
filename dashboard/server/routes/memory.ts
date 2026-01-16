import express from 'express'
import {
  countRecords,
  deleteRecord,
  escapeFilterValue,
  getRecord,
  hybridSearch,
  iterateRecords,
  queryRecords,
  resetCollection,
  buildKeywordFilter
} from '../../../src/lib/milvus.js'
import type { RecordType } from '../../../shared/types.js'
import type { ServerContext } from '../context.js'
import { parseNonNegativeInt } from '../utils/params.js'

export function createMemoryRouter(context: ServerContext): express.Router {
  const router = express.Router()
  const { config, ensureInitialized, memoryTypes } = context

  router.get('/api/memory-types', (_req, res) => {
    res.json({ types: memoryTypes })
  })

  router.get('/api/stats', async (_req, res) => {
    try {
      await ensureInitialized()
      const total = await countRecords({}, config)
      const stats = {
        total,
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

      for await (const record of iterateRecords({}, config)) {
        stats.byType[record.type] = (stats.byType[record.type] ?? 0) + 1

        const project = record.project ?? 'unknown'
        stats.byProject[project] = (stats.byProject[project] ?? 0) + 1

        const domain = record.domain ?? 'unknown'
        stats.byDomain[domain] = (stats.byDomain[domain] ?? 0) + 1

        if (record.deprecated) stats.deprecated++

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

  router.get('/api/memories', async (req, res) => {
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
      console.error('List memories error:', error)
      res.status(500).json({ error: 'Failed to list memories' })
    }
  })

  router.get('/api/memories/:id', async (req, res) => {
    try {
      await ensureInitialized()
      const record = await getRecord(req.params.id, config)
      if (!record) {
        return res.status(404).json({ error: 'Memory not found' })
      }
      res.json(record)
    } catch (error) {
      console.error('Get memory error:', error)
      res.status(500).json({ error: 'Failed to get memory' })
    }
  })

  router.delete('/api/memories/:id', async (req, res) => {
    try {
      await ensureInitialized()
      const record = await getRecord(req.params.id, config)
      if (!record) {
        return res.status(404).json({ error: 'Memory not found' })
      }
      await deleteRecord(req.params.id, config)
      res.json({ success: true })
    } catch (error) {
      console.error('Delete memory error:', error)
      res.status(500).json({ error: 'Failed to delete memory' })
    }
  })

  router.post('/api/reset-collection', async (_req, res) => {
    try {
      await ensureInitialized()
      await resetCollection(config)
      res.json({ success: true })
    } catch (error) {
      console.error('Reset collection error:', error)
      res.status(500).json({ error: 'Failed to reset collection' })
    }
  })

  router.get('/api/search', async (req, res) => {
    try {
      await ensureInitialized()

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

      const baseFilter = buildSearchFilter({ type, project, deprecated })
      const keywordFilter = buildKeywordFilter(query, baseFilter)
      const windowLimit = offset + limit

      const [total, results] = await Promise.all([
        countRecords({ filter: keywordFilter }, config),
        hybridSearch({
          query,
          limit: windowLimit,
          type,
          project,
          excludeDeprecated: !deprecated
        }, config)
      ])

      const page = results.slice(offset, offset + limit)
      const hasMore = results.length > offset + limit || total > offset + limit

      res.json({
        query,
        total: Math.max(total, results.length),
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
      console.error('Search error:', error)
      res.status(500).json({ error: 'Failed to search' })
    }
  })

  return router
}

function buildSearchFilter(filters: { type?: RecordType; project?: string; deprecated?: boolean }): string | undefined {
  const parts: string[] = []
  if (filters.type) parts.push(`type == "${escapeFilterValue(filters.type)}"`)
  if (filters.project) parts.push(`project == "${escapeFilterValue(filters.project)}"`)
  if (!filters.deprecated) parts.push('deprecated == false')
  return parts.length > 0 ? parts.join(' && ') : undefined
}
