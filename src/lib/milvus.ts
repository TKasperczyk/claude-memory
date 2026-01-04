/**
 * Milvus vector database operations for Claude Memory.
 */

import { DataType, MilvusClient, type RowData } from '@zilliz/milvus2-sdk-node'
import { embed } from './embed.js'
import {
  DEFAULT_CONFIG,
  EMBEDDING_DIM,
  type Config,
  type HybridSearchParams,
  type HybridSearchResult,
  type MemoryRecord,
  type RecordType
} from './types.js'

const CONTENT_MAX_LENGTH = 16384
const EXACT_TEXT_MAX_LENGTH = 4096
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
  'domain',
  'timestamp',
  'success_count',
  'failure_count',
  'retrieval_count',
  'usage_count',
  'last_used',
  'deprecated'
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
  config: Config = DEFAULT_CONFIG
): Promise<void> {
  try {
    await ensureClient(config)

    const row = await buildMilvusRow(record, config)

    await client!.insert({
      collection_name: config.milvus.collection,
      data: [row]
    })

    await flushAndWait(config.milvus.collection)
  } catch (error) {
    console.error('[claude-memory] insertRecord failed:', error)
    throw error
  }
}

export async function updateRecord(
  id: string,
  updates: Partial<MemoryRecord>,
  config: Config = DEFAULT_CONFIG
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

    await flushAndWait(config.milvus.collection)

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

    await flushAndWait(config.milvus.collection)

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
          rows.push(parseRecordFromRow(row as Record<string, unknown>))
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

    return (result.data ?? []).map(row => parseRecordFromRow(row as Record<string, unknown>))
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
      domain: params.domain,
      type: params.type,
      excludeDeprecated: params.excludeDeprecated
    })

    const combined = new Map<string, { record: MemoryRecord; similarity: number; keywordMatch: boolean }>()

    if (trimmedQuery.length > 0 && keywordWeight > 0) {
      const keywordFilter = buildKeywordFilter(trimmedQuery, baseFilter)
      const keywordResults = await client!.query({
        collection_name: config.milvus.collection,
        filter: keywordFilter,
        output_fields: OUTPUT_FIELDS,
        limit: keywordLimit
      })

      for (const row of keywordResults.data ?? []) {
        const record = parseRecordFromRow(row)
        combined.set(record.id, { record, similarity: 0, keywordMatch: true })
      }
    }

    if (vectorWeight > 0 && (params.embedding || trimmedQuery.length > 0)) {
      const vector = params.embedding ?? await embed(trimmedQuery, config)
      ensureEmbeddingDim(vector)

      const searchResults = await client!.search({
        collection_name: config.milvus.collection,
        data: [vector],
        limit: vectorLimit,
        filter: baseFilter,
        output_fields: OUTPUT_FIELDS,
        params: { nprobe: SEARCH_NPROBE }
      })

      for (const row of searchResults.results ?? []) {
        const similarity = row.score ?? 0
        if (similarity < minSimilarity) continue
        const record = parseRecordFromRow(row)
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
      excludeId: record.id
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
      .map(row => ({ record: parseRecordFromRow(row), similarity: row.score ?? 0 }))
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
      .map(row => ({ record: parseRecordFromRow(row), similarity: row.score ?? 0 }))
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
      { name: 'domain', data_type: DataType.VarChar, max_length: 64 },
      { name: 'timestamp', data_type: DataType.Int64 },
      { name: 'success_count', data_type: DataType.Int64 },
      { name: 'failure_count', data_type: DataType.Int64 },
      { name: 'retrieval_count', data_type: DataType.Int64 },
      { name: 'usage_count', data_type: DataType.Int64 },
      { name: 'last_used', data_type: DataType.Int64 },
      { name: 'deprecated', data_type: DataType.Bool },
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

async function buildMilvusRow(record: MemoryRecord, config: Config): Promise<RowData> {
  const normalized = normalizeRecord(record)
  const content = serializeRecord(normalized)
  if (content.length > CONTENT_MAX_LENGTH) {
    throw new Error(`Record content exceeds ${CONTENT_MAX_LENGTH} chars (id: ${normalized.id})`)
  }

  const exactTextRaw = buildExactText(normalized)
  const exactText = truncateString(exactTextRaw, EXACT_TEXT_MAX_LENGTH)

  const embedding = normalized.embedding
    ?? await embed(buildEmbeddingInput(normalized, exactTextRaw, content), config)
  ensureEmbeddingDim(embedding)

  return {
    id: normalized.id,
    type: normalized.type,
    content,
    exact_text: exactText,
    project: normalized.project ?? '',
    domain: normalized.domain ?? '',
    timestamp: toInt64(normalized.timestamp, Date.now()),
    success_count: toInt64(normalized.successCount, 0),
    failure_count: toInt64(normalized.failureCount, 0),
    retrieval_count: toInt64(normalized.retrievalCount, 0),
    usage_count: toInt64(normalized.usageCount, 0),
    last_used: toInt64(normalized.lastUsed, normalized.timestamp ?? Date.now()),
    deprecated: Boolean(normalized.deprecated),
    embedding
  }
}

function normalizeRecord(record: MemoryRecord): MemoryRecord {
  const project = record.project ?? resolveProject(record)
  const domain = record.domain ?? resolveDomain(record)
  const timestamp = toInt64(record.timestamp, Date.now())
  const successCount = toInt64(record.successCount, 0)
  const failureCount = toInt64(record.failureCount, 0)
  const retrievalCount = toInt64(record.retrievalCount, 0)
  const usageCount = toInt64(record.usageCount, 0)
  const lastUsed = toInt64(record.lastUsed, timestamp)
  const deprecated = Boolean(record.deprecated ?? false)

  return {
    ...record,
    project,
    domain,
    timestamp,
    successCount,
    failureCount,
    retrievalCount,
    usageCount,
    lastUsed,
    deprecated
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

function buildExactText(record: MemoryRecord): string {
  switch (record.type) {
    case 'command':
      return record.command
    case 'error':
      return record.errorText
    case 'discovery':
      return [record.what, record.where].filter(Boolean).join('\n')
    case 'procedure':
      return [record.name, ...record.steps].filter(Boolean).join('\n')
  }
}

function normalizeExactText(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
}

function isExactTextMatch(exactText: string, record: MemoryRecord): boolean {
  if (!exactText) return false
  const candidate = normalizeExactText(buildExactText(record))
  if (!candidate) return false
  return exactText === candidate
}

function buildEmbeddingInput(
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

function parseRecordFromRow(row: Record<string, unknown>): MemoryRecord {
  let parsed: Partial<MemoryRecord> = {}

  if (typeof row.content === 'string') {
    try {
      parsed = JSON.parse(row.content) as Partial<MemoryRecord>
    } catch (error) {
      console.error('[claude-memory] Failed to parse record content:', error)
    }
  }

  const type = (row.type as RecordType) ?? (parsed.type as RecordType)
  if (!type) {
    throw new Error('Record type missing in stored row')
  }

  const record = {
    ...parsed,
    id: String(row.id ?? parsed.id ?? ''),
    type,
    project: (row.project as string | undefined) ?? parsed.project,
    domain: (row.domain as string | undefined) ?? parsed.domain,
    timestamp: toInt64((row.timestamp as number | string | undefined) ?? parsed.timestamp, 0),
    successCount: toInt64((row.success_count as number | string | undefined) ?? parsed.successCount, 0),
    failureCount: toInt64((row.failure_count as number | string | undefined) ?? parsed.failureCount, 0),
    retrievalCount: toInt64((row.retrieval_count as number | string | undefined) ?? parsed.retrievalCount, 0),
    usageCount: toInt64((row.usage_count as number | string | undefined) ?? parsed.usageCount, 0),
    lastUsed: toInt64((row.last_used as number | string | undefined) ?? parsed.lastUsed, 0),
    deprecated: toBoolean(row.deprecated ?? parsed.deprecated, false)
  } as MemoryRecord

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
  const metaFields = new Set([
    'successCount',
    'failureCount',
    'retrievalCount',
    'usageCount',
    'lastUsed',
    'deprecated',
    'embedding'
  ])

  return Object.keys(updates).some(key => !metaFields.has(key))
}

function ensureEmbeddingDim(embedding: number[]): void {
  if (embedding.length !== EMBEDDING_DIM) {
    throw new Error(`Embedding dimension mismatch: expected ${EMBEDDING_DIM}, got ${embedding.length}`)
  }
}

export function escapeFilterValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function escapeLikeValue(value: string): string {
  const escapedWildcards = value.replace(/[%_]/g, '\\$&')
  return escapeFilterValue(escapedWildcards)
}

function buildFilter(filters: {
  project?: string
  domain?: string
  type?: RecordType
  excludeId?: string
  excludeDeprecated?: boolean
}): string | undefined {
  const parts: string[] = []

  if (filters.project) {
    parts.push(`project == "${escapeFilterValue(filters.project)}"`)
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
