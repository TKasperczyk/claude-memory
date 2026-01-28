import fs from 'fs'
import path from 'path'
import { homedir } from 'os'
import { type MilvusClient, type RowData } from '@zilliz/milvus2-sdk-node'
import { escapeFilterValue } from './shared.js'
import { DEFAULT_CONFIG, type Config, type MemoryRecord } from './types.js'
import { OUTPUT_FIELDS, createCollection } from './milvus-schema.js'
import { ensureClient } from './milvus-client.js'
import {
  buildMilvusRow,
  mergeRecords,
  needsEmbeddingRefresh,
  parseRecordFromRow
} from './milvus-records.js'
import type { MemoryStats } from '../../shared/types.js'

export type FlushMode = 'never' | 'end-of-batch' | 'always'
export interface WriteOptions {
  flush?: FlushMode
}

const QUERY_ITERATOR_BATCH_SIZE = 1000
const POST_FLUSH_DELAY_MS = 500 // IVF_FLAT index needs time to update after flush

export async function insertRecord(
  record: MemoryRecord,
  config: Config = DEFAULT_CONFIG,
  options: WriteOptions = {}
): Promise<void> {
  try {
    const client = await ensureClient(config)

    const row = await buildMilvusRow(record, config)

    await client.insert({
      collection_name: config.milvus.collection,
      data: [row]
    })

    const flushMode = options.flush ?? 'always'
    if (flushMode === 'always') {
      await flushAndWait(client, config.milvus.collection)
    }
  } catch (error) {
    console.error('[claude-memory] insertRecord failed:', error)
    throw error
  }
}

export async function updateRecord(
  id: string,
  updates: Partial<MemoryRecord>,
  config: Config = DEFAULT_CONFIG,
  options: WriteOptions = {}
): Promise<boolean> {
  try {
    const client = await ensureClient(config)

    // NOTE: Read-modify-write can drop increments under concurrency; acceptable for ranking hints.
    const existing = await getRecordById(client, id, config, { includeEmbedding: true })
    if (!existing) return false

    const merged = mergeRecords(existing, updates)
    merged.id = id

    const shouldReembed = needsEmbeddingRefresh(existing, merged)
    if (shouldReembed && updates.timestamp === undefined) {
      merged.timestamp = Date.now()
    }

    const embedding = updates.embedding
      ?? (shouldReembed ? undefined : existing.embedding)

    const row = await buildMilvusRow({ ...merged, embedding }, config)

    await client.upsert({
      collection_name: config.milvus.collection,
      data: [row]
    })

    const flushMode = options.flush ?? 'always'
    if (flushMode === 'always') {
      await flushAndWait(client, config.milvus.collection)
    }

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
    const client = await ensureClient(config)

    const existing = await getRecordById(client, id, config, { includeEmbedding: true })
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

    const row = await buildMilvusRow({ ...merged, embedding }, config)

    await client.upsert({
      collection_name: config.milvus.collection,
      data: [row]
    })

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
    const client = await ensureClient(config)

    await client.delete({
      collection_name: config.milvus.collection,
      filter: `id == "${escapeFilterValue(id)}"`
    })

    await flushAndWait(client, config.milvus.collection)
  } catch (error) {
    console.error('[claude-memory] deleteRecord failed:', error)
    throw error
  }
}

export async function resetCollection(
  config: Config = DEFAULT_CONFIG
): Promise<void> {
  try {
    const client = await ensureClient(config)

    const collectionName = config.milvus.collection
    const hasCollection = await client.hasCollection({
      collection_name: collectionName
    })

    if (hasCollection.value) {
      try {
        await client.releaseCollection({
          collection_name: collectionName
        })
      } catch {
        // Ignore - collection might not be loaded
      }

      await client.dropCollection({
        collection_name: collectionName
      })
    }

    await createCollection(client, config)
    await client.loadCollection({
      collection_name: collectionName
    })

    // Clear filesystem storage
    clearFilesystemStorage()
  } catch (error) {
    console.error('[claude-memory] resetCollection failed:', error)
    throw error
  }
}

function clearFilesystemStorage(): void {
  const baseDir = path.join(homedir(), '.claude-memory')
  const dirsToClean = ['sessions', 'extractions', 'reviews']

  for (const dir of dirsToClean) {
    const dirPath = path.join(baseDir, dir)
    try {
      if (fs.existsSync(dirPath)) {
        fs.rmSync(dirPath, { recursive: true })
        fs.mkdirSync(dirPath, { recursive: true })
      }
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
    const client = await ensureClient(config)
    return await getRecordById(client, id, config, { includeEmbedding: options.includeEmbedding ?? false })
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
    const client = await ensureClient(config)

    const uniqueIds = [...new Set(ids)]
    const idFilter = uniqueIds.map(id => `"${escapeFilterValue(id)}"`).join(', ')

    const result = await client.query({
      collection_name: config.milvus.collection,
      filter: `id in [${idFilter}]`,
      output_fields: ['id', 'retrieval_count', 'usage_count', 'success_count', 'failure_count']
    })

    const statsMap = new Map<string, MemoryStats>()
    for (const row of result.data ?? []) {
      const r = row as Record<string, unknown>
      const id = r.id as string
      statsMap.set(id, {
        id,
        retrievalCount: (r.retrieval_count as number) ?? 0,
        usageCount: (r.usage_count as number) ?? 0,
        successCount: (r.success_count as number) ?? 0,
        failureCount: (r.failure_count as number) ?? 0
      })
    }

    return statsMap
  } catch (error) {
    console.error('[claude-memory] getRecordStats failed:', error)
    return new Map()
  }
}

export async function flushCollection(config: Config = DEFAULT_CONFIG): Promise<void> {
  const client = await ensureClient(config)
  await flushAndWait(client, config.milvus.collection)
}

export interface DomainExample {
  domain: string
  examples: string[]
}

/**
 * Get all distinct domains with example records for each.
 * Used to guide extraction model to use consistent domains.
 */
export async function getDomainExamples(
  examplesPerDomain: number = 2,
  config: Config = DEFAULT_CONFIG
): Promise<DomainExample[]> {
  try {
    const client = await ensureClient(config)

    // Query all non-deprecated records to get domains
    const result = await client.query({
      collection_name: config.milvus.collection,
      filter: 'deprecated == false',
      output_fields: ['domain', 'type', 'content'],
      limit: 1000
    })

    // Group by domain and collect examples
    const domainMap = new Map<string, string[]>()

    for (const row of result.data ?? []) {
      const domain = (row.domain as string) ?? ''
      if (!domain) continue

      const examples = domainMap.get(domain) ?? []
      if (examples.length >= examplesPerDomain) continue

      // Extract a short example from the record
      const example = extractShortExample(row as Record<string, unknown>)
      if (example) {
        examples.push(example)
        domainMap.set(domain, examples)
      }
    }

    return Array.from(domainMap.entries())
      .map(([domain, examples]) => ({ domain, examples }))
      .sort((a, b) => a.domain.localeCompare(b.domain))
  } catch (error) {
    console.error('[claude-memory] getDomainExamples failed:', error)
    return []
  }
}

function extractShortExample(row: Record<string, unknown>): string | null {
  try {
    const content = row.content as string
    if (!content) return null

    const parsed = JSON.parse(content) as Record<string, unknown>
    const type = parsed.type as string

    switch (type) {
      case 'command':
        return truncateExample(parsed.command as string, 60)
      case 'error':
        return truncateExample(parsed.errorText as string, 60)
      case 'discovery':
        return truncateExample(parsed.what as string, 60)
      case 'procedure':
        return truncateExample(parsed.name as string, 60)
      default:
        return null
    }
  } catch {
    return null
  }
}

function truncateExample(text: string | undefined, maxLen: number): string | null {
  if (!text) return null
  const trimmed = text.trim()
  if (trimmed.length <= maxLen) return trimmed
  return trimmed.slice(0, maxLen - 3) + '...'
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
    const client = await ensureClient(config)

    const limit = options.limit ?? 1000
    const offset = options.offset ?? 0
    const filter = options.filter ?? 'id != ""'
    const outputFields = options.includeEmbeddings
      ? [...OUTPUT_FIELDS, 'embedding']
      : OUTPUT_FIELDS
    const orderBy = options.orderBy

    if (orderBy) {
      // Milvus query API doesn't support ordering; stream and keep only the top slice in memory (still a full scan).
      const iterator = await client.queryIterator({
        collection_name: config.milvus.collection,
        filter,
        output_fields: outputFields,
        batchSize: QUERY_ITERATOR_BATCH_SIZE
      })

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
      for await (const batch of iterator) {
        if (!Array.isArray(batch)) continue
        for (const row of batch) {
          const record = parseRecordFromRow(row as Record<string, unknown>)
          if (record) insertSorted(record)
        }
      }

      return ordered.slice(offset, offset + limit)
    }

    const result = await client.query({
      collection_name: config.milvus.collection,
      filter,
      output_fields: outputFields,
      limit,
      offset
    })

    return (result.data ?? [])
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
    const idFilter = batchIds.map(id => `"${escapeFilterValue(id)}"`).join(', ')
    const batch = await queryRecords({
      filter: `id in [${idFilter}]`,
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
  const client = await ensureClient(config)

  const filter = options.filter ?? 'id != ""'
  const outputFields = options.includeEmbeddings
    ? [...OUTPUT_FIELDS, 'embedding']
    : OUTPUT_FIELDS

  const iterator = await client.queryIterator({
    collection_name: config.milvus.collection,
    filter,
    output_fields: outputFields,
    batchSize: QUERY_ITERATOR_BATCH_SIZE
  })

  for await (const batch of iterator) {
    if (!Array.isArray(batch)) continue
    for (const row of batch) {
      const record = parseRecordFromRow(row as Record<string, unknown>)
      if (record) {
        yield record
      }
    }
  }
}

export async function countRecords(
  options: { filter?: string } = {},
  config: Config = DEFAULT_CONFIG
): Promise<number> {
  try {
    const client = await ensureClient(config)

    const expr = options.filter ?? 'id != ""'
    const result = await client.count({
      collection_name: config.milvus.collection,
      expr
    })

    return result.data ?? 0
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
    const client = await ensureClient(config)
    const batchSize = 500
    let updated = 0
    let failed = 0

    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize)
      const rows: RowData[] = []

      for (const record of batch) {
        try {
          const merged = mergeRecords(record, updates)
          merged.id = record.id
          // Keep existing embedding - no re-embedding for metadata-only updates
          const row = await buildMilvusRow({ ...merged, embedding: record.embedding }, config)
          rows.push(row)
        } catch {
          failed += 1
        }
      }

      if (rows.length > 0) {
        await client.upsert({
          collection_name: config.milvus.collection,
          data: rows
        })
        updated += rows.length
      }
    }

    // Single flush at the end
    await flushAndWait(client, config.milvus.collection)

    return { updated, failed }
  } catch (error) {
    console.error('[claude-memory] batchUpdateRecords failed:', error)
    throw error
  }
}

async function getRecordById(
  client: MilvusClient,
  id: string,
  config: Config,
  options: { includeEmbedding?: boolean } = {}
): Promise<MemoryRecord | null> {
  const outputFields = options.includeEmbedding
    ? [...OUTPUT_FIELDS, 'embedding']
    : OUTPUT_FIELDS

  const result = await client.query({
    collection_name: config.milvus.collection,
    filter: `id == "${escapeFilterValue(id)}"`,
    output_fields: outputFields
  })

  if (!result.data || result.data.length === 0) return null

  return parseRecordFromRow(result.data[0] as Record<string, unknown>)
}

async function flushAndWait(client: MilvusClient, collectionName: string): Promise<void> {
  await client.flush({
    collection_names: [collectionName]
  })
  // IVF_FLAT index needs time to update after flush before search works reliably
  await new Promise(resolve => setTimeout(resolve, POST_FLUSH_DELAY_MS))
}
