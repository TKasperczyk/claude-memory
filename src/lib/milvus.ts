/**
 * Milvus vector database operations for Claude Memory.
 */

import { DataType, MilvusClient, type RowData } from '@zilliz/milvus2-sdk-node'
import { embed, ensureEmbeddingDim } from './embed.js'
import { buildExactText, escapeFilterValue } from './shared.js'
import {
  DEFAULT_CONFIG,
  EMBEDDING_DIM,
  type Config,
  type HybridSearchParams,
  type HybridSearchResult,
  type MemoryRecord,
  type RecordScope,
  type RecordType
} from './types.js'

export { escapeFilterValue }

export type FlushMode = 'never' | 'end-of-batch' | 'always'
export interface WriteOptions {
  flush?: FlushMode
}

const CONTENT_MAX_LENGTH = 16384
const EXACT_TEXT_MAX_LENGTH = 4096
const SOURCE_SESSION_ID_MAX_LENGTH = 128
const SOURCE_EXCERPT_MAX_LENGTH = 512
const SEARCH_NPROBE = 64
const QUERY_ITERATOR_BATCH_SIZE = 1000
const POST_FLUSH_DELAY_MS = 500 // IVF_FLAT index needs time to update after flush
const USAGE_RATIO_WEIGHT = 0.2

const OUTPUT_FIELDS = [
  'id',
  'type',
  'content',
  'exact_text',
  'project',
  'scope',
  'domain',
  'timestamp',
  'success_count',
  'failure_count',
  'retrieval_count',
  'usage_count',
  'last_used',
  'deprecated',
  'generalized',
  'last_generalization_check',
  'last_global_check',
  'source_session_id',
  'source_excerpt'
]

let client: MilvusClient | null = null
let activeConfig: Config | null = null

export async function initMilvus(config: Config = DEFAULT_CONFIG): Promise<void> {
  client = new MilvusClient({ address: config.milvus.address })
  activeConfig = config

  const hasCollection = await client.hasCollection({
    collection_name: config.milvus.collection
  })

  if (!hasCollection.value) {
    await createCollection(config)
  } else {
    await ensureUsageFields(config)
    await ensureScopeField(config)
    await ensureGeneralizationFields(config)
    await ensureGlobalCheckField(config)
    await ensureSourceFields(config)
  }

  // Release first in case collection is in an inconsistent state
  try {
    await client.releaseCollection({
      collection_name: config.milvus.collection
    })
  } catch {
    // Ignore - collection might not be loaded
  }

  await client.loadCollection({
    collection_name: config.milvus.collection
  })
}

export async function insertRecord(
  record: MemoryRecord,
  config: Config = DEFAULT_CONFIG,
  options: WriteOptions = {}
): Promise<void> {
  try {
    await ensureClient(config)

    const row = await buildMilvusRow(record, config)

    await client!.insert({
      collection_name: config.milvus.collection,
      data: [row]
    })

    const flushMode = options.flush ?? 'always'
    if (flushMode === 'always') {
      await flushAndWait(config.milvus.collection)
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
    await ensureClient(config)

    // NOTE: Read-modify-write can drop increments under concurrency; acceptable for ranking hints.
    const existing = await getRecordById(id, config)
    if (!existing) return false

    const merged = mergeRecords(existing, updates)
    merged.id = id

    const shouldReembed = needsEmbeddingRefresh(updates)
    if (shouldReembed && updates.timestamp === undefined) {
      merged.timestamp = Date.now()
    }

    const embedding = updates.embedding
      ?? (shouldReembed ? undefined : existing.embedding)

    const row = await buildMilvusRow({ ...merged, embedding }, config)

    await client!.upsert({
      collection_name: config.milvus.collection,
      data: [row]
    })

    const flushMode = options.flush ?? 'always'
    if (flushMode === 'always') {
      await flushAndWait(config.milvus.collection)
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
    await ensureClient(config)

    const existing = await getRecordById(id, config)
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

    const shouldReembed = needsEmbeddingRefresh(updates)
    if (shouldReembed && updates.timestamp === undefined) {
      merged.timestamp = Date.now()
    }

    const embedding = updates.embedding
      ?? (shouldReembed ? undefined : existing.embedding)

    const row = await buildMilvusRow({ ...merged, embedding }, config)

    await client!.upsert({
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
    await ensureClient(config)

    await client!.delete({
      collection_name: config.milvus.collection,
      filter: `id == "${escapeFilterValue(id)}"`
    })

    await flushAndWait(config.milvus.collection)
  } catch (error) {
    console.error('[claude-memory] deleteRecord failed:', error)
    throw error
  }
}

export async function getRecord(
  id: string,
  config: Config = DEFAULT_CONFIG
): Promise<MemoryRecord | null> {
  try {
    await ensureClient(config)
    return await getRecordById(id, config)
  } catch (error) {
    console.error('[claude-memory] getRecord failed:', error)
    throw error
  }
}

export interface MemoryStats {
  id: string
  retrievalCount: number
  usageCount: number
  successCount: number
  failureCount: number
}

export async function getRecordStats(
  ids: string[],
  config: Config = DEFAULT_CONFIG
): Promise<Map<string, MemoryStats>> {
  if (ids.length === 0) return new Map()

  try {
    await ensureClient(config)

    const uniqueIds = [...new Set(ids)]
    const idFilter = uniqueIds.map(id => `"${escapeFilterValue(id)}"`).join(', ')

    const result = await client!.query({
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
  await ensureClient(config)
  await flushAndWait(config.milvus.collection)
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
    await ensureClient(config)

    // Query all non-deprecated records to get domains
    const result = await client!.query({
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
    await ensureClient(config)

    const limit = options.limit ?? 1000
    const offset = options.offset ?? 0
    const filter = options.filter ?? 'id != ""'
    const outputFields = options.includeEmbeddings
      ? [...OUTPUT_FIELDS, 'embedding']
      : OUTPUT_FIELDS
    const orderBy = options.orderBy

    if (orderBy) {
      const iterator = await client!.queryIterator({
        collection_name: config.milvus.collection,
        filter,
        output_fields: outputFields,
        batchSize: QUERY_ITERATOR_BATCH_SIZE
      })

      const rows: MemoryRecord[] = []
      for await (const batch of iterator) {
        if (!Array.isArray(batch)) continue
        for (const row of batch) {
          const record = parseRecordFromRow(row as Record<string, unknown>)
          if (record) rows.push(record)
        }
      }

      rows.sort((a, b) => {
        const diff = (a.timestamp ?? 0) - (b.timestamp ?? 0)
        if (diff !== 0) return orderBy === 'timestamp_desc' ? -diff : diff
        return a.id.localeCompare(b.id)
      })

      return rows.slice(offset, offset + limit)
    }

    const result = await client!.query({
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

export async function countRecords(
  options: { filter?: string } = {},
  config: Config = DEFAULT_CONFIG
): Promise<number> {
  try {
    await ensureClient(config)

    const expr = options.filter ?? 'id != ""'
    const result = await client!.count({
      collection_name: config.milvus.collection,
      expr
    })

    return result.data ?? 0
  } catch (error) {
    console.error('[claude-memory] countRecords failed:', error)
    throw error
  }
}

export async function hybridSearch(
  params: HybridSearchParams,
  config: Config = DEFAULT_CONFIG
): Promise<HybridSearchResult[]> {
  try {
    await ensureClient(config)

    const abortSignal = params.signal
    if (abortSignal?.aborted) {
      throw new Error('Search aborted')
    }

    const trimmedQuery = params.query.trim()
    const limit = params.limit ?? 10
    const vectorWeight = params.vectorWeight ?? 0.7
    const keywordWeight = params.keywordWeight ?? 0.3
    const minSimilarity = params.minSimilarity ?? 0
    const minScore = params.minScore ?? 0.45
    const vectorLimit = params.vectorLimit ?? limit
    const keywordLimit = params.keywordLimit ?? limit
    const shouldApplyMinScore = vectorWeight > 0

    const baseFilter = buildFilter({
      project: params.project,
      includeGlobal: Boolean(params.project),
      domain: params.domain,
      type: params.type,
      excludeDeprecated: params.excludeDeprecated
    })

    const outputFields = params.includeEmbeddings
      ? [...OUTPUT_FIELDS, 'embedding']
      : OUTPUT_FIELDS

    const combined = new Map<string, { record: MemoryRecord; similarity: number; keywordMatch: boolean }>()

    if (trimmedQuery.length > 0 && keywordWeight > 0) {
      if (abortSignal?.aborted) {
        throw new Error('Search aborted')
      }
      const keywordFilter = buildKeywordFilter(trimmedQuery, baseFilter)
      const keywordResults = await client!.query({
        collection_name: config.milvus.collection,
        filter: keywordFilter,
        output_fields: outputFields,
        limit: keywordLimit
      })

      for (const row of keywordResults.data ?? []) {
        const record = parseRecordFromRow(row)
        if (!record) continue
        combined.set(record.id, { record, similarity: 0, keywordMatch: true })
      }
    }

    if (vectorWeight > 0 && (params.embedding || trimmedQuery.length > 0)) {
      if (abortSignal?.aborted) {
        throw new Error('Search aborted')
      }
      const vector = params.embedding ?? await embed(trimmedQuery, config, { signal: abortSignal })
      ensureEmbeddingDim(vector)

      const searchResults = await client!.search({
        collection_name: config.milvus.collection,
        data: [vector],
        limit: vectorLimit,
        filter: baseFilter,
        output_fields: outputFields,
        params: { nprobe: SEARCH_NPROBE }
      })

      for (const row of searchResults.results ?? []) {
        const similarity = row.score ?? 0
        if (similarity < minSimilarity) continue
        const record = parseRecordFromRow(row)
        if (!record) continue
        const existing = combined.get(record.id)
        if (existing) {
          existing.similarity = Math.max(existing.similarity, similarity)
        } else {
          combined.set(record.id, { record, similarity, keywordMatch: false })
        }
      }
    }

    const results: HybridSearchResult[] = Array.from(combined.values()).map(entry => {
      const baseScore = (entry.keywordMatch ? keywordWeight : 0) + (entry.similarity * vectorWeight)
      const usageRatio = computeUsageRatio(entry.record)
      const score = baseScore + (usageRatio * USAGE_RATIO_WEIGHT)
      return {
        record: entry.record,
        similarity: entry.similarity,
        keywordMatch: entry.keywordMatch,
        score
      }
    })

    results.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return b.similarity - a.similarity
    })

    return results
      .filter(r => !shouldApplyMinScore || r.keywordMatch || r.score >= minScore)
      .slice(0, limit)
  } catch (error) {
    console.error('[claude-memory] hybridSearch failed:', error)
    throw error
  }
}

export async function findSimilar(
  record: MemoryRecord,
  similarityThreshold: number = 0.85,
  limit: number = 5,
  config: Config = DEFAULT_CONFIG
): Promise<Array<{ record: MemoryRecord; similarity: number }>> {
  try {
    await ensureClient(config)

    const vector = record.embedding ?? await embed(buildEmbeddingInput(record), config)
    ensureEmbeddingDim(vector)

    const filter = buildFilter({
      project: resolveProject(record),
      domain: resolveDomain(record),
      type: record.type,
      excludeId: record.id,
      excludeDeprecated: true
    })

    const searchResults = await client!.search({
      collection_name: config.milvus.collection,
      data: [vector],
      limit,
      filter,
      output_fields: OUTPUT_FIELDS,
      params: { nprobe: SEARCH_NPROBE }
    })

    const matches = (searchResults.results ?? [])
      .map(row => {
        const record = parseRecordFromRow(row)
        return record ? { record, similarity: row.score ?? 0 } : null
      })
      .filter((match): match is { record: MemoryRecord; similarity: number } => Boolean(match))
      .filter(result => result.similarity >= similarityThreshold)

    matches.sort((a, b) => b.similarity - a.similarity)
    return matches
  } catch (error) {
    console.error('[claude-memory] findSimilar failed:', error)
    throw error
  }
}

export async function vectorSearchSimilar(
  embedding: number[],
  options: {
    filter?: string
    limit?: number
    similarityThreshold?: number
  },
  config: Config = DEFAULT_CONFIG
): Promise<Array<{ record: MemoryRecord; similarity: number }>> {
  try {
    await ensureClient(config)
    ensureEmbeddingDim(embedding)

    const limit = options.limit ?? 10
    const similarityThreshold = options.similarityThreshold ?? 0

    const searchResults = await client!.search({
      collection_name: config.milvus.collection,
      data: [embedding],
      limit,
      filter: options.filter,
      output_fields: OUTPUT_FIELDS,
      params: { nprobe: SEARCH_NPROBE }
    })

    const matches = (searchResults.results ?? [])
      .map(row => {
        const record = parseRecordFromRow(row)
        return record ? { record, similarity: row.score ?? 0 } : null
      })
      .filter((match): match is { record: MemoryRecord; similarity: number } => Boolean(match))
      .filter(result => result.similarity >= similarityThreshold)

    matches.sort((a, b) => b.similarity - a.similarity)
    return matches
  } catch (error) {
    console.error('[claude-memory] vectorSearchSimilar failed:', error)
    throw error
  }
}

async function ensureClient(config: Config): Promise<void> {
  if (!client || !activeConfig || !isSameConfig(activeConfig, config)) {
    await initMilvus(config)
  }
}

function isSameConfig(a: Config, b: Config): boolean {
  return a.milvus.address === b.milvus.address && a.milvus.collection === b.milvus.collection
}

async function createCollection(config: Config): Promise<void> {
  if (!client) throw new Error('Milvus client not initialized')

  await client.createCollection({
    collection_name: config.milvus.collection,
    fields: [
      { name: 'id', data_type: DataType.VarChar, is_primary_key: true, max_length: 64 },
      { name: 'type', data_type: DataType.VarChar, max_length: 32 },
      { name: 'content', data_type: DataType.VarChar, max_length: CONTENT_MAX_LENGTH },
      { name: 'exact_text', data_type: DataType.VarChar, max_length: EXACT_TEXT_MAX_LENGTH },
      { name: 'project', data_type: DataType.VarChar, max_length: 256 },
      { name: 'scope', data_type: DataType.VarChar, max_length: 16 },
      { name: 'domain', data_type: DataType.VarChar, max_length: 64 },
      { name: 'timestamp', data_type: DataType.Int64 },
      { name: 'success_count', data_type: DataType.Int64 },
      { name: 'failure_count', data_type: DataType.Int64 },
      { name: 'retrieval_count', data_type: DataType.Int64 },
      { name: 'usage_count', data_type: DataType.Int64 },
      { name: 'last_used', data_type: DataType.Int64 },
      { name: 'deprecated', data_type: DataType.Bool },
      { name: 'generalized', data_type: DataType.Bool },
      { name: 'last_generalization_check', data_type: DataType.Int64 },
      { name: 'last_global_check', data_type: DataType.Int64 },
      { name: 'source_session_id', data_type: DataType.VarChar, max_length: SOURCE_SESSION_ID_MAX_LENGTH, nullable: true },
      { name: 'source_excerpt', data_type: DataType.VarChar, max_length: SOURCE_EXCERPT_MAX_LENGTH, nullable: true },
      { name: 'embedding', data_type: DataType.FloatVector, dim: EMBEDDING_DIM }
    ]
  })

  await client.createIndex({
    collection_name: config.milvus.collection,
    field_name: 'embedding',
    index_type: 'IVF_FLAT',
    metric_type: 'COSINE',
    params: { nlist: 128 }
  })

  console.error('[claude-memory] Created collection:', config.milvus.collection)
}

async function ensureUsageFields(config: Config): Promise<void> {
  if (!client) throw new Error('Milvus client not initialized')

  try {
    const description = await client.describeCollection({
      collection_name: config.milvus.collection
    })

    const fields = description.schema?.fields ?? []
    const fieldNames = new Set(fields.map(field => field.name))
    const missing = [
      { name: 'retrieval_count', data_type: DataType.Int64, nullable: true },
      { name: 'usage_count', data_type: DataType.Int64, nullable: true }
    ].filter(field => !fieldNames.has(field.name))

    if (missing.length === 0) return

    const result = await client.addCollectionFields({
      collection_name: config.milvus.collection,
      fields: missing
    })

    if (result.error_code !== 'Success') {
      console.error(`[claude-memory] Failed to add fields: ${result.reason}`)
      return
    }

    console.error(`[claude-memory] Added fields to ${config.milvus.collection}: ${missing.map(field => field.name).join(', ')}`)
  } catch (error) {
    console.error('[claude-memory] Failed to ensure usage fields:', error)
  }
}

async function ensureScopeField(config: Config): Promise<void> {
  if (!client) throw new Error('Milvus client not initialized')

  try {
    const description = await client.describeCollection({
      collection_name: config.milvus.collection
    })

    const fields = description.schema?.fields ?? []
    const fieldNames = new Set(fields.map(field => field.name))
    if (fieldNames.has('scope')) return

    const result = await client.addCollectionFields({
      collection_name: config.milvus.collection,
      fields: [{ name: 'scope', data_type: DataType.VarChar, max_length: 16, nullable: true }]
    })

    if (result.error_code !== 'Success') {
      console.error(`[claude-memory] Failed to add scope field: ${result.reason}`)
      return
    }

    console.error(`[claude-memory] Added field to ${config.milvus.collection}: scope`)
  } catch (error) {
    console.error('[claude-memory] Failed to ensure scope field:', error)
  }
}

async function ensureGeneralizationFields(config: Config): Promise<void> {
  if (!client) throw new Error('Milvus client not initialized')

  try {
    const description = await client.describeCollection({
      collection_name: config.milvus.collection
    })

    const fields = description.schema?.fields ?? []
    const fieldNames = new Set(fields.map(field => field.name))
    const missing = [
      { name: 'generalized', data_type: DataType.Bool, nullable: true },
      { name: 'last_generalization_check', data_type: DataType.Int64, nullable: true }
    ].filter(field => !fieldNames.has(field.name))

    if (missing.length === 0) return

    const result = await client.addCollectionFields({
      collection_name: config.milvus.collection,
      fields: missing
    })

    if (result.error_code !== 'Success') {
      console.error(`[claude-memory] Failed to add generalization fields: ${result.reason}`)
      return
    }

    console.error(`[claude-memory] Added fields to ${config.milvus.collection}: ${missing.map(field => field.name).join(', ')}`)
  } catch (error) {
    console.error('[claude-memory] Failed to ensure generalization fields:', error)
  }
}

async function ensureGlobalCheckField(config: Config): Promise<void> {
  if (!client) throw new Error('Milvus client not initialized')

  try {
    const description = await client.describeCollection({
      collection_name: config.milvus.collection
    })

    const fields = description.schema?.fields ?? []
    const fieldNames = new Set(fields.map(field => field.name))
    if (fieldNames.has('last_global_check')) return

    const result = await client.addCollectionFields({
      collection_name: config.milvus.collection,
      fields: [{ name: 'last_global_check', data_type: DataType.Int64, nullable: true }]
    })

    if (result.error_code !== 'Success') {
      console.error(`[claude-memory] Failed to add global check field: ${result.reason}`)
      return
    }

    console.error(`[claude-memory] Added field to ${config.milvus.collection}: last_global_check`)
  } catch (error) {
    console.error('[claude-memory] Failed to ensure global check field:', error)
  }
}

async function ensureSourceFields(config: Config): Promise<void> {
  if (!client) throw new Error('Milvus client not initialized')

  try {
    const description = await client.describeCollection({
      collection_name: config.milvus.collection
    })

    const fields = description.schema?.fields ?? []
    const fieldNames = new Set(fields.map(field => field.name))
    const missing = [
      { name: 'source_session_id', data_type: DataType.VarChar, max_length: SOURCE_SESSION_ID_MAX_LENGTH, nullable: true },
      { name: 'source_excerpt', data_type: DataType.VarChar, max_length: SOURCE_EXCERPT_MAX_LENGTH, nullable: true }
    ].filter(field => !fieldNames.has(field.name))

    if (missing.length === 0) return

    const result = await client.addCollectionFields({
      collection_name: config.milvus.collection,
      fields: missing
    })

    if (result.error_code !== 'Success') {
      console.error(`[claude-memory] Failed to add source fields: ${result.reason}`)
      return
    }

    console.error(`[claude-memory] Added fields to ${config.milvus.collection}: ${missing.map(field => field.name).join(', ')}`)
  } catch (error) {
    console.error('[claude-memory] Failed to ensure source fields:', error)
  }
}

async function buildMilvusRow(record: MemoryRecord, config: Config): Promise<RowData> {
  const normalized = normalizeRecord(record)
  const content = serializeRecord(normalized)
  if (content.length > CONTENT_MAX_LENGTH) {
    throw new Error(`Record content exceeds ${CONTENT_MAX_LENGTH} chars (id: ${normalized.id})`)
  }

  const exactTextRaw = buildExactText(normalized)
  const exactText = truncateString(exactTextRaw, EXACT_TEXT_MAX_LENGTH)
  const sourceSessionId = normalizeOptionalString(normalized.sourceSessionId)
  const sourceExcerpt = normalizeOptionalString(normalized.sourceExcerpt)

  const embedding = normalized.embedding
    ?? await embed(buildEmbeddingInput(normalized, exactTextRaw, content), config)
  ensureEmbeddingDim(embedding)

  return {
    id: normalized.id,
    type: normalized.type,
    content,
    exact_text: exactText,
    project: normalized.project ?? '',
    scope: normalized.scope,
    domain: normalized.domain ?? '',
    timestamp: toInt64(normalized.timestamp, Date.now()),
    success_count: toInt64(normalized.successCount, 0),
    failure_count: toInt64(normalized.failureCount, 0),
    retrieval_count: toInt64(normalized.retrievalCount, 0),
    usage_count: toInt64(normalized.usageCount, 0),
    last_used: toInt64(normalized.lastUsed, normalized.timestamp ?? Date.now()),
    deprecated: Boolean(normalized.deprecated),
    generalized: Boolean(normalized.generalized),
    last_generalization_check: toInt64(normalized.lastGeneralizationCheck, 0),
    last_global_check: toInt64(normalized.lastGlobalCheck, 0),
    source_session_id: sourceSessionId ? truncateString(sourceSessionId, SOURCE_SESSION_ID_MAX_LENGTH) : null,
    source_excerpt: sourceExcerpt ? truncateString(sourceExcerpt, SOURCE_EXCERPT_MAX_LENGTH) : null,
    embedding
  }
}

function normalizeRecord(record: MemoryRecord): MemoryRecord {
  const project = record.project ?? resolveProject(record)
  const domain = record.domain ?? resolveDomain(record)
  const scope = normalizeScope(record.scope)
  const timestamp = toInt64(record.timestamp, Date.now())
  const successCount = toInt64(record.successCount, 0)
  const failureCount = toInt64(record.failureCount, 0)
  const retrievalCount = toInt64(record.retrievalCount, 0)
  const usageCount = toInt64(record.usageCount, 0)
  const lastUsed = toInt64(record.lastUsed, timestamp)
  const deprecated = Boolean(record.deprecated ?? false)
  const generalized = toBoolean(record.generalized, false)
  const lastGeneralizationCheck = toInt64(record.lastGeneralizationCheck, 0)
  const lastGlobalCheck = toInt64(record.lastGlobalCheck, 0)

  return {
    ...record,
    project,
    scope,
    domain,
    timestamp,
    successCount,
    failureCount,
    retrievalCount,
    usageCount,
    lastUsed,
    deprecated,
    generalized,
    lastGeneralizationCheck,
    lastGlobalCheck
  }
}

function resolveProject(record: MemoryRecord): string | undefined {
  if (record.project) return record.project
  if ('context' in record && record.context && 'project' in record.context) {
    return record.context.project
  }
  return undefined
}

function resolveDomain(record: MemoryRecord): string | undefined {
  if (record.domain) return record.domain
  if (record.type === 'procedure') return record.context.domain
  return undefined
}

export function buildEmbeddingInput(
  record: MemoryRecord,
  exactTextRaw?: string,
  content?: string
): string {
  const candidate = exactTextRaw ?? buildExactText(record)
  const trimmed = candidate.trim()
  if (trimmed.length > 0) return trimmed
  return content ?? serializeRecord(record)
}

function serializeRecord(record: MemoryRecord): string {
  const { embedding: _embedding, ...rest } = record as MemoryRecord & { embedding?: number[] }
  return JSON.stringify(rest)
}

function truncateString(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return value.slice(0, maxLength)
}

async function flushAndWait(collectionName: string): Promise<void> {
  await client!.flush({
    collection_names: [collectionName]
  })
  // IVF_FLAT index needs time to update after flush before search works reliably
  await new Promise(resolve => setTimeout(resolve, POST_FLUSH_DELAY_MS))
}

function toInt64(value: number | string | undefined, fallback: number): number {
  if (typeof value === 'number' && !Number.isNaN(value)) return Math.trunc(value)
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (!Number.isNaN(parsed)) return Math.trunc(parsed)
  }
  return Math.trunc(fallback)
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true') return true
    if (normalized === 'false') return false
  }
  return fallback
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function isRecordType(value: unknown): value is RecordType {
  return value === 'command'
    || value === 'error'
    || value === 'discovery'
    || value === 'procedure'
}

function coerceOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string')
}

function isValidOutcome(value: unknown): value is 'success' | 'failure' | 'partial' {
  return value === 'success' || value === 'failure' || value === 'partial'
}

function isValidConfidence(value: unknown): value is 'verified' | 'inferred' | 'tentative' {
  return value === 'verified' || value === 'inferred' || value === 'tentative'
}

function isValidScope(value: unknown): value is RecordScope {
  return value === 'global' || value === 'project'
}

function normalizeScope(value: unknown): RecordScope {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'global' || normalized === 'project') {
      return normalized as RecordScope
    }
  }
  if (isValidScope(value)) return value
  return 'project'
}

function isValidRecord(record: MemoryRecord): boolean {
  if (!isNonEmptyString(record.id)) return false

  switch (record.type) {
    case 'command':
      return isNonEmptyString(record.command)
        && typeof record.exitCode === 'number'
        && !Number.isNaN(record.exitCode)
        && isValidOutcome(record.outcome)
        && isPlainObject(record.context)
    case 'error':
      return isNonEmptyString(record.errorText)
        && isNonEmptyString(record.errorType)
        && isNonEmptyString(record.resolution)
        && isPlainObject(record.context)
    case 'discovery':
      return isNonEmptyString(record.what)
        && isNonEmptyString(record.where)
        && isNonEmptyString(record.evidence)
        && isValidConfidence(record.confidence)
    case 'procedure':
      return isNonEmptyString(record.name)
        && isStringArray(record.steps)
        && record.steps.some(step => step.trim().length > 0)
        && isPlainObject(record.context)
  }

  return false
}

function parseRecordFromRow(row: Record<string, unknown>): MemoryRecord | null {
  let parsed: Partial<MemoryRecord> = {}

  if (typeof row.content === 'string') {
    try {
      parsed = JSON.parse(row.content) as Partial<MemoryRecord>
    } catch (error) {
      console.error('[claude-memory] Failed to parse record content:', error)
    }
  }

  const rawType = row.type ?? parsed.type
  if (!isRecordType(rawType)) {
    console.error('[claude-memory] Record type missing or invalid in stored row.')
    return null
  }

  const idValue = row.id ?? parsed.id
  if (!isNonEmptyString(idValue)) {
    console.error('[claude-memory] Record id missing in stored row.')
    return null
  }

  const record = {
    ...parsed,
    id: idValue,
    type: rawType,
    project: (row.project as string | undefined) ?? parsed.project,
    scope: normalizeScope(row.scope ?? parsed.scope),
    domain: (row.domain as string | undefined) ?? parsed.domain,
    timestamp: toInt64((row.timestamp as number | string | undefined) ?? parsed.timestamp, 0),
    successCount: toInt64((row.success_count as number | string | undefined) ?? parsed.successCount, 0),
    failureCount: toInt64((row.failure_count as number | string | undefined) ?? parsed.failureCount, 0),
    retrievalCount: toInt64((row.retrieval_count as number | string | undefined) ?? parsed.retrievalCount, 0),
    usageCount: toInt64((row.usage_count as number | string | undefined) ?? parsed.usageCount, 0),
    lastUsed: toInt64((row.last_used as number | string | undefined) ?? parsed.lastUsed, 0),
    deprecated: toBoolean(row.deprecated ?? parsed.deprecated, false),
    generalized: toBoolean(row.generalized ?? parsed.generalized, false),
    lastGeneralizationCheck: toInt64(
      (row.last_generalization_check as number | string | undefined) ?? parsed.lastGeneralizationCheck,
      0
    ),
    lastGlobalCheck: toInt64(
      (row.last_global_check as number | string | undefined) ?? parsed.lastGlobalCheck,
      0
    ),
    sourceSessionId: coerceOptionalString(row.source_session_id) ?? parsed.sourceSessionId,
    sourceExcerpt: coerceOptionalString(row.source_excerpt) ?? parsed.sourceExcerpt
  } as MemoryRecord

  if (!isValidRecord(record)) {
    console.error(`[claude-memory] Invalid record; skipping id=${record.id} type=${record.type}`)
    return null
  }

  if (Array.isArray(row.embedding)) {
    record.embedding = row.embedding as number[]
  }

  return record
}

async function getRecordById(id: string, config: Config): Promise<MemoryRecord | null> {
  const result = await client!.query({
    collection_name: config.milvus.collection,
    filter: `id == "${escapeFilterValue(id)}"`,
    output_fields: [...OUTPUT_FIELDS, 'embedding']
  })

  if (!result.data || result.data.length === 0) return null

  return parseRecordFromRow(result.data[0] as Record<string, unknown>)
}

function mergeRecords(existing: MemoryRecord, updates: Partial<MemoryRecord>): MemoryRecord {
  const merged = { ...existing, ...updates } as MemoryRecord

  if (existing.type !== 'discovery' && 'context' in updates && updates.context) {
    const mergedWithContext = merged as Exclude<MemoryRecord, { type: 'discovery' }>
    mergedWithContext.context = {
      ...existing.context,
      ...(updates.context as typeof existing.context)
    }
  }

  return merged
}

function needsEmbeddingRefresh(updates: Partial<MemoryRecord>): boolean {
  const embeddingFields = new Set([
    'type',
    'command',
    'errorText',
    'what',
    'where',
    'name',
    'steps'
  ])

  return Object.keys(updates).some(key => embeddingFields.has(key))
}

function escapeLikeValue(value: string): string {
  const escapedWildcards = value.replace(/[%_]/g, '\\$&')
  return escapeFilterValue(escapedWildcards)
}

function buildFilter(filters: {
  project?: string
  includeGlobal?: boolean
  domain?: string
  type?: RecordType
  excludeId?: string
  excludeDeprecated?: boolean
}): string | undefined {
  const parts: string[] = []

  if (filters.project) {
    const projectClause = `project == "${escapeFilterValue(filters.project)}"`
    if (filters.includeGlobal) {
      parts.push(`(${projectClause} || scope == "global")`)
    } else {
      parts.push(projectClause)
    }
  }

  if (filters.domain) {
    const domainValue = escapeFilterValue(filters.domain)
    parts.push(`(domain == "${domainValue}" || domain == "")`)
  }

  if (filters.type) {
    parts.push(`type == "${escapeFilterValue(filters.type)}"`)
  }

  if (filters.excludeId) {
    parts.push(`id != "${escapeFilterValue(filters.excludeId)}"`)
  }

  if (filters.excludeDeprecated) {
    parts.push('deprecated == false')
  }

  if (parts.length === 0) return undefined
  return parts.join(' && ')
}

function buildKeywordFilter(query: string, baseFilter?: string): string {
  const escaped = escapeLikeValue(query)
  const likeClause = `exact_text like "%${escaped}%"`
  if (!baseFilter) return likeClause
  return `${baseFilter} && ${likeClause}`
}

function computeUsageRatio(record: MemoryRecord): number {
  const retrievalCount = record.retrievalCount ?? 0
  const usageCount = record.usageCount ?? 0
  if (usageCount <= 0) return 0
  return Math.min(usageCount / Math.max(retrievalCount, 1), 1)
}
