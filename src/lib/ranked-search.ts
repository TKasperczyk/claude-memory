import { buildExclusionReason, mergeNearMisses } from './diagnostics.js'
import { hybridSearch } from './lancedb.js'
import type { RetrievalSettings } from './settings.js'
import type {
  Config,
  DiagnosticSearchResults,
  HybridSearchParams,
  HybridSearchResult,
  MemoryRecord,
  NearMissRecord,
  RecordType
} from './types.js'

const USAGE_BAYES_PRIOR_MEAN = 0.1
const USAGE_BAYES_PRIOR_STRENGTH = 5

function computeSmoothedUtility(record: MemoryRecord): number {
  const retrievalCount = Math.max(0, record.retrievalCount ?? 0)
  const usageCount = Math.max(0, record.usageCount ?? 0)
  const effectiveRetrievals = Math.max(retrievalCount, usageCount)
  const smoothed = (usageCount + USAGE_BAYES_PRIOR_STRENGTH * USAGE_BAYES_PRIOR_MEAN)
    / (effectiveRetrievals + USAGE_BAYES_PRIOR_STRENGTH)
  return Math.max(0, Math.min(smoothed, 1))
}

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
  /** Pure query-document relevance used for admission gating (decoupled from usage/project nudges). */
  relevance: number
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
  const relevance = semantic + keywordBonus
  const usage = usageRatio * settings.usageRatioWeight
  const projectBoost = projectMatch ? settings.projectMatchBonus : 0
  return {
    semantic,
    keywordBonus,
    relevance,
    usage,
    projectBoost,
    total: relevance + usage + projectBoost
  }
}

export interface RankedCandidateSearchResult {
  results: HybridSearchResult[]
  nearMisses: NearMissRecord[]
  rawKeywordMatchIds: Set<string>
  rawKeywordQualificationScores: Map<string, number>
  /** Candidates matched specifically by error/command signal needles (eligible for exact-recall bypass). */
  signalKeywordMatchIds: Set<string>
}

export interface RankedCandidateSearchOptions {
  rawKeywordQueries: string[]
  /** Subset of raw keyword needles derived directly from error/command signals. */
  signalKeywordQueries?: string[]
  plannedKeywordQueries?: string[]
  config: Config
  settings: RetrievalSettings
  project?: string
  ancestorProjects?: string[]
  linkedWorkspaces?: string[]
  onlySharedScopes?: boolean
  /** Omit for cross-project semantic recall; set to project for a hard semantic scope. */
  semanticProject?: string
  semanticAncestorProjects?: string[]
  embeddings?: number[][]
  rawPromptEmbedding?: number[]
  type?: RecordType
  excludeDeprecated?: boolean
  maxTimestamp?: number
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
    signalKeywordQueries = [],
    plannedKeywordQueries = [],
    config,
    settings,
    project,
    ancestorProjects = [],
    linkedWorkspaces = [],
    onlySharedScopes = false,
    semanticProject,
    semanticAncestorProjects = [],
    embeddings = [],
    rawPromptEmbedding,
    type,
    maxTimestamp,
    sourceLimit,
    resultLimit,
    signal
  } = options
  const excludeDeprecated = options.excludeDeprecated ?? true
  const diagnostic = options.diagnostic === true
  const resultsById = new Map<string, HybridSearchResult>()
  const rawKeywordMatchIds = new Set<string>()
  const signalKeywordMatchIds = new Set<string>()
  const rawKeywordQualificationScores = new Map<string, number>()
  const gateScores = new Map<string, number>()
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

  const signalQueryLower = new Set(signalKeywordQueries.map(q => q.trim().toLowerCase()).filter(Boolean))
  const nonSignalRawQueries = signalQueryLower.size > 0
    ? rawKeywordQueries.filter(q => !signalQueryLower.has(q.trim().toLowerCase()))
    : rawKeywordQueries

  const keywordSearches = [
    { queries: signalKeywordQueries, raw: true, signalMatch: true },
    { queries: nonSignalRawQueries, raw: true, signalMatch: false },
    { queries: plannedKeywordQueries, raw: false, signalMatch: false }
  ].filter(search => search.queries.length > 0)
  const keywordResultSets = await Promise.all(keywordSearches.map(async search => ({
    ...search,
    result: await runHybridSearch({
      query: search.queries[0],
      keywordQueries: search.queries,
      limit: sourceLimit,
      project,
      ancestorProjects,
      linkedWorkspaces,
      onlySharedScopes,
      type,
      excludeDeprecated,
      maxTimestamp,
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
      if (keywordResults.signalMatch) signalKeywordMatchIds.add(item.record.id)
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
        linkedWorkspaces: semanticProject ? linkedWorkspaces : undefined,
        onlySharedScopes: !semanticProject && onlySharedScopes,
        type,
        excludeDeprecated,
        maxTimestamp,
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
      const smoothedUtility = computeSmoothedUtility(item.record)
      const isProjectMatch = Boolean(project && item.record.project === project)
      const rankingBreakdown = computeUnifiedScore({
        similarity: item.similarity,
        keywordMatch: item.keywordMatch,
        usageRatio: smoothedUtility,
        projectMatch: isProjectMatch,
        settings
      })

      if (!rawKeywordMatchIds.has(item.record.id)) {
        item.score = rankingBreakdown.total
        gateScores.set(item.record.id, rankingBreakdown.relevance)
        continue
      }

      let qualificationBreakdown = rankingBreakdown
      if (rawPromptEmbedding && candidateEmbedding && candidateEmbedding.length > 0) {
        const rawSimilarity = cosineSimilarity(rawPromptEmbedding, candidateEmbedding)
        qualificationBreakdown = computeUnifiedScore({
          similarity: rawSimilarity,
          keywordMatch: true,
          usageRatio: smoothedUtility,
          projectMatch: isProjectMatch,
          settings
        })
        item.similarity = Math.max(item.similarity, rawSimilarity)
      }
      // Decouple admission gating from usageRatio & projectMatchBonus: gate on
      // pure query-document relevance, then apply smoothed utility & project
      // match strictly as a small post-gate rerank nudge.
      rawKeywordQualificationScores.set(item.record.id, qualificationBreakdown.relevance)
      gateScores.set(
        item.record.id,
        Math.max(rankingBreakdown.relevance, qualificationBreakdown.relevance)
      )
      item.score = Math.max(rankingBreakdown.total, qualificationBreakdown.total)
    }
  }
  // Explicit fail-open path: without a query embedding, keyword candidates
  // retain their raw exact-match scores and remain searchable.

  const passesRelevanceGate = (result: HybridSearchResult): boolean => {
    if (signalKeywordMatchIds.has(result.record.id)) return true
    const gateScore = gateScores.get(result.record.id) ?? result.score
    return gateScore >= settings.minScore
  }

  if (diagnostic && nearMisses) {
    for (const item of allCandidates) {
      if (!passesRelevanceGate(item)) {
        const actual = gateScores.get(item.record.id) ?? item.score
        nearMisses.set(item.record.id, {
          record: item,
          exclusionReasons: [buildExclusionReason('score_below_threshold', settings.minScore, actual)]
        })
      }
    }
  }

  const rankedResults = sortByScore(
    allCandidates.filter(passesRelevanceGate)
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
    rawKeywordQualificationScores,
    signalKeywordMatchIds
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
