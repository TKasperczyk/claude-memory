import { embed, ensureEmbeddingDim } from './embed.js'
import { buildExclusionReason } from './diagnostics.js'
import { createLogger } from './logger.js'
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
import { OUTPUT_FIELDS } from './lancedb-schema.js'
import { ensureClient, FTS_INDEX_COLUMN } from './lancedb-client.js'
import {
  buildEmbeddingInput,
  parseRecordFromRow,
  resolveProject
} from './lancedb-records.js'

const logger = createLogger('lancedb-search')

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
    const { table } = await ensureClient(config)

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
      ancestorProjects: params.ancestorProjects,
      linkedWorkspaces: params.linkedWorkspaces,
      includeGlobal: Boolean(params.project),
      onlySharedScopes: params.onlySharedScopes,
      type: params.type,
      excludeDeprecated: params.excludeDeprecated,
      maxTimestamp: params.maxTimestamp
    })

    const outputFields = params.includeEmbeddings
      ? [...OUTPUT_FIELDS, 'embedding']
      : OUTPUT_FIELDS

    const combined = new Map<string, { record: MemoryRecord; similarity: number; keywordMatch: boolean; bm25Score?: number }>()
    const nearMisses = diagnostic ? new Map<string, NearMissRecord>() : null

    const buildScoredRecord = (
      entry: { record: MemoryRecord; similarity: number; keywordMatch: boolean; bm25Score?: number }
    ): { scored: HybridSearchResult; relevance: number } => {
      const baseScore = (entry.keywordMatch ? keywordWeight : 0) + (entry.similarity * vectorWeight)
      const usageRatio = computeSmoothedUsageRatio(entry.record)
      const score = baseScore + (usageRatio * usageRatioWeight)
      return {
        relevance: baseScore,
        scored: {
          record: entry.record,
          similarity: entry.similarity,
          keywordMatch: entry.keywordMatch,
          ...(entry.bm25Score !== undefined ? { bm25Score: entry.bm25Score } : {}),
          score
        }
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

    const effectiveKeywordQueries = (params.keywordQueries ?? (trimmedQuery.length > 0 ? [trimmedQuery] : []))
      .filter(q => q.trim().length > 0)
    if (effectiveKeywordQueries.length > 0 && keywordWeight > 0) {
      if (abortSignal?.aborted) {
        throw new Error('Search aborted')
      }
      const extractBm25Score = (row: unknown): number | undefined => {
        const rawScore = (row as { _score?: unknown })?._score
        return typeof rawScore === 'number' && Number.isFinite(rawScore) ? rawScore : undefined
      }

      const addKeywordRecord = (record: MemoryRecord, bm25Score?: number): boolean => {
        const existing = combined.get(record.id)
        if (existing) {
          if (bm25Score !== undefined) {
            existing.bm25Score = Math.max(existing.bm25Score ?? 0, bm25Score)
          }
          return false
        }
        combined.set(record.id, {
          record,
          similarity: 0,
          keywordMatch: true,
          ...(bm25Score !== undefined ? { bm25Score } : {})
        })
        return true
      }

      const addKeywordRows = (rows: unknown[] | undefined): void => {
        for (const row of rows ?? []) {
          const record = parseRecordFromRow(row as Record<string, unknown>)
          if (!record) continue
          addKeywordRecord(record, extractBm25Score(row))
        }
      }

      const addInterleavedKeywordRows = (rowBatches: unknown[][], aggregateLimit: number): void => {
        let added = 0
        const maxBatchLength = Math.max(...rowBatches.map(rows => rows.length), 0)
        for (let rowIndex = 0; rowIndex < maxBatchLength && added < aggregateLimit; rowIndex++) {
          for (const rows of rowBatches) {
            if (added >= aggregateLimit) return
            const row = rows[rowIndex]
            if (!row) continue
            const record = parseRecordFromRow(row as Record<string, unknown>)
            if (!record) continue
            if (addKeywordRecord(record, extractBm25Score(row))) added++
          }
        }
      }

      const runKeywordQuery = async (needle: string, rowLimit: number): Promise<unknown[]> => {
        const query = table.query()
        const ftsCapable = query as typeof query & {
          fullTextSearch?: (q: string, options?: { columns?: string | string[] }) => typeof query
        }
        if (typeof ftsCapable.fullTextSearch === 'function') {
          try {
            let builder = ftsCapable.fullTextSearch(needle, { columns: [FTS_INDEX_COLUMN] })
            if (baseFilter) builder = builder.where(baseFilter)
            const rows = await builder
              .select([...outputFields, '_score'])
              .limit(rowLimit)
              .toArray()
            return rows ?? []
          } catch (ftsError) {
            logger.debug(`LanceDB BM25 FTS failed for "${needle.slice(0, 60)}", falling back to SQL LIKE:`, ftsError)
            const fallbackFilter = buildKeywordFilter(needle, baseFilter)
            const fallbackRows = await table
              .query()
              .where(fallbackFilter)
              .select(outputFields)
              .limit(rowLimit)
              .toArray()
            return fallbackRows ?? []
          }
        }
        const keywordFilter = buildKeywordFilter(needle, baseFilter)
        const keywordRows = await query
          .where(keywordFilter)
          .select(outputFields)
          .limit(rowLimit)
          .toArray()
        return keywordRows ?? []
      }

      if (effectiveKeywordQueries.length === 1) {
        const keywordRows = await runKeywordQuery(effectiveKeywordQueries[0], keywordLimit)
        addKeywordRows(keywordRows)
      } else {
        const keywordRowBatches: unknown[][] = []
        // Fetch a per-needle window, then spend the aggregate keywordLimit by
        // interleaving unique rows so broad needles cannot starve rare ones.
        const perNeedleLimit = Math.max(1, Math.ceil(keywordLimit / effectiveKeywordQueries.length))
        for (const keywordQuery of effectiveKeywordQueries) {
          if (abortSignal?.aborted) {
            throw new Error('Search aborted')
          }
          const keywordRows = await runKeywordQuery(keywordQuery, perNeedleLimit)
          keywordRowBatches.push(keywordRows)
        }
        addInterleavedKeywordRows(keywordRowBatches, keywordLimit)
      }
    }

    if (vectorWeight > 0 && (params.embedding || trimmedQuery.length > 0)) {
      if (abortSignal?.aborted) {
        throw new Error('Search aborted')
      }
      const vector = params.embedding ?? await embed(trimmedQuery, config, { signal: abortSignal })
      ensureEmbeddingDim(vector)

      const vq = table
        .vectorSearch(vector)
        .distanceType('cosine')
      if (baseFilter) vq.where(baseFilter)
      vq.select([...outputFields, '_distance'])
	      vq.limit(vectorLimit)
	      const vectorRows = await vq.toArray()

	      for (const row of vectorRows ?? []) {
	        const rawDistance = (row as any)._distance
	        if (typeof rawDistance !== 'number' || !Number.isFinite(rawDistance)) {
	          logger.debug(`Skipping vector search row with missing/invalid _distance: ${String(rawDistance)}`)
	          continue
	        }
	        const similarity = 1 - rawDistance

	        if (similarity < minSimilarity) {
	          if (diagnostic) {
	            const record = parseRecordFromRow(row as Record<string, unknown>)
	            if (!record) continue
            if (!combined.has(record.id)) {
              const { scored } = buildScoredRecord({ record, similarity, keywordMatch: false })
              addNearMiss(
                scored,
                buildExclusionReason('similarity_below_threshold', minSimilarity, similarity)
              )
            }
          }
          continue
        }

        const record = parseRecordFromRow(row as Record<string, unknown>)
        if (!record) continue
        const existing = combined.get(record.id)
        if (existing) {
          existing.similarity = Math.max(existing.similarity, similarity)
        } else {
          combined.set(record.id, { record, similarity, keywordMatch: false })
        }
      }
    }

    const scoredEntries = Array.from(combined.values()).map(buildScoredRecord)

    scoredEntries.sort((a, b) => {
      if (b.scored.score !== a.scored.score) return b.scored.score - a.scored.score
      return b.scored.similarity - a.scored.similarity
    })

    if (diagnostic && shouldApplyMinScore) {
      for (const entry of scoredEntries) {
        if (entry.relevance < minScore) {
          addNearMiss(
            entry.scored,
            buildExclusionReason('score_below_threshold', minScore, entry.relevance)
          )
        }
      }
    }

    // Gate strictly on query-document relevance; smoothed utility only nudges ordering among survivors.
    const qualified = scoredEntries
      .filter(entry => !shouldApplyMinScore || entry.relevance >= minScore)
      .slice(0, limit)
      .map(entry => entry.scored)

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
  extraFilter?: string,
  options?: { crossType?: boolean; includeSharedScopes?: boolean }
): Promise<Array<{ record: MemoryRecord; similarity: number }>> {
  try {
    const { table } = await ensureClient(config)

    const vector = record.embedding ?? await embed(buildEmbeddingInput(record), config)
    ensureEmbeddingDim(vector)

    const project = resolveProject(record)
    const baseFilter = buildFilter({
      project,
      includeGlobal: options?.includeSharedScopes === true,
      onlySharedScopes: options?.includeSharedScopes === true && !project,
      type: options?.crossType === true ? undefined : record.type,
      excludeId: record.id,
      excludeDeprecated: true
    })
    const filterParts = [baseFilter, extraFilter]
      .filter((part): part is string => Boolean(part && part.trim()))
    const filter = filterParts.length > 0 ? filterParts.join(' AND ') : undefined

    const vq = table.vectorSearch(vector).distanceType('cosine')
    if (filter) vq.where(filter)
    vq.select([...OUTPUT_FIELDS, '_distance'])
    vq.limit(limit)

	    const rows = await vq.toArray()

	    const matches: Array<{ record: MemoryRecord; similarity: number }> = []
	    for (const row of rows ?? []) {
	      const rawDistance = (row as any)._distance
	      if (typeof rawDistance !== 'number' || !Number.isFinite(rawDistance)) {
	        logger.debug(`Skipping findSimilar row with missing/invalid _distance: ${String(rawDistance)}`)
	        continue
	      }
	      const similarity = 1 - rawDistance
	      if (similarity < similarityThreshold) continue
	      const record = parseRecordFromRow(row as Record<string, unknown>)
	      if (!record) continue
	      matches.push({ record, similarity })
	    }

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
    const { table } = await ensureClient(config)
    ensureEmbeddingDim(embedding)

    const limit = options.limit ?? 10
    const similarityThreshold = options.similarityThreshold ?? 0

    const vq = table.vectorSearch(embedding).distanceType('cosine')
    if (options.filter) vq.where(options.filter)
    vq.select([...OUTPUT_FIELDS, '_distance'])
    vq.limit(limit)

	    const rows = await vq.toArray()

	    const matches: Array<{ record: MemoryRecord; similarity: number }> = []
	    for (const row of rows ?? []) {
	      const rawDistance = (row as any)._distance
	      if (typeof rawDistance !== 'number' || !Number.isFinite(rawDistance)) {
	        logger.debug(`Skipping vectorSearchSimilar row with missing/invalid _distance: ${String(rawDistance)}`)
	        continue
	      }
	      const similarity = 1 - rawDistance
	      if (similarity < similarityThreshold) continue
	      const record = parseRecordFromRow(row as Record<string, unknown>)
	      if (!record) continue
	      matches.push({ record, similarity })
	    }

	    matches.sort((a, b) => b.similarity - a.similarity)
	    return matches
	  } catch (error) {
    console.error('[claude-memory] vectorSearchSimilar failed:', error)
    throw error
  }
}

export async function bm25Search(
  params: {
    query: string
    limit?: number
    project?: string
    ancestorProjects?: string[]
    linkedWorkspaces?: string[]
    includeGlobal?: boolean
    onlySharedScopes?: boolean
    type?: RecordType
    types?: RecordType[]
    excludeDeprecated?: boolean
    maxTimestamp?: number
    includeEmbeddings?: boolean
    signal?: AbortSignal
  },
  config: Config = DEFAULT_CONFIG
): Promise<HybridSearchResult[]> {
  const trimmed = params.query.trim()
  if (!trimmed) return []
  if (params.signal?.aborted) {
    throw new Error('Search aborted')
  }

  const { table } = await ensureClient(config)
  const limit = Math.max(1, params.limit ?? 20)
  const baseFilter = buildFilter({
    project: params.project,
    ancestorProjects: params.ancestorProjects,
    linkedWorkspaces: params.linkedWorkspaces,
    includeGlobal: params.includeGlobal ?? Boolean(params.project),
    onlySharedScopes: params.onlySharedScopes,
    type: params.type,
    types: params.types,
    excludeDeprecated: params.excludeDeprecated ?? true,
    maxTimestamp: params.maxTimestamp
  })
  const outputFields = params.includeEmbeddings
    ? [...OUTPUT_FIELDS, 'embedding']
    : OUTPUT_FIELDS

  const query = table.query()
  const ftsCapable = query as typeof query & {
    fullTextSearch?: (q: string, options?: { columns?: string | string[] }) => typeof query
  }

  let rows: unknown[] = []
  if (typeof ftsCapable.fullTextSearch === 'function') {
    try {
      let builder = ftsCapable.fullTextSearch(trimmed, { columns: [FTS_INDEX_COLUMN] })
      if (baseFilter) builder = builder.where(baseFilter)
      rows = (await builder
        .select([...outputFields, '_score'])
        .limit(limit)
        .toArray()) ?? []
    } catch (error) {
      logger.debug(`bm25Search FTS failed for "${trimmed.slice(0, 60)}", falling back to SQL LIKE:`, error)
      const fallbackFilter = buildKeywordFilter(trimmed, baseFilter)
      rows = (await table
        .query()
        .where(fallbackFilter)
        .select(outputFields)
        .limit(limit)
        .toArray()) ?? []
    }
  } else {
    const keywordFilter = buildKeywordFilter(trimmed, baseFilter)
    rows = (await query
      .where(keywordFilter)
      .select(outputFields)
      .limit(limit)
      .toArray()) ?? []
  }

  const results: HybridSearchResult[] = []
  for (const row of rows) {
    const record = parseRecordFromRow(row as Record<string, unknown>)
    if (!record) continue
    const rawScore = (row as { _score?: unknown })?._score
    const bm25Score = typeof rawScore === 'number' && Number.isFinite(rawScore) ? rawScore : 1
    results.push({
      record,
      similarity: 0,
      keywordMatch: true,
      bm25Score,
      score: bm25Score
    })
  }
  return results
}

export function escapeLikeValue(value: string): string {
  // Escape SQL LIKE wildcards. We also escape backslashes since we use backslash as the escape char.
  const escapedSlashes = value.replace(/\\/g, '\\\\')
  const escapedWildcards = escapedSlashes.replace(/[%_]/g, '\\$&')
  return escapeFilterValue(escapedWildcards)
}

export function buildFilter(filters: {
  project?: string
  ancestorProjects?: string[]
  linkedWorkspaces?: string[]
  includeGlobal?: boolean
  includeEnvironment?: boolean
  onlySharedScopes?: boolean
  type?: RecordType
  types?: RecordType[]
  excludeId?: string
  excludeDeprecated?: boolean
  maxTimestamp?: number
}): string | undefined {
  const parts: string[] = []
  const includeEnv = filters.includeEnvironment ?? filters.includeGlobal

  if (filters.project) {
    const allProjects = Array.from(new Set([
      filters.project,
      ...(filters.ancestorProjects ?? []),
      ...(filters.linkedWorkspaces ?? [])
    ].filter(Boolean)))
    const projectClause = allProjects.length === 1
      ? `project = '${escapeFilterValue(allProjects[0])}'`
      : `project IN (${allProjects.map(p => `'${escapeFilterValue(p)}'`).join(', ')})`
    if (filters.includeGlobal && includeEnv) {
      parts.push(`(${projectClause} OR scope = 'global' OR scope = 'environment')`)
    } else if (filters.includeGlobal) {
      parts.push(`(${projectClause} OR scope = 'global')`)
    } else if (includeEnv) {
      parts.push(`(${projectClause} OR scope = 'environment')`)
    } else {
      parts.push(projectClause)
    }
  } else if (filters.onlySharedScopes) {
    parts.push(filters.includeEnvironment !== false ? `(scope = 'global' OR scope = 'environment')` : `scope = 'global'`)
  }

  if (filters.type) {
    parts.push(`type = '${escapeFilterValue(filters.type)}'`)
  } else if (filters.types && filters.types.length > 0) {
    const uniqueTypes = Array.from(new Set(filters.types))
    parts.push(
      uniqueTypes.length === 1
        ? `type = '${escapeFilterValue(uniqueTypes[0])}'`
        : `type IN (${uniqueTypes.map(t => `'${escapeFilterValue(t)}'`).join(', ')})`
    )
  }

  if (filters.excludeId) {
    parts.push(`id <> '${escapeFilterValue(filters.excludeId)}'`)
  }

  if (filters.excludeDeprecated) {
    parts.push('deprecated = false')
  }

  if (typeof filters.maxTimestamp === 'number' && Number.isFinite(filters.maxTimestamp)) {
    parts.push(`timestamp < ${Math.trunc(filters.maxTimestamp)}`)
  }

  if (parts.length === 0) return undefined
  return parts.join(' AND ')
}

export function buildKeywordFilter(query: string | string[], baseFilter?: string): string {
  const queries = Array.isArray(query) ? query : [query]
  const likeClauses = queries
    .filter(q => q.trim().length > 0)
    .map(q => {
      const escaped = escapeLikeValue(q)
      return `lower(exact_text) LIKE lower('%${escaped}%') ESCAPE '\\'`
    })
  if (likeClauses.length === 0) {
    return baseFilter ?? '1=1'
  }
  const keywordClause = likeClauses.length === 1 ? likeClauses[0] : `(${likeClauses.join(' OR ')})`
  if (!baseFilter) return keywordClause
  return `${baseFilter} AND ${keywordClause}`
}

const USAGE_BAYES_PRIOR_MEAN = 0.1
const USAGE_BAYES_PRIOR_STRENGTH = 5

export function computeUsageRatio(record: MemoryRecord): number {
  const retrievalCount = record.retrievalCount ?? 0
  const usageCount = record.usageCount ?? 0
  if (usageCount <= 0) return 0
  return Math.min(usageCount / Math.max(retrievalCount, 1), 1)
}

/**
 * Empirical-Bayes smoothed utility: (usage + m * p0) / (retrievals + m).
 * Prevents small-sample lucky records (1/1 -> 1.0) from dominating while
 * keeping unseen records (0/0 -> p0) neutral instead of penalized to 0.
 */
export function computeSmoothedUsageRatio(record: MemoryRecord): number {
  const retrievalCount = Math.max(0, record.retrievalCount ?? 0)
  const usageCount = Math.max(0, record.usageCount ?? 0)
  const effectiveRetrievals = Math.max(retrievalCount, usageCount)
  const smoothed = (usageCount + USAGE_BAYES_PRIOR_STRENGTH * USAGE_BAYES_PRIOR_MEAN)
    / (effectiveRetrievals + USAGE_BAYES_PRIOR_STRENGTH)
  return Math.max(0, Math.min(smoothed, 1))
}
