import { truncateText, withTimeout } from './shared.js'
import { closeLanceDB, initLanceDB, hybridSearch, computeUsageRatio } from './lancedb.js'
import { buildContext, extractSignals, findAncestorProjects, stripNoiseWords, type ContextSignals } from './context.js'
import { embed } from './embed.js'
import { mergeNearMisses, buildExclusionReason } from './diagnostics.js'
import { generateRetrievalQueryPlan } from './retrieval-query-generator.js'
import { recordTokenUsageEventsAsync } from './token-usage-events.js'
import { loadSettings, type RetrievalSettings } from './settings.js'
import {
  DEFAULT_CONFIG,
  type Config,
  type DiagnosticContextResult,
  type DiagnosticQueryInfo,
  type DiagnosticSearchResults,
  type ExclusionReason,
  type HybridSearchResult,
  type HybridSearchParams,
  type MemoryRecord,
  type NearMissRecord,
  type PrePromptInput
} from './types.js'

/**
 * Fixed weight for semantic similarity in the unified scoring formula.
 * Not user-configurable because changing it would shift the meaning of
 * minScore and other thresholds that depend on this scale.
 */
const UNIFIED_SEMANTIC_WEIGHT = 0.7

function applySettingsToConfig(config: Config, settings: RetrievalSettings): Config {
  return {
    ...config,
    injection: {
      ...config.injection,
      maxRecords: settings.maxRecords,
      maxTokens: settings.maxTokens
    }
  }
}

export interface RetrievalRequest {
  prompt: string
  cwd: string
  transcriptPath?: string
}

export interface RetrievalResult {
  context: string | null
  signals: ContextSignals
  results: HybridSearchResult[]
  injectedRecords: MemoryRecord[]
  timedOut: boolean
  diagnostics?: RetrievalDiagnostics
}

export interface RetrievalDiagnostics {
  search: DiagnosticSearchResults
  context: DiagnosticContextResult
}

export type PrePromptResult = RetrievalResult
export type PrePromptDiagnostics = RetrievalDiagnostics

export type RetrievalOptions = {
  projectRoot?: string
  settingsOverride?: Partial<RetrievalSettings>
  diagnostic?: boolean
}

/**
 * Core retrieval logic used by hooks and the dashboard.
 */
export async function retrieveContext(
  input: RetrievalRequest,
  config: Config = DEFAULT_CONFIG,
  options: RetrievalOptions = {}
): Promise<RetrievalResult> {
  if (!input.prompt || !input.prompt.trim()) {
    return {
      context: null,
      signals: { errors: [], commands: [] },
      results: [],
      injectedRecords: [],
      timedOut: false
    }
  }

  const signals = extractSignals(input.prompt, input.cwd, options.projectRoot)
  const baseSettings = loadSettings()
  const settings: RetrievalSettings = options.settingsOverride
    ? { ...baseSettings, ...options.settingsOverride }
    : baseSettings
  const runtimeConfig = applySettingsToConfig(config, settings)
  const diagnostic = options.diagnostic === true

  const result = await withTimeout(async (signal) => {
    const unregister = registerAbortCleanup(signal, () => {
      void closeLanceDB()
    })
    try {
      await initLanceDB(runtimeConfig)
      const searchResult = await searchMemories(
        input.prompt,
        signals,
        runtimeConfig,
        settings,
        input.cwd,
        signal,
        { diagnostic, transcriptPath: input.transcriptPath }
      )
      const results = searchResult.results
      if (diagnostic) {
        const contextResult = buildContext(results, runtimeConfig, {
          diagnostic: true,
          mmrExclusions: searchResult.diagnostics?.mmrExclusions
        })
        return {
          context: contextResult.context || null,
          results,
          injectedRecords: contextResult.injectedRecords.map(item => item.record),
          diagnostics: searchResult.diagnostics
            ? { search: searchResult.diagnostics.search, context: contextResult }
            : undefined
        }
      }

      if (results.length === 0) {
        return { context: null, results, injectedRecords: [] }
      }

      const { context, records: injectedRecords } = buildContext(results, runtimeConfig)
      return { context: context || null, results, injectedRecords }
    } finally {
      unregister()
    }
  }, {
    timeoutMs: settings.prePromptTimeoutMs,
    onTimeout: () => {
      void closeLanceDB()
    }
  })

  if (!result.completed) {
    return {
      context: null,
      signals,
      results: [],
      injectedRecords: [],
      timedOut: result.timedOut
    }
  }

  return {
    context: result.value?.context ?? null,
    signals,
    results: result.value?.results ?? [],
    injectedRecords: result.value?.injectedRecords ?? [],
    timedOut: false,
    diagnostics: result.value?.diagnostics
  }
}

export async function handlePrePrompt(
  input: PrePromptInput,
  config: Config = DEFAULT_CONFIG,
  options: RetrievalOptions = {}
): Promise<RetrievalResult> {
  return retrieveContext({
    prompt: input.prompt,
    cwd: input.cwd,
    transcriptPath: input.transcript_path
  }, config, options)
}

type SearchMemoriesDiagnostics = {
  search: DiagnosticSearchResults
  mmrExclusions: NearMissRecord[]
}

type SearchMemoriesResult = {
  results: HybridSearchResult[]
  diagnostics?: SearchMemoriesDiagnostics
}

type SearchWithScopeResult = {
  results: HybridSearchResult[]
  nearMisses: NearMissRecord[]
}

async function searchMemories(
  prompt: string,
  signals: ContextSignals,
  config: Config,
  settings: RetrievalSettings,
  cwd: string,
  signal?: AbortSignal,
  options: { diagnostic?: boolean; transcriptPath?: string } = {}
): Promise<SearchMemoriesResult> {
  const cleanPrompt = stripNoiseWords(prompt)
  const diagnostic = options.diagnostic === true

  const queryPlanResult = settings.enableHaikuRetrieval
    ? await generateRetrievalQueryPlan(
        prompt,
        options.transcriptPath,
        { signal, timeoutMs: settings.haikuQueryTimeoutMs }
      )
    : null
  const queryPlanTokenUsage = queryPlanResult?.tokenUsage
  if (queryPlanResult && queryPlanTokenUsage) {
    recordTokenUsageEventsAsync([{
      timestamp: Date.now(),
      source: 'haiku-query',
      model: queryPlanResult.model,
      inputTokens: queryPlanTokenUsage.inputTokens,
      outputTokens: queryPlanTokenUsage.outputTokens,
      cacheCreationInputTokens: queryPlanTokenUsage.cacheCreationInputTokens,
      cacheReadInputTokens: queryPlanTokenUsage.cacheReadInputTokens
    }], { collection: config.lancedb.table })
  }
  const queryPlan = queryPlanResult?.plan ?? null
  if (settings.enableHaikuRetrieval && !queryPlan) {
    console.warn('[claude-memory] Haiku retrieval enabled but query plan generation failed; falling back to raw prompt')
  }
  const resolvedPrompt = queryPlan?.resolvedQuery
    ? stripNoiseWords(queryPlan.resolvedQuery)
    : cleanPrompt
  const effectivePrompt = resolvedPrompt || cleanPrompt
  const keywordQueries = queryPlan
    ? normalizeKeywordQueries(queryPlan.keywordQueries, effectivePrompt, settings, queryPlan.resolvedQuery)
    : buildKeywordQueries(signals, cleanPrompt, settings)

  const semanticBase = queryPlan?.semanticQuery?.trim()
  const semanticQuery = semanticBase
    ? normalizeSemanticQuery(semanticBase, signals, settings)
    : buildSemanticQuery(cleanPrompt, signals, settings)
  const project = signals.projectRoot ?? cwd

  // Pre-compute embedding once to avoid duplicate API calls on retry
  let embedding: number[] | undefined
  if (semanticQuery) {
    try {
      embedding = await embed(semanticQuery, config, { signal })
    } catch (error) {
      if (signal?.aborted) {
        throw error
      }
      console.error('[claude-memory] Embedding failed; falling back to keyword-only search:', error)
    }
  }

  let searchQualifiedResult = await searchWithScope(
    keywordQueries,
    config,
    settings,
    project,
    embedding,
    signal,
    { diagnostic }
  )
  let results = searchQualifiedResult.results
  const searchNearMisses = diagnostic ? new Map<string, NearMissRecord>() : null
  if (diagnostic && searchNearMisses) {
    mergeNearMisses(searchNearMisses, searchQualifiedResult.nearMisses)
  }

  // Note: Global memories (scope="global") are already included via includeGlobal=true
  // in buildFilter. We no longer fallback to remove the project filter, as that
  // allowed project-scoped memories from OTHER projects to leak through.

  if (diagnostic && searchNearMisses) {
    for (const result of results) {
      searchNearMisses.delete(result.record.id)
    }
  }

  const queryInfo: DiagnosticQueryInfo | undefined = diagnostic
    ? {
        semanticQuery: semanticQuery || '',
        keywordQueries,
        effectivePrompt,
        haikuUsed: queryPlan !== null
      }
    : undefined

  const searchDiagnostics = diagnostic
    ? {
        qualified: results,
        // Sort near misses by similarity descending so most relevant appear first
        nearMisses: Array.from(searchNearMisses?.values() ?? [])
          .sort((a, b) => b.record.similarity - a.record.similarity),
        queryInfo
      }
    : undefined

  let mmrExclusions: NearMissRecord[] = []
  let finalResults = results
  // Apply MMR for diversity if we have multiple results with embeddings
  if (results.length > 1) {
    if (diagnostic) {
      const mmrResult = applyMMR(results, settings.mmrLambda, config.injection.maxRecords, { diagnostic: true })
      if (mmrResult.selected.length !== results.length) {
        console.error(`[claude-memory] MMR reranked ${results.length} -> ${mmrResult.selected.length} results`)
      }
      finalResults = mmrResult.ordered
      mmrExclusions = mmrResult.exclusions
    } else {
      const diverseResults = applyMMR(results, settings.mmrLambda, config.injection.maxRecords)
      if (diverseResults.length !== results.length) {
        console.error(`[claude-memory] MMR reranked ${results.length} -> ${diverseResults.length} results`)
      }
      finalResults = diverseResults
    }
  }

  return {
    results: finalResults,
    diagnostics: diagnostic
      ? {
          search: searchDiagnostics ?? { qualified: [], nearMisses: [] },
          mmrExclusions
        }
      : undefined
  }
}

async function runHybridSearch(
  params: HybridSearchParams,
  config: Config,
  diagnostic: boolean
): Promise<SearchWithScopeResult> {
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

async function searchWithScope(
  keywordQueries: string[],
  config: Config,
  settings: RetrievalSettings,
  project: string | undefined,
  precomputedEmbedding?: number[],
  signal?: AbortSignal,
  options: { diagnostic?: boolean } = {}
): Promise<SearchWithScopeResult> {
  const maxRecords = config.injection.maxRecords
  const candidateLimit = Math.max(maxRecords * 3, maxRecords)
  const resultsById = new Map<string, HybridSearchResult>()
  const diagnostic = options.diagnostic === true
  const nearMisses = diagnostic ? new Map<string, NearMissRecord>() : null

  const ancestorProjects = project ? findAncestorProjects(project) : []
  console.error(`[claude-memory] Search scope: keywords=${keywordQueries.length}, project=${project ?? 'none'}${ancestorProjects.length ? `, ancestors=${ancestorProjects.join(',')}` : ''}`)

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

  for (const query of keywordQueries) {
    const keywordResults = await runHybridSearch({
      query,
      limit: candidateLimit,
      project,
      ancestorProjects,
      excludeDeprecated: true,
      vectorWeight: 0,
      keywordWeight: 1,
      keywordLimit: candidateLimit,
      usageRatioWeight: settings.usageRatioWeight,
      includeEmbeddings: true,
      signal
    }, config, diagnostic)
    for (const item of keywordResults.results) {
      upsertResult(item)
    }
    if (diagnostic && nearMisses) {
      mergeNearMisses(nearMisses, keywordResults.nearMisses)
    }
  }

  if (precomputedEmbedding) {
    // Semantic search runs WITHOUT project filter. Embedding similarity
    // (minSemanticSimilarity=0.70) already gates relevance, and the
    // projectMatchBonus in unified re-scoring ranks same-project memories
    // higher. Hard project filtering here excluded relevant memories from
    // sibling repos (e.g., aura-billing-agent invisible when searching
    // from aura) — the exact scenario the scoring formula handles well.
    // Keyword search keeps its project filter since substring matching is
    // too broad without it.
    const semanticResults = await runHybridSearch({
      query: '', // Not used when embedding provided
      embedding: precomputedEmbedding,
      limit: candidateLimit,
      excludeDeprecated: true,
      vectorWeight: 1,
      keywordWeight: 0,
      minSimilarity: settings.minSemanticSimilarity,
      minScore: settings.minSemanticOnlyScore,
      usageRatioWeight: settings.usageRatioWeight,
      includeEmbeddings: true,
      signal
    }, config, diagnostic)
    for (const item of semanticResults.results) {
      upsertResult(item)
    }
    if (diagnostic && nearMisses) {
      mergeNearMisses(nearMisses, semanticResults.nearMisses)
    }
  }

  // Unified re-scoring: compute actual semantic similarity for keyword-only
  // matches and apply a single scoring formula across all candidates.
  //
  // Previously, keyword matches got score=1.0+ (from keywordWeight=1) with
  // similarity=0, and bypassed minScore filtering. This caused broad substring
  // matches (e.g., "p4" matching anything mentioning P4) to flood results and
  // crowd out semantically relevant memories. Now all candidates are scored by:
  //   score = similarity * SEMANTIC_WEIGHT + keywordBonus + usageRatio * usageWeight
  // where keywordBonus is a small boost (~0.08) instead of the old effective 1.0.
  const allCandidates = Array.from(resultsById.values())

  if (precomputedEmbedding) {
    for (const item of allCandidates) {
      // Compute real cosine similarity for keyword-only matches that came in with similarity=0
      if (item.similarity === 0 && item.keywordMatch) {
        const candidateEmbedding = item.record.embedding
        if (candidateEmbedding && candidateEmbedding.length > 0) {
          item.similarity = cosineSimilarity(precomputedEmbedding, candidateEmbedding)
        }
      }
      const usageRatio = computeUsageRatio(item.record)
      // Scale keyword bonus by similarity: low-similarity keyword matches get proportionally
      // less boost, preventing broad substring matches from rescuing irrelevant results.
      const similarityScale = settings.minSemanticSimilarity > 0
        ? Math.min(item.similarity / settings.minSemanticSimilarity, 1.0)
        : 1.0
      const bonus = item.keywordMatch ? settings.keywordBonus * similarityScale : 0
      const projectBoost = (project && item.record.project === project) ? settings.projectMatchBonus : 0
      item.score = item.similarity * UNIFIED_SEMANTIC_WEIGHT + bonus + usageRatio * settings.usageRatioWeight + projectBoost
    }
  }
  // When precomputedEmbedding is undefined (embedding generation failed),
  // candidates keep their original hybridSearch scores (keyword matches have
  // score=1.0+, which passes minScore naturally). No special bypass needed.

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

  const filteredResults = allCandidates.filter(result =>
    result.score >= settings.minScore
  )
  const rankedResults = sortByScore(filteredResults).slice(0, candidateLimit)
  if (diagnostic && nearMisses) {
    for (const result of rankedResults) {
      nearMisses.delete(result.record.id)
    }
  }
  return { results: rankedResults, nearMisses: Array.from(nearMisses?.values() ?? []) }
}

/**
 * Apply Maximal Marginal Relevance to diversify results.
 * Penalizes candidates that are too similar to already-selected items.
 */
type MMRDiagnosticResult = {
  selected: HybridSearchResult[]
  ordered: HybridSearchResult[]
  exclusions: NearMissRecord[]
}

type MMRSelection = {
  selected: HybridSearchResult[]
  remaining: HybridSearchResult[]
  lastSelectedMmr: number
}

function hasEmbedding(candidate: HybridSearchResult): boolean {
  return Boolean(candidate.record.embedding && candidate.record.embedding.length > 0)
}

function sortByScore(candidates: HybridSearchResult[]): HybridSearchResult[] {
  return [...candidates].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return b.similarity - a.similarity
  })
}

function selectWithMMR(
  candidates: HybridSearchResult[],
  lambda: number,
  limit: number
): MMRSelection {
  const selected: HybridSearchResult[] = []
  const remaining = sortByScore(candidates)
  let lastSelectedMmr = 0

  const first = remaining.shift()
  if (!first) return { selected, remaining, lastSelectedMmr }
  selected.push(first)
  lastSelectedMmr = lambda * first.score

  while (remaining.length > 0 && selected.length < limit) {
    let bestIdx = 0
    let bestMMR = -Infinity

    for (let i = 0; i < remaining.length; i++) {
      const relevance = remaining[i].score

      let maxSim = -Infinity
      for (const chosen of selected) {
        const sim = cosineSimilarity(chosen.record.embedding!, remaining[i].record.embedding!)
        maxSim = Math.max(maxSim, sim)
      }

      const mmr = lambda * relevance - (1 - lambda) * maxSim

      if (mmr > bestMMR) {
        bestMMR = mmr
        bestIdx = i
      }
    }

    selected.push(remaining.splice(bestIdx, 1)[0])
    lastSelectedMmr = bestMMR
  }

  return { selected, remaining, lastSelectedMmr }
}

function buildMmrExclusions(
  remaining: HybridSearchResult[],
  selected: HybridSearchResult[],
  allCandidates: HybridSearchResult[],
  lambda: number,
  lastSelectedMmr: number,
  limit: number
): NearMissRecord[] {
  if (remaining.length === 0 || selected.length === 0 || limit <= 0) return []

  const baselineIds = new Set(
    sortByScore(allCandidates)
      .slice(0, limit)
      .map(candidate => candidate.record.id)
  )

  const exclusions: NearMissRecord[] = []
  for (const candidate of remaining) {
    if (!baselineIds.has(candidate.record.id)) {
      continue
    }
    let maxSim = -Infinity
    let similarTo: string | undefined
    for (const chosen of selected) {
      const sim = cosineSimilarity(chosen.record.embedding!, candidate.record.embedding!)
      if (sim > maxSim) {
        maxSim = sim
        similarTo = chosen.record.id
      }
    }
    const mmr = lambda * candidate.score - (1 - lambda) * maxSim
    const reason: ExclusionReason = {
      reason: 'mmr_diversity_penalty',
      threshold: lastSelectedMmr,
      actual: mmr,
      gap: lastSelectedMmr - mmr,
      similarTo,
      similarityScore: maxSim
    }
    exclusions.push({ record: candidate, exclusionReasons: [reason] })
  }

  return exclusions
}

function applyMMR(
  candidates: HybridSearchResult[],
  lambda: number,
  limit: number,
  options: { diagnostic: true }
): MMRDiagnosticResult
function applyMMR(
  candidates: HybridSearchResult[],
  lambda: number,
  limit: number,
  options?: { diagnostic?: false | undefined }
): HybridSearchResult[]
function applyMMR(
  candidates: HybridSearchResult[],
  lambda: number,
  limit: number,
  options: { diagnostic?: boolean } = {}
): HybridSearchResult[] | MMRDiagnosticResult {
  const diagnostic = options.diagnostic === true
  if (limit <= 0) {
    return diagnostic ? { selected: [], ordered: candidates, exclusions: [] } : []
  }
  if (candidates.length <= 1) {
    return diagnostic ? { selected: candidates, ordered: candidates, exclusions: [] } : candidates
  }

  // Filter to candidates with embeddings
  const withEmbeddings = candidates.filter(hasEmbedding)
  const withoutEmbeddings = candidates.filter(candidate => !hasEmbedding(candidate))

  // If no embeddings available, return original order
  if (withEmbeddings.length === 0) {
    return diagnostic ? { selected: candidates, ordered: candidates, exclusions: [] } : candidates
  }

  const selection = selectWithMMR(withEmbeddings, lambda, limit)
  const selected: HybridSearchResult[] = [...selection.selected]
  const remainingWithEmbeddings = selection.remaining
  const lastSelectedMmr = selection.lastSelectedMmr

  // Append any records without embeddings at the end (they couldn't be compared)
  const remainingWithoutEmbeddings: HybridSearchResult[] = []
  for (const item of withoutEmbeddings) {
    if (selected.length < limit) {
      selected.push(item)
    } else {
      remainingWithoutEmbeddings.push(item)
    }
  }

  const finalSelected = selected.slice(0, limit)

  if (!diagnostic) {
    return finalSelected
  }

  const exclusions = buildMmrExclusions(
    remainingWithEmbeddings,
    selection.selected,
    candidates,
    lambda,
    lastSelectedMmr,
    limit
  )

  return {
    selected: finalSelected,
    ordered: [...finalSelected, ...remainingWithEmbeddings, ...remainingWithoutEmbeddings],
    exclusions
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
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

function normalizeKeywordQueries(
  queries: string[],
  fallback: string,
  settings: RetrievalSettings,
  resolvedQuery?: string
): string[] {
  const trimmed = queries.map(query => query.trim()).filter(query => query.length > 0)
  const seenLower = new Set<string>()
  const deduped: string[] = []

  for (const entry of trimmed) {
    const key = entry.toLowerCase()
    if (seenLower.has(key)) continue
    deduped.push(entry)
    seenLower.add(key)
  }

  // Extract proper nouns from multi-word keywords. Haiku sometimes treats
  // "<ProperNoun> <word>" as an atomic compound (e.g., "jira issue") without
  // emitting the proper noun standalone. Identify proper nouns by checking
  // which words start with an uppercase letter in the resolved query.
  // Matches TitleCase (Jira), ALL_CAPS (AWS, S3), and mixed (k8s won't match
  // but K8s will — acceptable since most tool names are capitalized).
  const resolvedTokens = (resolvedQuery || '').split(/\s+/).map(w => w.replace(/[^\w]/g, ''))
  const properNouns = new Set(
    resolvedTokens.filter(w => w.length >= 2 && /^[A-Z]/.test(w)).map(w => w.toLowerCase())
  )
  // Build result with extracted proper nouns placed right after their source
  // compound, so they survive maxKeywordQueries truncation.
  const result: string[] = []
  for (const query of deduped) {
    result.push(query)
    const words = query.split(/\s+/)
    if (words.length < 2) continue
    for (const word of words) {
      const lower = word.toLowerCase()
      if (lower.length >= 2 && properNouns.has(lower) && !seenLower.has(lower)) {
        result.push(lower)
        seenLower.add(lower)
      }
    }
  }

  if (result.length === 0 && fallback.trim()) {
    result.push(fallback.trim())
  }

  if (result.length <= settings.maxKeywordQueries) return result
  return result.slice(0, settings.maxKeywordQueries)
}

function normalizeSemanticQuery(
  semanticQuery: string,
  _signals: ContextSignals,
  settings: RetrievalSettings
): string {
  const trimmed = semanticQuery.trim()
  if (!trimmed) return ''

  // Project context is NOT appended to the semantic query. Project scoping
  // is handled by the SQL filter expression (project = 'X' OR scope = 'global'),
  // so embedding it into the query vector is redundant and actively harmful —
  // it shifts the embedding away from content similarity toward project-name
  // similarity, degrading retrieval of global records from other projects.
  return truncateText(trimmed, settings.maxSemanticQueryChars)
}

function buildKeywordQueries(
  signals: ContextSignals,
  cleanPrompt: string,
  settings: RetrievalSettings
): string[] {
  const errorQueries = signals.errors.slice(0, settings.maxKeywordErrors)
  const commandQueries = signals.commands.slice(0, settings.maxKeywordCommands)
  const queries = [...errorQueries, ...commandQueries]

  // Fallback: if no specific signals, use the prompt itself for keyword matching.
  if (queries.length === 0 && cleanPrompt.trim()) {
    queries.push(cleanPrompt.trim())
  }

  if (queries.length <= settings.maxKeywordQueries) return queries
  return queries.slice(0, settings.maxKeywordQueries)
}

function buildSemanticQuery(
  prompt: string,
  _signals: ContextSignals,
  settings: RetrievalSettings
): string {
  const trimmed = prompt.trim()
  if (!trimmed) return ''

  return truncateText(trimmed, settings.maxSemanticQueryChars)
}

function registerAbortCleanup(signal: AbortSignal, cleanup: () => void): () => void {
  const onAbort = (): void => {
    cleanup()
  }
  if (signal.aborted) {
    onAbort()
    return () => {}
  }
  signal.addEventListener('abort', onAbort, { once: true })
  return () => signal.removeEventListener('abort', onAbort)
}
