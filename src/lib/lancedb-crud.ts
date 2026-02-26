import fs from 'fs'
import path from 'path'
import { homedir } from 'os'
import { escapeFilterValue } from './shared.js'
import { DEFAULT_CONFIG, type Config, type MemoryRecord } from './types.js'
import { OUTPUT_FIELDS } from './lancedb-schema.js'
import { ensureClient, closeLanceDB, initLanceDB, resolveDirectory } from './lancedb-client.js'
import { getCollectionKey } from './file-store.js'
import {
  buildLanceRow,
  mergeRecords,
  needsEmbeddingRefresh,
  parseRecordFromRow,
  type LanceRow
} from './lancedb-records.js'
import type { MemoryStats } from '../../shared/types.js'

export type FlushMode = 'never' | 'end-of-batch' | 'always'
export interface WriteOptions {
  flush?: FlushMode
}

const QUERY_PAGE_SIZE = 1000

export async function insertRecord(
  record: MemoryRecord,
  config: Config = DEFAULT_CONFIG,
  _options: WriteOptions = {}
): Promise<void> {
  try {
    const { table } = await ensureClient(config)
    const row = await buildLanceRow(record, config)
    await table.add([row])
  } catch (error) {
    console.error('[claude-memory] insertRecord failed:', error)
    throw error
  }
}

export async function updateRecord(
  id: string,
  updates: Partial<MemoryRecord>,
  config: Config = DEFAULT_CONFIG,
  _options: WriteOptions = {}
): Promise<boolean> {
  try {
    const { table } = await ensureClient(config)

    // NOTE: Read-modify-write can drop increments under concurrency; acceptable for ranking hints.
    const existing = await getRecordById(table, id, { includeEmbedding: true })
    if (!existing) return false

    const merged = mergeRecords(existing, updates)
    merged.id = id

    const shouldReembed = needsEmbeddingRefresh(existing, merged)
    if (shouldReembed && updates.timestamp === undefined) {
      merged.timestamp = Date.now()
    }

    const embedding = updates.embedding
      ?? (shouldReembed ? undefined : existing.embedding)

    const row = await buildLanceRow({ ...merged, embedding }, config)

    await table
      .mergeInsert('id')
      .whenMatchedUpdateAll()
      .whenNotMatchedInsertAll()
      .execute([row])

    return true
  } catch (error) {
    console.error('[claude-memory] updateRecord failed:', error)
    throw error
  }
}

export async function incrementRecordCounters(
  id: string,
  deltas: { retrievalCount?: number; usageCount?: number },
  config: Config = DEFAULT_CONFIG
): Promise<boolean> {
  try {
    const { table } = await ensureClient(config)

    // NOTE: Read-modify-write can drop increments under concurrency; acceptable for ranking hints.
    const existing = await getRecordById(table, id, { includeEmbedding: true })
    if (!existing) return false

    const updates: Partial<MemoryRecord> = {}
    if (typeof deltas.retrievalCount === 'number' && deltas.retrievalCount !== 0) {
      updates.retrievalCount = (existing.retrievalCount ?? 0) + deltas.retrievalCount
    }
    if (typeof deltas.usageCount === 'number' && deltas.usageCount !== 0) {
      updates.usageCount = (existing.usageCount ?? 0) + deltas.usageCount
    }

    if (Object.keys(updates).length === 0) return true
    updates.lastUsed = Date.now()

    const merged = mergeRecords(existing, updates)
    merged.id = id

    const shouldReembed = needsEmbeddingRefresh(existing, merged)
    if (shouldReembed && updates.timestamp === undefined) {
      merged.timestamp = Date.now()
    }

    const embedding = updates.embedding
      ?? (shouldReembed ? undefined : existing.embedding)

    const row = await buildLanceRow({ ...merged, embedding }, config)

    await table
      .mergeInsert('id')
      .whenMatchedUpdateAll()
      .whenNotMatchedInsertAll()
      .execute([row])

    return true
  } catch (error) {
    console.error('[claude-memory] incrementRecordCounters failed:', error)
    throw error
  }
}

export async function deleteRecord(
  id: string,
  config: Config = DEFAULT_CONFIG
): Promise<void> {
  try {
    const { table } = await ensureClient(config)
    await table.delete(`id = '${escapeFilterValue(id)}'`)
  } catch (error) {
    console.error('[claude-memory] deleteRecord failed:', error)
    throw error
  }
}

export async function deleteByFilter(
  filter: string,
  config: Config = DEFAULT_CONFIG
): Promise<number> {
  try {
    const { table } = await ensureClient(config)
    const count = await table.countRows(filter)
    if (count <= 0) return 0
    await table.delete(filter)
    return count
  } catch (error) {
    console.error('[claude-memory] deleteByFilter failed:', error)
    throw error
  }
}

export async function resetCollection(
  config: Config = DEFAULT_CONFIG
): Promise<void> {
  try {
    // Ensure any cached table handles are closed before dropping.
    await closeLanceDB()

    const { connect } = await import('@lancedb/lancedb')
    const directory = resolveDirectory(config.lancedb.directory)
    const tableName = config.lancedb.table
    const conn = await connect(directory)

    const names = await conn.tableNames()
    if (names.includes(tableName)) {
      await conn.dropTable(tableName)
    }

    // Recreate empty table (initLanceDB will also ensure migrations)
    await initLanceDB(config)

    // Clear filesystem storage
    clearFilesystemStorage(tableName)

    try {
      conn.close()
    } catch {
      // ignore
    }
  } catch (error) {
    console.error('[claude-memory] resetCollection failed:', error)
    throw error
  }
}

function clearFilesystemStorage(table?: string): void {
  const baseDir = path.join(homedir(), '.claude-memory')
  const collectionKey = getCollectionKey(table)
  const dirsToClean = ['sessions', 'extractions', 'reviews', 'retrieval-events', 'token-usage-events', 'stats-snapshots']

  for (const dir of dirsToClean) {
    const dirPath = path.join(baseDir, dir, collectionKey)
    try {
      if (fs.existsSync(dirPath)) {
        fs.rmSync(dirPath, { recursive: true })
      }
      fs.mkdirSync(dirPath, { recursive: true })
    } catch (error) {
      console.error(`[claude-memory] Failed to clear ${dir}:`, error)
    }
  }
}

export async function getRecord(
  id: string,
  config: Config = DEFAULT_CONFIG,
  options: { includeEmbedding?: boolean } = {}
): Promise<MemoryRecord | null> {
  try {
    const { table } = await ensureClient(config)
    return await getRecordById(table, id, { includeEmbedding: options.includeEmbedding ?? false })
  } catch (error) {
    console.error('[claude-memory] getRecord failed:', error)
    throw error
  }
}

export async function getRecordStats(
  ids: string[],
  config: Config = DEFAULT_CONFIG
): Promise<Map<string, MemoryStats>> {
  if (ids.length === 0) return new Map()

  try {
    const { table } = await ensureClient(config)
    const uniqueIds = [...new Set(ids)]
    const statsMap = new Map<string, MemoryStats>()
    const batchSize = 1000

    for (let i = 0; i < uniqueIds.length; i += batchSize) {
      const batchIds = uniqueIds.slice(i, i + batchSize)
      const idFilter = batchIds.map(id => `'${escapeFilterValue(id)}'`).join(', ')

      const rows = await table
        .query()
        .where(`id IN (${idFilter})`)
        .select(['id', 'retrieval_count', 'usage_count', 'success_count', 'failure_count'])
        .toArray()

      for (const row of rows ?? []) {
        const r = row as Record<string, unknown>
        const id = r.id as string
        statsMap.set(id, {
          id,
          retrievalCount: Number(r.retrieval_count ?? 0),
          usageCount: Number(r.usage_count ?? 0),
          successCount: Number(r.success_count ?? 0),
          failureCount: Number(r.failure_count ?? 0)
        })
      }
    }

    return statsMap
  } catch (error) {
    console.error('[claude-memory] getRecordStats failed:', error)
    return new Map()
  }
}

export async function flushCollection(_config: Config = DEFAULT_CONFIG): Promise<void> {
  // LanceDB writes are immediately visible (MVCC).
}

export async function queryRecords(
  options: {
    filter?: string
    limit?: number
    offset?: number
    includeEmbeddings?: boolean
    orderBy?: 'timestamp_desc' | 'timestamp_asc'
  },
  config: Config = DEFAULT_CONFIG
): Promise<MemoryRecord[]> {
  try {
    const { table } = await ensureClient(config)

    const limit = options.limit ?? 1000
    const offset = options.offset ?? 0
    const filter = options.filter ?? "id <> ''"
    const outputFields = options.includeEmbeddings
      ? [...OUTPUT_FIELDS, 'embedding']
      : OUTPUT_FIELDS
    const orderBy = options.orderBy

    if (orderBy) {
      // Preserve prior behavior: no DB-side ordering; stream and keep only the top slice in memory (still a full scan).
      const targetCount = Math.max(0, offset + limit)
      if (targetCount === 0) return []

      const ordered: MemoryRecord[] = []
      const compare = (a: MemoryRecord, b: MemoryRecord): number => {
        const diff = (a.timestamp ?? 0) - (b.timestamp ?? 0)
        if (diff !== 0) return orderBy === 'timestamp_desc' ? -diff : diff
        return a.id.localeCompare(b.id)
      }
      const insertSorted = (record: MemoryRecord): void => {
        let low = 0
        let high = ordered.length
        while (low < high) {
          const mid = Math.floor((low + high) / 2)
          if (compare(record, ordered[mid]) < 0) {
            high = mid
          } else {
            low = mid + 1
          }
        }
        ordered.splice(low, 0, record)
        if (ordered.length > targetCount) {
          ordered.pop()
        }
      }

      for await (const record of iterateRecords({ filter, includeEmbeddings: options.includeEmbeddings }, config)) {
        insertSorted(record)
      }

      return ordered.slice(offset, offset + limit)
    }

    const rows = await table
      .query()
      .where(filter)
      .select(outputFields)
      .limit(limit)
      .offset(offset)
      .toArray()

    return (rows ?? [])
      .map(row => parseRecordFromRow(row as Record<string, unknown>))
      .filter((record): record is MemoryRecord => Boolean(record))
  } catch (error) {
    console.error('[claude-memory] queryRecords failed:', error)
    throw error
  }
}

export async function fetchRecordsByIds(
  ids: string[],
  config: Config = DEFAULT_CONFIG,
  options: { includeEmbeddings?: boolean } = {}
): Promise<MemoryRecord[]> {
  if (ids.length === 0) return []

  const records: MemoryRecord[] = []
  const batchSize = 1000

  for (let i = 0; i < ids.length; i += batchSize) {
    const batchIds = ids.slice(i, i + batchSize)
    const idFilter = batchIds.map(id => `'${escapeFilterValue(id)}'`).join(', ')
    const batch = await queryRecords({
      filter: `id IN (${idFilter})`,
      limit: batchIds.length,
      includeEmbeddings: options.includeEmbeddings
    }, config)
    records.push(...batch)
  }

  const byId = new Map(records.map(record => [record.id, record]))
  return ids
    .map(id => byId.get(id))
    .filter((record): record is MemoryRecord => Boolean(record))
}

export async function* iterateRecords(
  options: {
    filter?: string
    includeEmbeddings?: boolean
  } = {},
  config: Config = DEFAULT_CONFIG
): AsyncGenerator<MemoryRecord> {
  const { table } = await ensureClient(config)

  const filter = options.filter ?? "id <> ''"
  const outputFields = options.includeEmbeddings
    ? [...OUTPUT_FIELDS, 'embedding']
    : OUTPUT_FIELDS

  let offset = 0
  while (true) {
    const rows = await table
      .query()
      .where(filter)
      .select(outputFields)
      .limit(QUERY_PAGE_SIZE)
      .offset(offset)
      .toArray()

    if (!rows || rows.length === 0) break
    for (const row of rows) {
      const record = parseRecordFromRow(row as Record<string, unknown>)
      if (record) yield record
    }
    if (rows.length < QUERY_PAGE_SIZE) break
    offset += rows.length
  }
}

export async function countRecords(
  options: { filter?: string } = {},
  config: Config = DEFAULT_CONFIG
): Promise<number> {
  try {
    const { table } = await ensureClient(config)
    const expr = options.filter ?? "id <> ''"
    return await table.countRows(expr)
  } catch (error) {
    console.error('[claude-memory] countRecords failed:', error)
    throw error
  }
}

/**
 * Batch update multiple records with the same partial updates.
 * Much more efficient than calling updateRecord() in a loop when updating many records.
 * All records must already have embeddings (no re-embedding is done).
 */
export async function batchUpdateRecords(
  records: MemoryRecord[],
  updates: Partial<MemoryRecord>,
  config: Config = DEFAULT_CONFIG
): Promise<{ updated: number; failed: number }> {
  if (records.length === 0) return { updated: 0, failed: 0 }

  try {
    const { table } = await ensureClient(config)
    const batchSize = 500
    let updated = 0
    let failed = 0

    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize)
      const rows: LanceRow[] = []

      for (const record of batch) {
        try {
          const merged = mergeRecords(record, updates)
          merged.id = record.id
          // Keep existing embedding - no re-embedding for metadata-only updates
          const row = await buildLanceRow({ ...merged, embedding: record.embedding }, config)
          rows.push(row)
        } catch {
          failed += 1
        }
      }

      if (rows.length > 0) {
        await table
          .mergeInsert('id')
          .whenMatchedUpdateAll()
          .whenNotMatchedInsertAll()
          .execute(rows)
        updated += rows.length
      }
    }

    return { updated, failed }
  } catch (error) {
    console.error('[claude-memory] batchUpdateRecords failed:', error)
    throw error
  }
}

async function getRecordById(
  table: { query: () => any },
  id: string,
  options: { includeEmbedding?: boolean } = {}
): Promise<MemoryRecord | null> {
  const outputFields = options.includeEmbedding
    ? [...OUTPUT_FIELDS, 'embedding']
    : OUTPUT_FIELDS

  const rows = await table
    .query()
    .where(`id = '${escapeFilterValue(id)}'`)
    .select(outputFields)
    .limit(1)
    .toArray()

  if (!rows || rows.length === 0) return null
  return parseRecordFromRow(rows[0] as Record<string, unknown>)
}
