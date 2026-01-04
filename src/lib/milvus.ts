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

    await client!.flush({
      collection_names: [config.milvus.collection]
    })
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

    await client!.flush({
      collection_names: [config.milvus.collection]
    })

    return true
  } catch (error) {
    console.error('[claude-memory] updateRecord failed:', error)
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

    await client!.flush({
      collection_names: [config.milvus.collection]
    })
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
    const vectorLimit = params.vectorLimit ?? limit
    const keywordLimit = params.keywordLimit ?? limit

    const baseFilter = buildFilter({
      project: params.project,
      domain: params.domain,
      type: params.type
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
      const score = (entry.keywordMatch ? keywordWeight : 0) + (entry.similarity * vectorWeight)
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

    return results.slice(0, limit)
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

    const exactText = normalizeExactText(buildExactText(record))
    const matches = (searchResults.results ?? [])
      .map(row => ({ record: parseRecordFromRow(row), similarity: row.score ?? 0 }))
      .filter(result => result.similarity >= similarityThreshold)
      .filter(result => exactText.length > 0 && isExactTextMatch(exactText, result.record))

    matches.sort((a, b) => b.similarity - a.similarity)
    return matches
  } catch (error) {
    console.error('[claude-memory] findSimilar failed:', error)
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
  const lastUsed = toInt64(record.lastUsed, timestamp)
  const deprecated = Boolean(record.deprecated ?? false)

  return {
    ...record,
    project,
    domain,
    timestamp,
    successCount,
    failureCount,
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

function escapeFilterValue(value: string): string {
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

  if (parts.length === 0) return undefined
  return parts.join(' && ')
}

function buildKeywordFilter(query: string, baseFilter?: string): string {
  const escaped = escapeLikeValue(query)
  const likeClause = `exact_text like "%${escaped}%"`
  if (!baseFilter) return likeClause
  return `${baseFilter} && ${likeClause}`
}
