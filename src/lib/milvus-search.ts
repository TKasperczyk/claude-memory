import { ConsistencyLevelEnum } from '@zilliz/milvus2-sdk-node'
import { embed, ensureEmbeddingDim } from './embed.js'
import { buildExclusionReason } from './diagnostics.js'
import { escapeFilterValue } from './shared.js'
import {
  DEFAULT_CONFIG,
  SIMILARITY_THRESHOLDS,
  type Config,
  type DiagnosticSearchResults,
  type ExclusionReason,
  type HybridSearchParams,
  type HybridSearchParamsWithDiagnostic,
  type HybridSearchParamsWithoutDiagnostic,
  type HybridSearchResult,
  type NearMissRecord,
  type MemoryRecord,
  type RecordType
} from './types.js'
import { OUTPUT_FIELDS } from './milvus-schema.js'
import { ensureClient } from './milvus-client.js'
import {
  buildEmbeddingInput,
  parseRecordFromRow,
  resolveDomain,
  resolveProject
} from './milvus-records.js'

const SEARCH_NPROBE = 64

export async function hybridSearch(
  params: HybridSearchParamsWithDiagnostic,
  config?: Config
): Promise<DiagnosticSearchResults>
export async function hybridSearch(
  params: HybridSearchParamsWithoutDiagnostic,
  config?: Config
): Promise<HybridSearchResult[]>
export async function hybridSearch(
  params: HybridSearchParams,
  config?: Config
): Promise<HybridSearchResult[] | DiagnosticSearchResults>
export async function hybridSearch(
  params: HybridSearchParams,
  config: Config = DEFAULT_CONFIG
): Promise<HybridSearchResult[] | DiagnosticSearchResults> {
  try {
    const client = await ensureClient(config)

    const abortSignal = params.signal
    if (abortSignal?.aborted) {
      throw new Error('Search aborted')
    }

    const diagnostic = Boolean(params.diagnostic)
    const trimmedQuery = params.query.trim()
    const limit = params.limit ?? 10
    const vectorWeight = params.vectorWeight ?? 0.7
    const keywordWeight = params.keywordWeight ?? 0.3
    const minSimilarity = params.minSimilarity ?? 0
    const minScore = params.minScore ?? 0.45
    const usageRatioWeight = params.usageRatioWeight ?? 0.2
    const diagnosticLimit = diagnostic ? Math.max(limit * 3, limit + 20) : limit
    const vectorLimitBase = params.vectorLimit ?? limit
    const keywordLimitBase = params.keywordLimit ?? limit
    const vectorLimit = diagnostic ? Math.max(vectorLimitBase, diagnosticLimit) : vectorLimitBase
    const keywordLimit = diagnostic ? Math.max(keywordLimitBase, diagnosticLimit) : keywordLimitBase
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
    const nearMisses = diagnostic ? new Map<string, NearMissRecord>() : null

    const buildScoredRecord = (
      entry: { record: MemoryRecord; similarity: number; keywordMatch: boolean }
    ): HybridSearchResult => {
      const baseScore = (entry.keywordMatch ? keywordWeight : 0) + (entry.similarity * vectorWeight)
      const usageRatio = computeUsageRatio(entry.record)
      const score = baseScore + (usageRatio * usageRatioWeight)
      return {
        record: entry.record,
        similarity: entry.similarity,
        keywordMatch: entry.keywordMatch,
        score
      }
    }

    const addNearMiss = (record: HybridSearchResult, reason: ExclusionReason): void => {
      if (!nearMisses) return
      const existing = nearMisses.get(record.record.id)
      if (existing) {
        existing.exclusionReasons.push(reason)
        return
      }
      nearMisses.set(record.record.id, { record, exclusionReasons: [reason] })
    }

    if (trimmedQuery.length > 0 && keywordWeight > 0) {
      if (abortSignal?.aborted) {
        throw new Error('Search aborted')
      }
      const keywordFilter = buildKeywordFilter(trimmedQuery, baseFilter)
      const keywordResults = await client.query({
        collection_name: config.milvus.collection,
        filter: keywordFilter,
        output_fields: outputFields,
        limit: keywordLimit,
        consistency_level: ConsistencyLevelEnum.Strong
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

      const searchResults = await client.search({
        collection_name: config.milvus.collection,
        data: [vector],
        limit: vectorLimit,
        filter: baseFilter,
        output_fields: outputFields,
        params: { nprobe: SEARCH_NPROBE },
        consistency_level: ConsistencyLevelEnum.Strong
      })

      for (const row of searchResults.results ?? []) {
        const similarity = row.score ?? 0
        if (similarity < minSimilarity) {
          if (diagnostic) {
            const record = parseRecordFromRow(row)
            if (!record) continue
            if (!combined.has(record.id)) {
              const scored = buildScoredRecord({ record, similarity, keywordMatch: false })
              addNearMiss(
                scored,
                buildExclusionReason('similarity_below_threshold', minSimilarity, similarity)
              )
            }
          }
          continue
        }
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

    const results: HybridSearchResult[] = Array.from(combined.values()).map(buildScoredRecord)

    results.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return b.similarity - a.similarity
    })

    if (diagnostic && shouldApplyMinScore) {
      for (const result of results) {
        if (result.score < minScore && !result.keywordMatch) {
          addNearMiss(
            result,
            buildExclusionReason('semantic_only_score_below_threshold', minScore, result.score)
          )
        }
      }
    }

    const qualified = results
      .filter(r => !shouldApplyMinScore || r.keywordMatch || r.score >= minScore)
      .slice(0, limit)

    if (diagnostic) {
      for (const result of qualified) {
        nearMisses?.delete(result.record.id)
      }
      return {
        qualified,
        nearMisses: Array.from(nearMisses?.values() ?? [])
      }
    }

    return qualified
  } catch (error) {
    console.error('[claude-memory] hybridSearch failed:', error)
    throw error
  }
}

export async function findSimilar(
  record: MemoryRecord,
  similarityThreshold: number = SIMILARITY_THRESHOLDS.EXTRACTION_DEDUP,
  limit: number = 5,
  config: Config = DEFAULT_CONFIG,
  extraFilter?: string
): Promise<Array<{ record: MemoryRecord; similarity: number }>> {
  try {
    const client = await ensureClient(config)

    const vector = record.embedding ?? await embed(buildEmbeddingInput(record), config)
    ensureEmbeddingDim(vector)

    const baseFilter = buildFilter({
      project: resolveProject(record),
      domain: resolveDomain(record),
      type: record.type,
      excludeId: record.id,
      excludeDeprecated: true
    })
    const filterParts = [baseFilter, extraFilter]
      .filter((part): part is string => Boolean(part && part.trim()))
    const filter = filterParts.length > 0 ? filterParts.join(' && ') : undefined

    const searchResults = await client.search({
      collection_name: config.milvus.collection,
      data: [vector],
      limit,
      filter,
      output_fields: OUTPUT_FIELDS,
      params: { nprobe: SEARCH_NPROBE },
      consistency_level: ConsistencyLevelEnum.Strong
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
    const client = await ensureClient(config)
    ensureEmbeddingDim(embedding)

    const limit = options.limit ?? 10
    const similarityThreshold = options.similarityThreshold ?? 0

    const searchResults = await client.search({
      collection_name: config.milvus.collection,
      data: [embedding],
      limit,
      filter: options.filter,
      output_fields: OUTPUT_FIELDS,
      params: { nprobe: SEARCH_NPROBE },
      consistency_level: ConsistencyLevelEnum.Strong
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

export function escapeLikeValue(value: string): string {
  const escapedWildcards = value.replace(/[%_]/g, '\\$&')
  return escapeFilterValue(escapedWildcards)
}

export function buildFilter(filters: {
  project?: string
  includeGlobal?: boolean
  domain?: string
  type?: RecordType
  excludeId?: string
  excludeDeprecated?: boolean
}): string | undefined {
  const parts: string[] = []

  // Build scope-sensitive filters (project + domain) that global scope bypasses
  const scopeParts: string[] = []

  if (filters.project) {
    scopeParts.push(`project == "${escapeFilterValue(filters.project)}"`)
  }

  if (filters.domain) {
    const domainValue = escapeFilterValue(filters.domain)
    scopeParts.push(`(domain == "${domainValue}" || domain == "")`)
  }

  if (scopeParts.length > 0) {
    const scopeClause = scopeParts.join(' && ')
    if (filters.includeGlobal) {
      // Global scope bypasses both project AND domain filters
      parts.push(`(${scopeClause} || scope == "global")`)
    } else {
      parts.push(scopeClause)
    }
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

export function buildKeywordFilter(query: string, baseFilter?: string): string {
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
