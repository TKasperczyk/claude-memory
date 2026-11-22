import { buildExclusionReason, mergeNearMisses } from './diagnostics.js'
import { computeUsageRatio, hybridSearch } from './lancedb.js'
import type { RetrievalSettings } from './settings.js'
import type {
  Config,
  DiagnosticSearchResults,
  HybridSearchParams,
  HybridSearchResult,
  NearMissRecord,
  RecordType
} from './types.js'

/**
 * Fixed weight for semantic similarity in the unified scoring formula.
 * Not user-configurable because changing it would shift the meaning of
 * minScore and other thresholds that depend on this scale.
 */
export const UNIFIED_SEMANTIC_WEIGHT = 0.7

export interface UnifiedScoreInputs {
  similarity: number
  keywordMatch: boolean
  usageRatio: number
  projectMatch: boolean
  settings: Pick<RetrievalSettings, 'keywordBonus' | 'minSemanticSimilarity' | 'usageRatioWeight' | 'projectMatchBonus'>
}

export interface UnifiedScoreBreakdown {
  semantic: number
  keywordBonus: number
  usage: number
  projectBoost: number
  total: number
}

export function computeUnifiedScore(inputs: UnifiedScoreInputs): UnifiedScoreBreakdown {
  const { similarity, keywordMatch, usageRatio, projectMatch, settings } = inputs
  const similarityScale = settings.minSemanticSimilarity > 0
    ? Math.min(similarity / settings.minSemanticSimilarity, 1.0)
    : 1.0
  const semantic = similarity * UNIFIED_SEMANTIC_WEIGHT
  const keywordBonus = keywordMatch ? settings.keywordBonus * similarityScale : 0
  const usage = usageRatio * settings.usageRatioWeight
  const projectBoost = projectMatch ? settings.projectMatchBonus : 0
  return {
    semantic,
    keywordBonus,
    usage,
    projectBoost,
    total: semantic + keywordBonus + usage + projectBoost
  }
}

export interface RankedCandidateSearchResult {
  results: HybridSearchResult[]
  nearMisses: NearMissRecord[]
  rawKeywordMatchIds: Set<string>
  rawKeywordQualificationScores: Map<string, number>
}

export interface RankedCandidateSearchOptions {
  rawKeywordQueries: string[]
  plannedKeywordQueries?: string[]
  config: Config
  settings: RetrievalSettings
  project?: string
  ancestorProjects?: string[]
  /** Omit for cross-project semantic recall; set to project for a hard semantic scope. */
  semanticProject?: string
  semanticAncestorProjects?: string[]
  embeddings?: number[][]
  rawPromptEmbedding?: number[]
  type?: RecordType
  excludeDeprecated?: boolean
  /** Per-channel candidate window fetched before merging and unified scoring. */
  sourceLimit: number
  /** Number of ranked candidates returned after unified score filtering. */
  resultLimit: number
  signal?: AbortSignal
  diagnostic?: boolean
}

async function runHybridSearch(
  params: HybridSearchParams,
  config: Config,
  diagnostic: boolean
): Promise<{ results: HybridSearchResult[]; nearMisses: NearMissRecord[] }> {
  const response = await hybridSearch(
    diagnostic ? { ...params, diagnostic: true } : params,
    config
  )
  if (diagnostic) {
    const diagnosticResponse = response as DiagnosticSearchResults
    return { results: diagnosticResponse.qualified, nearMisses: diagnosticResponse.nearMisses }
  }
  return { results: response as HybridSearchResult[], nearMisses: [] }
}

/**
 * Fetch keyword and semantic candidates independently, recompute real cosine
 * similarity for keyword-only hits, and rank every candidate on one scale.
 * Hook-only policies such as suppression, semantic anchoring, relations, and
 * MMR deliberately live above this service.
 */
export async function searchRankedCandidates(
  options: RankedCandidateSearchOptions
): Promise<RankedCandidateSearchResult> {
  const {
    rawKeywordQueries,
    plannedKeywordQueries = [],
    config,
    settings,
    project,
    ancestorProjects = [],
    semanticProject,
    semanticAncestorProjects = [],
    embeddings = [],
    rawPromptEmbedding,
    type,
    sourceLimit,
    resultLimit,
    signal
  } = options
  const excludeDeprecated = options.excludeDeprecated ?? true
  const diagnostic = options.diagnostic === true
  const resultsById = new Map<string, HybridSearchResult>()
  const rawKeywordMatchIds = new Set<string>()
  const rawKeywordQualificationScores = new Map<string, number>()
  const nearMisses = diagnostic ? new Map<string, NearMissRecord>() : null

  console.error(`[claude-memory] Search scope: keywords=${rawKeywordQueries.length + plannedKeywordQueries.length}, project=${project ?? 'none'}${ancestorProjects.length ? `, ancestors=${ancestorProjects.join(',')}` : ''}`)

  const upsertResult = (item: HybridSearchResult): void => {
    const existing = resultsById.get(item.record.id)
    if (existing) {
      existing.similarity = Math.max(existing.similarity, item.similarity)
      existing.score = Math.max(existing.score, item.score)
      existing.keywordMatch = existing.keywordMatch || item.keywordMatch
    } else {
      resultsById.set(item.record.id, item)
    }
  }

  const keywordSearches = [
    { queries: rawKeywordQueries, raw: true },
    { queries: plannedKeywordQueries, raw: false }
  ].filter(search => search.queries.length > 0)
  const keywordResultSets = await Promise.all(keywordSearches.map(async search => ({
    ...search,
    result: await runHybridSearch({
      query: search.queries[0],
      keywordQueries: search.queries,
      limit: sourceLimit,
      project,
      ancestorProjects,
      type,
      excludeDeprecated,
      vectorWeight: 0,
      keywordWeight: 1,
      keywordLimit: sourceLimit * search.queries.length,
      usageRatioWeight: settings.usageRatioWeight,
      includeEmbeddings: true,
      signal
    }, config, diagnostic)
  })))
  for (const keywordResults of keywordResultSets) {
    for (const item of keywordResults.result.results) {
      upsertResult(item)
      if (keywordResults.raw) rawKeywordMatchIds.add(item.record.id)
    }
    if (diagnostic && nearMisses) {
      mergeNearMisses(nearMisses, keywordResults.result.nearMisses)
    }
  }

  if (embeddings.length > 0) {
    const semanticResultSets = await Promise.all(
      embeddings.map(embedding => runHybridSearch({
        query: '',
        embedding,
        limit: sourceLimit,
        project: semanticProject,
        ancestorProjects: semanticAncestorProjects,
        type,
        excludeDeprecated,
        vectorWeight: 1,
        keywordWeight: 0,
        minSimilarity: settings.minSemanticSimilarity,
        minScore: settings.minSemanticOnlyScore,
        usageRatioWeight: settings.usageRatioWeight,
        includeEmbeddings: true,
        signal
      }, config, diagnostic))
    )
    for (const semanticResults of semanticResultSets) {
      for (const item of semanticResults.results) {
        upsertResult(item)
      }
      if (diagnostic && nearMisses) {
        mergeNearMisses(nearMisses, semanticResults.nearMisses)
      }
    }
  }

  const allCandidates = Array.from(resultsById.values())

  // Whichever query embeddings succeeded. Keyword hits must be rescored
  // against them: their raw keyword score (~1.0) carries no semantic signal,
  // and keeping it let generic fallback needles ("other", "currently") inject
  // unrelated records whenever only some embeddings came back.
  const scoringEmbeddings = embeddings.length > 0
    ? embeddings
    : rawPromptEmbedding ? [rawPromptEmbedding] : []
  if (scoringEmbeddings.length > 0) {
    for (const item of allCandidates) {
      const candidateEmbedding = item.record.embedding
      if (item.similarity === 0 && item.keywordMatch && candidateEmbedding && candidateEmbedding.length > 0) {
        item.similarity = maxCosineSimilarity(scoringEmbeddings, candidateEmbedding)
      }
      const rankingScore = computeUnifiedScore({
        similarity: item.similarity,
        keywordMatch: item.keywordMatch,
        usageRatio: computeUsageRatio(item.record),
        projectMatch: Boolean(project && item.record.project === project),
        settings
      }).total

      if (!rawKeywordMatchIds.has(item.record.id)) {
        item.score = rankingScore
        continue
      }

      let qualificationScore = rankingScore
      if (rawPromptEmbedding && candidateEmbedding && candidateEmbedding.length > 0) {
        const rawSimilarity = cosineSimilarity(rawPromptEmbedding, candidateEmbedding)
        qualificationScore = computeUnifiedScore({
          similarity: rawSimilarity,
          keywordMatch: true,
          usageRatio: computeUsageRatio(item.record),
          projectMatch: Boolean(project && item.record.project === project),
          settings
        }).total
        item.similarity = Math.max(item.similarity, rawSimilarity)
      }
      rawKeywordQualificationScores.set(item.record.id, qualificationScore)
      item.score = Math.max(rankingScore, qualificationScore)
    }
  }
  // Explicit fail-open path: without a query embedding, keyword candidates
  // retain their raw exact-match/usage scores and remain searchable.

  if (diagnostic && nearMisses) {
    for (const item of allCandidates) {
      if (item.score < settings.minScore) {
        nearMisses.set(item.record.id, {
          record: item,
          exclusionReasons: [buildExclusionReason('score_below_threshold', settings.minScore, item.score)]
        })
      }
    }
  }

  const rankedResults = sortByScore(
    allCandidates.filter(result => result.score >= settings.minScore)
  ).slice(0, resultLimit)
  if (diagnostic && nearMisses) {
    for (const result of rankedResults) {
      nearMisses.delete(result.record.id)
    }
  }

  return {
    results: rankedResults,
    nearMisses: Array.from(nearMisses?.values() ?? []),
    rawKeywordMatchIds,
    rawKeywordQualificationScores
  }
}

export function sortByScore(candidates: HybridSearchResult[]): HybridSearchResult[] {
  return [...candidates].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return b.similarity - a.similarity
  })
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0

  let dotProduct = 0
  let normA = 0
  let normB = 0

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB)
  if (denominator === 0) return 0

  return dotProduct / denominator
}

function maxCosineSimilarity(queries: number[][], candidate: number[]): number {
  let maxSimilarity = 0
  for (const query of queries) {
    maxSimilarity = Math.max(maxSimilarity, cosineSimilarity(query, candidate))
  }
  return maxSimilarity
}
