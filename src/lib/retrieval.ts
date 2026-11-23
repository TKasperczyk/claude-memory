import { truncateText, withTimeout } from './shared.js'
import { closeLanceDB, fetchRecordsByIds, hybridSearch, initLanceDB, iterateRecords } from './lancedb.js'
import { ENTITY_TOKEN_PATTERN, extractEntityNeedles } from './entities.js'
import { buildContext, extractSignals, findAncestorProjects, stripNoiseWords, type ContextSignals } from './context.js'
import { embed } from './embed.js'
import { canonicalizePath } from './paths.js'
import { isStrictCatchAllRoot, resolveRetrievalScope } from './scope-attribution.js'
import { mergeNearMisses, buildExclusionReason } from './diagnostics.js'
import { computeUnifiedScore, cosineSimilarity, searchRankedCandidates, sortByScore } from './ranked-search.js'
import { generateRetrievalQueryPlan } from './retrieval-query-generator.js'
import { rerankRetrievedCandidates } from './retrieval-reranker.js'
import { recordTokenUsageEventsAsync } from './token-usage-events.js'
import { loadSettings, type RetrievalSettings } from './settings.js'
import { loadSessionTracking, updateSessionPromptStateIfVersion, updateSessionRetrievalState } from './session-tracking.js'
import {
  DEFAULT_CONFIG,
  type Config,
  type DiagnosticContextResult,
  type DiagnosticQueryInfo,
  type DiagnosticSearchResults,
  type ExclusionReason,
  type HybridSearchResult,
  type MemoryRecord,
  type NearMissRecord,
  type PrePromptInput,
  type RelationKind,
  type SuppressionMode
} from './types.js'

export {
  computeUnifiedScore,
  cosineSimilarity,
  UNIFIED_SEMANTIC_WEIGHT
} from './ranked-search.js'
export type { UnifiedScoreBreakdown, UnifiedScoreInputs } from './ranked-search.js'

const FALLBACK_KEYWORD_STOPWORDS = new Set([
  'a',
  'about',
  'advice',
  'an',
  'and',
  'anything',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'can',
  'check',
  'code',
  'command',
  'config',
  'continue',
  'could',
  'data',
  'did',
  'do',
  'does',
  'e.g',
  'error',
  'explain',
  'file',
  'find',
  'for',
  'from',
  'get',
  'got',
  'had',
  'has',
  'have',
  'help',
  'how',
  'i',
  'i.e',
  'if',
  'in',
  'into',
  'is',
  'it',
  'issue',
  'know',
  'make',
  'me',
  'my',
  'need',
  'needs',
  'no',
  'of',
  'ok',
  'okay',
  'on',
  'or',
  'our',
  'output',
  'please',
  'problem',
  'project',
  'remember',
  'run',
  'save',
  'should',
  'skill',
  'status',
  'stuff',
  'tell',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'thing',
  'things',
  'this',
  'those',
  'to',
  'use',
  'used',
  'using',
  'was',
  'we',
  'were',
  'what',
  'whats',
  'when',
  'where',
  'which',
  'who',
  'why',
  'with',
  'without',
  'would',
  'yes',
  'you',
  'your'
])

const FALLBACK_SHORT_TECH_KEYWORDS = new Set([
  'api',
  'dns',
  'ip',
  'jq',
  'k8s',
  'sql',
  'ssh',
  'tcp',
  'udp'
])

const FALLBACK_TOKEN_PATTERN = ENTITY_TOKEN_PATTERN

/** Separate budget for entity needles appended to keyword queries (B2 mechanism). */
const ENTITY_NEEDLE_CAP = 3
// A hung embedding provider must cost one query variant, not the whole
// pre-prompt budget; searchMemories already continues with partial embeddings.
const HOOK_EMBEDDING_TIMEOUT_MS = 4500
const MAX_SCALED_EMBEDDING_TIMEOUT_MS = 15000
// Reserve headroom inside prePromptTimeoutMs so LanceDB search + MMR always
// have time to complete after Haiku and embedding calls.
const RETRIEVAL_POST_HAIKU_HEADROOM_MS = 2500
const RETRIEVAL_SEARCH_HEADROOM_MS = 1000

function computeEmbeddingTimeoutMs(prePromptTimeoutMs: number): number {
  if (!Number.isFinite(prePromptTimeoutMs) || prePromptTimeoutMs <= 10_000) {
    return HOOK_EMBEDDING_TIMEOUT_MS
  }
  return Math.min(MAX_SCALED_EMBEDDING_TIMEOUT_MS, Math.max(HOOK_EMBEDDING_TIMEOUT_MS, prePromptTimeoutMs - 5_500))
}

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
  sessionId?: string
  skipSuppressionWriteback?: boolean
  /** Causal upper bound (exclusive): only records with timestamp < maxTimestamp are eligible. */
  maxTimestamp?: number
}

export interface RetrievalTelemetry {
  pipeline: 'stage2-rerank' | 'legacy'
  project?: string
  stage1CandidateCount: number
  bm25HitCount: number
  vectorHitCount: number
  suppressedCount: number
  rerankerCalled: boolean
  rerankerAbstained: boolean
  rerankerFallback: boolean
  abstainReason?: string
  stage1EmbedMs?: number
  stage1SearchMs?: number
  stage2RerankMs?: number
}

export interface RetrievalResult {
  context: string | null
  signals: ContextSignals
  results: HybridSearchResult[]
  injectedRecords: MemoryRecord[]
  timedOut: boolean
  diagnostics?: RetrievalDiagnostics
  suppressionWritebackVersion?: number
  telemetry?: RetrievalTelemetry
  /** Top Stage-1 recall pool (before Stage-2 reranking) for offline recall evaluation. */
  stage1Candidates?: HybridSearchResult[]
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
  /**
   * Close the shared LanceDB handle on timeout/abort. Enable only in short-lived
   * hook processes; long-lived servers (Express dashboard) must keep the handle open.
   */
  closeOnTimeout?: boolean
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
  const closeOnTimeout = options.closeOnTimeout === true
  const deadlineMs = Date.now() + settings.prePromptTimeoutMs

  const result = await withTimeout(async (signal) => {
    const unregister = closeOnTimeout
      ? registerAbortCleanup(signal, () => {
          void closeLanceDB()
        })
      : () => {}
    try {
      await initLanceDB(runtimeConfig)
      const searchResult = await searchMemories(
        input.prompt,
        signals,
        runtimeConfig,
        settings,
        input.cwd,
        signal,
        {
          diagnostic,
          transcriptPath: input.transcriptPath,
          sessionId: input.sessionId,
          skipSuppressionWriteback: input.skipSuppressionWriteback,
          maxTimestamp: input.maxTimestamp,
          deadlineMs
        }
      )
      const results = searchResult.results
      if (diagnostic) {
        const contextResult = buildContext(results, runtimeConfig, {
          diagnostic: true,
          mmrExclusions: searchResult.diagnostics?.mmrExclusions
        })
        const injectedRecords = contextResult.injectedRecords.map(item => item.record)
        const suppressionWritebackVersion = updateRetrievalPromptState(input.sessionId, searchResult, settings, runtimeConfig.lancedb.table, input.skipSuppressionWriteback)
        return {
          context: contextResult.context || null,
          results,
          injectedRecords,
          suppressionWritebackVersion,
          telemetry: searchResult.telemetry,
          stage1Candidates: searchResult.stage1Candidates,
          diagnostics: searchResult.diagnostics
            ? { search: searchResult.diagnostics.search, context: contextResult }
            : undefined
        }
      }

      if (results.length === 0) {
        const suppressionWritebackVersion = updateRetrievalPromptState(input.sessionId, searchResult, settings, runtimeConfig.lancedb.table, input.skipSuppressionWriteback)
        return {
          context: null,
          results,
          injectedRecords: [],
          suppressionWritebackVersion,
          telemetry: searchResult.telemetry,
          stage1Candidates: searchResult.stage1Candidates
        }
      }

      const { context, records: injectedRecords } = buildContext(results, runtimeConfig)
      const suppressionWritebackVersion = updateRetrievalPromptState(input.sessionId, searchResult, settings, runtimeConfig.lancedb.table, input.skipSuppressionWriteback)
      return {
        context: context || null,
        results,
        injectedRecords,
        suppressionWritebackVersion,
        telemetry: searchResult.telemetry,
        stage1Candidates: searchResult.stage1Candidates
      }
    } finally {
      unregister()
    }
  }, {
    timeoutMs: settings.prePromptTimeoutMs,
    ...(closeOnTimeout ? {
      onTimeout: () => {
        void closeLanceDB()
      }
    } : {})
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
    diagnostics: result.value?.diagnostics,
    suppressionWritebackVersion: result.value?.suppressionWritebackVersion,
    telemetry: result.value?.telemetry,
    stage1Candidates: result.value?.stage1Candidates
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
    transcriptPath: input.transcript_path,
    sessionId: input.session_id
  }, config, {
    ...options,
    closeOnTimeout: options.closeOnTimeout ?? true
  })
}

type SearchMemoriesDiagnostics = {
  search: DiagnosticSearchResults
  mmrExclusions: NearMissRecord[]
}

type SearchMemoriesResult = {
  results: HybridSearchResult[]
  promptEmbedding?: number[]
  suppressionStateVersion: number
  diagnostics?: SearchMemoriesDiagnostics
  telemetry?: RetrievalTelemetry
  stage1Candidates?: HybridSearchResult[]
}

const STAGE1_POOL_LIMIT = 25
const RRF_K = 60
const USAGE_BAYES_PRIOR_MEAN = 0.1
const USAGE_BAYES_PRIOR_STRENGTH = 5

function computeSmoothedUtilityForStage1(record: MemoryRecord): number {
  const retrievalCount = Math.max(0, record.retrievalCount ?? 0)
  const usageCount = Math.max(0, record.usageCount ?? 0)
  const effectiveRetrievals = Math.max(retrievalCount, usageCount)
  const smoothed = (usageCount + USAGE_BAYES_PRIOR_STRENGTH * USAGE_BAYES_PRIOR_MEAN)
    / (effectiveRetrievals + USAGE_BAYES_PRIOR_STRENGTH)
  return Math.max(0, Math.min(smoothed, 1))
}

async function runStage1Stage2Retrieval(args: {
  prompt: string
  cleanPrompt: string
  signals: ContextSignals
  config: Config
  settings: RetrievalSettings
  cwd: string
  project?: string
  ancestorProjects: string[]
  linkedWorkspaces: string[]
  onlySharedScopes: boolean
  session: ReturnType<typeof loadSessionTracking>
  suppressionStateVersion: number
  signal?: AbortSignal
  options: {
    diagnostic?: boolean
    transcriptPath?: string
    sessionId?: string
    skipSuppressionWriteback?: boolean
    maxTimestamp?: number
    deadlineMs?: number
  }
}): Promise<SearchMemoriesResult> {
  const {
    prompt,
    cleanPrompt,
    signals,
    config,
    settings,
    cwd,
    project,
    ancestorProjects,
    linkedWorkspaces,
    onlySharedScopes,
    session,
    signal,
    options
  } = args
  const diagnostic = options.diagnostic === true
  let suppressionStateVersion = args.suppressionStateVersion

  const stage1MinSimilarity = settings.stage1MinSimilarity ?? 0.45
  const rerankCandidateLimit = settings.rerankCandidateLimit ?? 18
  const rerankMaxRecords = Math.min(
    settings.rerankMaxRecords ?? 3,
    Math.max(1, config.injection.maxRecords)
  )
  const rerankTimeoutMs = settings.rerankTimeoutMs ?? 4000

  const rawSemanticQuery = buildSemanticQuery(cleanPrompt, signals, settings)
  const signalNeedles = [
    ...signals.errors.slice(0, settings.maxKeywordErrors),
    ...signals.commands.slice(0, settings.maxKeywordCommands)
  ].slice(0, settings.maxKeywordQueries)
  const broadBm25Query = truncateText(cleanPrompt, 400).trim()
  const bm25QueryLabels: string[] = [
    ...signalNeedles,
    ...(broadBm25Query ? [broadBm25Query] : [])
  ]

  // Stage 1: Fire single raw-prompt embedding and local BM25 FTS concurrently.
  const embeddingTimeoutMs = computeEmbeddingTimeoutMs(settings.prePromptTimeoutMs)
  const embedStartMs = Date.now()
  let stage1EmbedMs = 0
  const rawEmbedPromise: Promise<{ embedding?: number[]; error?: unknown; aborted?: boolean }> = rawSemanticQuery
    ? embed(rawSemanticQuery, config, { signal, timeoutMs: embeddingTimeoutMs })
        .then(embedding => {
          stage1EmbedMs = Date.now() - embedStartMs
          return { embedding }
        })
        .catch(error => {
          stage1EmbedMs = Date.now() - embedStartMs
          return { error, aborted: Boolean(signal?.aborted) }
        })
    : Promise.resolve({})

  const searchStartMs = Date.now()
  const signalBm25Promise: Promise<HybridSearchResult[]> = signalNeedles.length > 0
    ? hybridSearch({
        query: signalNeedles[0],
        keywordQueries: signalNeedles,
        limit: 20,
        keywordLimit: 20,
        project,
        ancestorProjects,
        linkedWorkspaces,
        onlySharedScopes,
        excludeDeprecated: true,
        maxTimestamp: options.maxTimestamp,
        vectorWeight: 0,
        keywordWeight: 1,
        usageRatioWeight: 0,
        includeEmbeddings: true,
        signal
      }, config).catch(error => {
        if (signal?.aborted) throw error
        console.error('[claude-memory] Stage-1 signal BM25 search failed:', error)
        return []
      })
    : Promise.resolve([])

  const broadBm25Promise: Promise<HybridSearchResult[]> = broadBm25Query
    ? hybridSearch({
        query: broadBm25Query,
        keywordQueries: [broadBm25Query],
        limit: STAGE1_POOL_LIMIT,
        keywordLimit: STAGE1_POOL_LIMIT,
        project,
        ancestorProjects,
        linkedWorkspaces,
        onlySharedScopes,
        excludeDeprecated: true,
        maxTimestamp: options.maxTimestamp,
        vectorWeight: 0,
        keywordWeight: 1,
        usageRatioWeight: 0,
        includeEmbeddings: true,
        signal
      }, config).catch(error => {
        if (signal?.aborted) throw error
        console.error('[claude-memory] Stage-1 prompt BM25 search failed:', error)
        return []
      })
    : Promise.resolve([])

  const [embedOutcome, signalBm25Results, broadBm25Results] = await Promise.all([
    rawEmbedPromise,
    signalBm25Promise,
    broadBm25Promise
  ])
  if (embedOutcome.aborted || (signal?.aborted && embedOutcome.error)) {
    throw embedOutcome.error ?? new Error('Retrieval aborted')
  }
  const rawPromptEmbedding = embedOutcome.embedding
  if (embedOutcome.error) {
    console.error('[claude-memory] Stage-1 embedding failed; continuing with BM25 candidates:', embedOutcome.error)
  }

  let vectorResults: HybridSearchResult[] = []
  if (rawPromptEmbedding) {
    try {
      vectorResults = await hybridSearch({
        query: '',
        embedding: rawPromptEmbedding,
        limit: STAGE1_POOL_LIMIT,
        project,
        ancestorProjects,
        linkedWorkspaces,
        onlySharedScopes,
        excludeDeprecated: true,
        maxTimestamp: options.maxTimestamp,
        vectorWeight: 1,
        keywordWeight: 0,
        minSimilarity: stage1MinSimilarity,
        minScore: 0,
        usageRatioWeight: 0,
        includeEmbeddings: true,
        signal
      }, config)
    } catch (error) {
      if (signal?.aborted) throw error
      console.error('[claude-memory] Stage-1 vector search failed:', error)
    }
  }
  const stage1SearchMs = Date.now() - searchStartMs

  const suppressionResolution = resolveSuppressedIds({
    sessionId: options.sessionId,
    session,
    embedding: rawPromptEmbedding,
    settings,
    collection: config.lancedb.table,
    skipWriteback: options.skipSuppressionWriteback === true,
    stateVersion: suppressionStateVersion
  })
  const suppressedIds = suppressionResolution.ids
  suppressionStateVersion = suppressionResolution.stateVersion

  // Merge BM25 + Vector candidates via Reciprocal Rank Fusion (RRF).
  type Stage1Entry = {
    item: HybridSearchResult
    vecRank?: number
    bm25Rank?: number
    signalMatch: boolean
    fusionScore: number
    relevance: number
  }
  const merged = new Map<string, Stage1Entry>()
  const signalBm25Ids = new Set<string>()
  const bm25HitIds = new Set<string>()
  const vectorHitIds = new Set<string>()

  const upsertBm25 = (list: HybridSearchResult[], isSignal: boolean): void => {
    list.forEach((hit, rank) => {
      const id = hit.record.id
      bm25HitIds.add(id)
      if (isSignal) signalBm25Ids.add(id)
      const existing = merged.get(id)
      if (existing) {
        existing.item.keywordMatch = true
        if (hit.bm25Score !== undefined) {
          existing.item.bm25Score = Math.max(existing.item.bm25Score ?? 0, hit.bm25Score)
        }
        existing.bm25Rank = existing.bm25Rank === undefined ? rank : Math.min(existing.bm25Rank, rank)
        existing.signalMatch = existing.signalMatch || isSignal
      } else {
        merged.set(id, {
          item: { ...hit, keywordMatch: true },
          bm25Rank: rank,
          signalMatch: isSignal,
          fusionScore: 0,
          relevance: 0
        })
      }
    })
  }

  upsertBm25(signalBm25Results, true)
  upsertBm25(broadBm25Results, false)

  vectorResults.forEach((hit, rank) => {
    const id = hit.record.id
    vectorHitIds.add(id)
    const existing = merged.get(id)
    if (existing) {
      existing.item.similarity = Math.max(existing.item.similarity, hit.similarity)
      existing.vecRank = existing.vecRank === undefined ? rank : Math.min(existing.vecRank, rank)
    } else {
      merged.set(id, {
        item: { ...hit },
        vecRank: rank,
        signalMatch: false,
        fusionScore: 0,
        relevance: 0
      })
    }
  })

  for (const entry of merged.values()) {
    const rec = entry.item.record
    if (entry.item.similarity === 0 && rawPromptEmbedding && rec.embedding && rec.embedding.length > 0) {
      entry.item.similarity = cosineSimilarity(rawPromptEmbedding, rec.embedding)
    }
    const smoothedUtility = computeSmoothedUtilityForStage1(rec)
    const isProjectMatch = Boolean(project && rec.project === project)
    const isLinkedMatch = Boolean(!isProjectMatch && rec.project && linkedWorkspaces.includes(rec.project))
    const unified = computeUnifiedScore({
      similarity: entry.item.similarity,
      keywordMatch: entry.item.keywordMatch,
      usageRatio: smoothedUtility,
      projectMatch: isProjectMatch || isLinkedMatch,
      settings
    })
    entry.item.score = unified.total
    entry.relevance = unified.relevance

    const vecRrf = entry.vecRank !== undefined ? 1 / (RRF_K + entry.vecRank + 1) : 0
    const bm25Rrf = entry.bm25Rank !== undefined ? 1 / (RRF_K + entry.bm25Rank + 1) : 0
    const signalBoost = entry.signalMatch ? 0.015 : 0
    const projectNudge = isProjectMatch ? 0.006 : isLinkedMatch ? 0.003 : 0
    const utilityNudge = smoothedUtility * 0.002
    entry.fusionScore = vecRrf + bm25Rrf + signalBoost + projectNudge + utilityNudge
  }

  const stage1Sorted = Array.from(merged.values())
    .sort((a, b) => {
      if (b.fusionScore !== a.fusionScore) return b.fusionScore - a.fusionScore
      return b.item.similarity - a.item.similarity
    })
  const stage1Candidates = stage1Sorted.map(entry => entry.item)

  const searchNearMisses = diagnostic ? new Map<string, NearMissRecord>() : null

  // Apply compaction-scoped session ledger suppression BEFORE Stage-2 reranking
  // so already-injected memories never waste rerank slots or trigger unnecessary LLM calls.
  let remaining = stage1Candidates
  let suppressedCount = 0
  if (suppressedIds.size > 0 && remaining.length > 0) {
    const suppressionResult = applyRecentlyInjectedSuppression(remaining, suppressedIds, settings)
    remaining = suppressionResult.results
    suppressedCount = suppressionResult.exclusions.length
    if (diagnostic && searchNearMisses) {
      mergeNearMisses(searchNearMisses, suppressionResult.exclusions)
    }
  }

  let finalResults: HybridSearchResult[] = []
  let rerankerCalled = false
  let rerankerAbstained = false
  let rerankerFallback = false
  let abstainReason: string | undefined
  let stage2RerankMs: number | undefined

  if (remaining.length === 0) {
    rerankerAbstained = true
    abstainReason = stage1Candidates.length > 0 ? 'all_candidates_suppressed' : 'no_stage1_candidates'
  } else {
    const maxSimilarity = remaining.reduce((max, c) => Math.max(max, c.similarity), 0)
    const maxBm25 = remaining.reduce((max, c) => Math.max(max, c.bm25Score ?? 0), 0)
    const hasSignalHit = remaining.some(c => signalBm25Ids.has(c.record.id))

    if (rawPromptEmbedding && !hasSignalHit && maxSimilarity < stage1MinSimilarity && maxBm25 < 2.5) {
      rerankerAbstained = true
      abstainReason = 'below_stage1_floor'
      if (diagnostic && searchNearMisses) {
        for (const item of remaining) {
          searchNearMisses.set(item.record.id, {
            record: item,
            exclusionReasons: [buildExclusionReason('similarity_below_threshold', stage1MinSimilarity, item.similarity)]
          })
        }
      }
    } else {
      const rerankPool = remaining.slice(0, rerankCandidateLimit)
      const remainingBudgetMs = options.deadlineMs !== undefined
        ? options.deadlineMs - Date.now()
        : rerankTimeoutMs + 500
      const MIN_STAGE2_RERANK_BUDGET_MS = 850

      let rerankOutcome: Awaited<ReturnType<typeof rerankRetrievedCandidates>> = null
      if (remainingBudgetMs >= MIN_STAGE2_RERANK_BUDGET_MS) {
        const effectiveRerankTimeoutMs = Math.min(rerankTimeoutMs, remainingBudgetMs - 300)
        rerankerCalled = true
        rerankOutcome = await rerankRetrievedCandidates({
          prompt,
          cwd,
          project,
          transcriptPath: options.transcriptPath,
          candidates: rerankPool,
          maxRecords: rerankMaxRecords,
          timeoutMs: effectiveRerankTimeoutMs,
          signal
        })
      }

      if (rerankOutcome) {
        stage2RerankMs = rerankOutcome.durationMs
        if (rerankOutcome.tokenUsage) {
          recordTokenUsageEventsAsync([{
            timestamp: Date.now(),
            source: 'rerank',
            model: rerankOutcome.model,
            ...(options.sessionId ? { sessionId: options.sessionId } : {}),
            inputTokens: rerankOutcome.tokenUsage.inputTokens,
            outputTokens: rerankOutcome.tokenUsage.outputTokens,
            cacheCreationInputTokens: rerankOutcome.tokenUsage.cacheCreationInputTokens,
            cacheReadInputTokens: rerankOutcome.tokenUsage.cacheReadInputTokens
          }], { collection: config.lancedb.table })
        }
        finalResults = rerankOutcome.selected
        rerankerAbstained = rerankOutcome.abstained
        abstainReason = rerankOutcome.abstainReason
        if (diagnostic && searchNearMisses) {
          const selectedSet = new Set(finalResults.map(item => item.record.id))
          for (const candidate of rerankPool) {
            if (!selectedSet.has(candidate.record.id)) {
              searchNearMisses.set(candidate.record.id, {
                record: candidate,
                exclusionReasons: [buildExclusionReason('rerank_abstained', 1, 0)]
              })
            }
          }
        }
      } else {
        // Fail-safe local fallback when Stage-2 reranker times out or is unavailable.
        rerankerFallback = true
        const fallbackCandidates = remaining.filter(candidate => {
          if (signalBm25Ids.has(candidate.record.id)) return true
          if (!rawPromptEmbedding) return candidate.keywordMatch
          const entry = merged.get(candidate.record.id)
          const relevance = entry?.relevance ?? candidate.score
          return candidate.similarity >= settings.minSemanticSimilarity && relevance >= settings.minScore
        })
        finalResults = fallbackCandidates.length > 1
          ? applyMMR(fallbackCandidates, settings.mmrLambda, rerankMaxRecords)
          : fallbackCandidates.slice(0, rerankMaxRecords)
        if (finalResults.length === 0) {
          rerankerAbstained = true
          abstainReason = 'reranker_fallback_empty'
        }
      }
    }
  }

  const telemetry: RetrievalTelemetry = {
    pipeline: 'stage2-rerank',
    project,
    stage1CandidateCount: stage1Candidates.length,
    bm25HitCount: bm25HitIds.size,
    vectorHitCount: vectorHitIds.size,
    suppressedCount,
    rerankerCalled,
    rerankerAbstained,
    rerankerFallback,
    ...(abstainReason ? { abstainReason } : {}),
    stage1EmbedMs,
    stage1SearchMs,
    ...(stage2RerankMs !== undefined ? { stage2RerankMs } : {})
  }

  const queryInfo: DiagnosticQueryInfo | undefined = diagnostic
    ? {
        semanticQuery: rawSemanticQuery || '',
        keywordQueries: bm25QueryLabels,
        effectivePrompt: cleanPrompt,
        haikuUsed: rerankerCalled
      }
    : undefined

  return {
    results: finalResults,
    promptEmbedding: rawPromptEmbedding,
    suppressionStateVersion,
    telemetry,
    stage1Candidates,
    diagnostics: diagnostic
      ? {
          search: {
            qualified: finalResults,
            nearMisses: Array.from(searchNearMisses?.values() ?? [])
              .sort((a, b) => b.record.similarity - a.record.similarity),
            queryInfo
          },
          mmrExclusions: []
        }
      : undefined
  }
}

async function searchMemories(
  prompt: string,
  signals: ContextSignals,
  config: Config,
  settings: RetrievalSettings,
  cwd: string,
  signal?: AbortSignal,
  options: { diagnostic?: boolean; transcriptPath?: string; sessionId?: string; skipSuppressionWriteback?: boolean; maxTimestamp?: number; deadlineMs?: number } = {}
): Promise<SearchMemoriesResult> {
  const cleanPrompt = stripNoiseWords(prompt)
  const diagnostic = options.diagnostic === true
  const session = options.sessionId && settings.enableTopicSuppression
    ? loadSessionTracking(options.sessionId, config.lancedb.table)
    : null
  let suppressionStateVersion = session?.retrievalStateVersion ?? 0

  const attribution = resolveRetrievalScope(cwd, signals.projectRoot)
  const project = attribution.isCatchAll ? undefined : attribution.project
  const ancestorProjects = project
    ? findAncestorProjects(project).filter(ancestor => !isStrictCatchAllRoot(ancestor))
    : []
  const linkedWorkspaces = (config.linkedWorkspaces ?? [])
    .map(workspace => canonicalizePath(workspace))
    .filter(workspace => workspace && workspace !== project && !isStrictCatchAllRoot(workspace))
  const onlySharedScopes = attribution.isCatchAll

  if (settings.enablePostRetrievalRerank === true) {
    return runStage1Stage2Retrieval({
      prompt,
      cleanPrompt,
      signals,
      config,
      settings,
      cwd,
      project,
      ancestorProjects,
      linkedWorkspaces,
      onlySharedScopes,
      session,
      suppressionStateVersion,
      signal,
      options
    })
  }

  const rawSemanticQuery = buildSemanticQuery(cleanPrompt, signals, settings)
  const effectiveHaikuTimeoutMs = settings.prePromptTimeoutMs > RETRIEVAL_POST_HAIKU_HEADROOM_MS + 500
    ? Math.min(settings.haikuQueryTimeoutMs, settings.prePromptTimeoutMs - RETRIEVAL_POST_HAIKU_HEADROOM_MS)
    : settings.haikuQueryTimeoutMs

  // Start embedding the raw prompt concurrently with Haiku query planning so a slow
  // or timed-out Haiku call does not add another serial embedding roundtrip on top.
  // Never re-throw inside this floating promise's catch handler; otherwise an abort
  // while generateRetrievalQueryPlan/loadEntityVocabulary is awaited triggers an
  // unhandledRejection before Promise.all attaches.
  const embeddingTimeoutMs = computeEmbeddingTimeoutMs(settings.prePromptTimeoutMs)
  const rawEmbedPromise: Promise<{ query: string; embedding?: number[]; error?: unknown; aborted?: boolean } | null> = rawSemanticQuery
    ? embed(rawSemanticQuery, config, { signal, timeoutMs: embeddingTimeoutMs })
        .then(embedding => ({ query: rawSemanticQuery, embedding }))
        .catch(error => ({ query: rawSemanticQuery, error, aborted: Boolean(signal?.aborted) }))
    : Promise.resolve(null)

  const queryPlanResult = settings.enableHaikuRetrieval
    ? await generateRetrievalQueryPlan(
        prompt,
        options.transcriptPath,
        { signal, timeoutMs: effectiveHaikuTimeoutMs, expansionCount: settings.haikuExpansionCount }
      )
    : null
  const queryPlanTokenUsage = queryPlanResult?.tokenUsage
  if (queryPlanResult && queryPlanTokenUsage) {
    recordTokenUsageEventsAsync([{
      timestamp: Date.now(),
      source: 'haiku-query',
      model: queryPlanResult.model,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
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
  const entityVocabulary = settings.enableEntityKeywords
    ? await loadEntityVocabulary(config)
    : undefined
  const signalKeywordQueries = [
    ...signals.errors.slice(0, settings.maxKeywordErrors),
    ...signals.commands.slice(0, settings.maxKeywordCommands)
  ].slice(0, settings.maxKeywordQueries)
  const rawKeywordQueries = buildKeywordQueries(signals, cleanPrompt, settings, entityVocabulary)
  const plannedKeywordQueries = queryPlan
    ? normalizeKeywordQueries(queryPlan.keywordQueries, effectivePrompt, settings, queryPlan.resolvedQuery)
      .filter(query => !rawKeywordQueries.some(rawQuery => rawQuery.toLowerCase() === query.toLowerCase()))
    : []
  const keywordQueries = [...rawKeywordQueries, ...plannedKeywordQueries]

  const semanticQueries = queryPlan
    ? normalizeSemanticQueries(queryPlan.semanticQueries, signals, settings)
    : normalizeSemanticQueries([buildSemanticQuery(cleanPrompt, signals, settings)], signals, settings)
  const semanticQuery = semanticQueries.join('\n')

  // Embed any Haiku-expanded queries that differ from rawSemanticQuery using the
  // remaining timeout budget (preserving headroom for LanceDB + MMR).
  const embeddingQueries = Array.from(new Set([
    ...(rawSemanticQuery ? [rawSemanticQuery] : []),
    ...semanticQueries
  ]))
  const extraQueries = embeddingQueries.filter(query => query !== rawSemanticQuery)
  const remainingMs = options.deadlineMs !== undefined
    ? options.deadlineMs - Date.now()
    : embeddingTimeoutMs + RETRIEVAL_SEARCH_HEADROOM_MS
  const extraEmbedBudgetMs = Math.min(
    embeddingTimeoutMs,
    Math.max(0, remainingMs - RETRIEVAL_SEARCH_HEADROOM_MS)
  )

  const extraEmbedPromise = extraQueries.length > 0 && extraEmbedBudgetMs >= 300
    ? Promise.all(extraQueries.map(async query => {
        try {
          return { query, embedding: await embed(query, config, { signal, timeoutMs: extraEmbedBudgetMs }) }
        } catch (error) {
          if (signal?.aborted) throw error
          return { query, error }
        }
      }))
    : Promise.resolve([])

  const [rawEmbedResult, extraEmbedResults] = await Promise.all([rawEmbedPromise, extraEmbedPromise])
  if (rawEmbedResult?.aborted || (signal?.aborted && rawEmbedResult?.error)) {
    throw rawEmbedResult?.error ?? new Error('Retrieval aborted')
  }
  const embeddingResults = [
    ...(rawEmbedResult ? [rawEmbedResult] : []),
    ...extraEmbedResults
  ]
  const embeddingsByQuery = new Map<string, number[]>()
  const embeddingErrors: unknown[] = []
  for (const result of embeddingResults) {
    if ('embedding' in result && result.embedding) {
      embeddingsByQuery.set(result.query, result.embedding)
    } else if ('error' in result) {
      embeddingErrors.push(result.error)
    }
  }
  if (embeddingErrors.length > 0) {
    const outcome = embeddingsByQuery.size > 0 ? 'continuing with successful embeddings' : 'falling back to keyword-only search'
    console.error(`[claude-memory] ${embeddingErrors.length}/${embeddingQueries.length} embedding request(s) failed; ${outcome}:`, embeddingErrors[0])
  }
  const rawPromptEmbedding = rawSemanticQuery ? embeddingsByQuery.get(rawSemanticQuery) : undefined
  const embeddings = semanticQueries
    .map(query => embeddingsByQuery.get(query))
    .filter((embedding): embedding is number[] => Boolean(embedding))
  const suppressionEmbedding = embeddings[0] ?? rawPromptEmbedding

  const suppressionResolution = resolveSuppressedIds({
    sessionId: options.sessionId,
    session,
    embedding: suppressionEmbedding,
    settings,
    collection: config.lancedb.table,
    skipWriteback: options.skipSuppressionWriteback === true,
    stateVersion: suppressionStateVersion
  })
  const suppressedIds = suppressionResolution.ids
  suppressionStateVersion = suppressionResolution.stateVersion

  const candidateLimit = Math.max(config.injection.maxRecords * 3, config.injection.maxRecords)
  let searchQualifiedResult = await searchRankedCandidates({
    rawKeywordQueries,
    signalKeywordQueries,
    plannedKeywordQueries,
    config,
    settings,
    project,
    ancestorProjects,
    linkedWorkspaces,
    onlySharedScopes,
    // Hook retrieval deliberately leaves semantic search unscoped and relies
    // on the same-project score bonus. Explicit search callers can hard-scope
    // semantic candidates through the service's separate semanticProject.
    embeddings,
    rawPromptEmbedding,
    maxTimestamp: options.maxTimestamp,
    sourceLimit: candidateLimit,
    resultLimit: candidateLimit,
    signal,
    diagnostic
  })
  let results = searchQualifiedResult.results
  const signalKeywordMatchIds = searchQualifiedResult.signalKeywordMatchIds ?? new Set<string>()
  const searchNearMisses = diagnostic ? new Map<string, NearMissRecord>() : null
  if (diagnostic && searchNearMisses) {
    mergeNearMisses(searchNearMisses, searchQualifiedResult.nearMisses)
  }

  // Per-candidate signal-bypass gating: hold every candidate to
  // minSemanticSimilarity unless that specific candidate matched a genuine
  // error or command signal needle. Fallback and planned keywords never bypass
  // the semantic floor, even when another part of the prompt had a signal.
  const hasAnyEmbedding = Boolean(rawPromptEmbedding || embeddings.length > 0)
  if (settings.fallbackKeywordSemanticFloor && hasAnyEmbedding && settings.minSemanticSimilarity > 0) {
    const floored = results.filter(result =>
      result.similarity >= settings.minSemanticSimilarity
      || signalKeywordMatchIds.has(result.record.id)
    )
    if (diagnostic && searchNearMisses) {
      for (const result of results) {
        if (!floored.includes(result)) {
          searchNearMisses.set(result.record.id, {
            record: result,
            exclusionReasons: [buildExclusionReason('similarity_below_threshold', settings.minSemanticSimilarity, result.similarity)]
          })
        }
      }
    }
    results = floored
  }

  // Note: Global memories (scope="global") are already included via includeGlobal=true
  // in buildFilter. We no longer fallback to remove the project filter, as that
  // allowed project-scoped memories from OTHER projects to leak through.

  if (diagnostic && searchNearMisses) {
    for (const result of results) {
      searchNearMisses.delete(result.record.id)
    }
  }

  // Semantic anchor gate: if any embedding succeeded but no candidate cleared
  // the raw-prompt anchor threshold, retain only raw-derived keyword matches.
  // Skipped when all embeddings failed so keyword-only fallback still works.
  if ((rawPromptEmbedding || embeddings.length > 0) && results.length > 0 && settings.semanticAnchorThreshold > 0) {
    const rawSimilarities = new Map<string, number>()
    let maxRawSimilarity = 0
    if (rawPromptEmbedding) {
      for (const result of results) {
        const candidateEmbedding = result.record.embedding
        const similarity = candidateEmbedding && candidateEmbedding.length > 0
          ? cosineSimilarity(rawPromptEmbedding, candidateEmbedding)
          : 0
        rawSimilarities.set(result.record.id, similarity)
        maxRawSimilarity = Math.max(maxRawSimilarity, similarity)
      }
    }

    // If only Haiku embeddings succeeded, fail the semantic gate closed and
    // retain only raw-keyword matches. Haiku-only keywords must not rescue the
    // topicalized candidates.
    if (!rawPromptEmbedding || maxRawSimilarity < settings.semanticAnchorThreshold) {
      const rawKeywordMatchIds = searchQualifiedResult.rawKeywordMatchIds ?? new Set<string>()
      const rawKeywordQualificationScores = searchQualifiedResult.rawKeywordQualificationScores ?? new Map<string, number>()
      const survivors = results.filter(result =>
        (
          signalKeywordMatchIds.has(result.record.id)
          || (
            rawKeywordMatchIds.has(result.record.id)
            && (rawKeywordQualificationScores.get(result.record.id) ?? 0) >= settings.minScore
            && (!settings.fallbackKeywordSemanticFloor || (rawSimilarities.get(result.record.id) ?? 0) >= settings.minSemanticSimilarity)
          )
        )
        && (
          result.record.project === project
          || (result.record.project ? ancestorProjects.includes(result.record.project) : false)
          || (result.record.project ? linkedWorkspaces.includes(result.record.project) : false)
          || result.record.scope === 'global'
          || result.record.scope === 'environment'
        )
      )
      const suppressed = results.filter(result => !survivors.includes(result))
      const suppressedCount = suppressed.length
      const survivorCount = survivors.length
      const outcome = survivorCount > 0
        ? `keeping ${survivorCount} keyword survivor${survivorCount === 1 ? '' : 's'}; ${suppressedCount} candidate${suppressedCount === 1 ? '' : 's'} suppressed`
        : `injecting nothing (${suppressedCount} candidate${suppressedCount === 1 ? '' : 's'} suppressed)`
      const anchorDetail = rawPromptEmbedding
        ? `max raw-prompt similarity ${maxRawSimilarity.toFixed(3)} < threshold ${settings.semanticAnchorThreshold.toFixed(3)}`
        : 'raw-prompt embedding unavailable while expanded embeddings succeeded'
      console.error(`[claude-memory] Semantic anchor gate: ${anchorDetail}; ${outcome}`)
      if (diagnostic && searchNearMisses) {
        for (const result of suppressed) {
          searchNearMisses.set(result.record.id, {
            record: result,
            exclusionReasons: [buildExclusionReason(
              'semantic_anchor_gate',
              settings.semanticAnchorThreshold,
              rawSimilarities.get(result.record.id) ?? 0
            )]
          })
        }
      }
      results = survivors
    }
  }

  if (results.length > 0 && settings.enableRelationExpansion) {
    results = await expandViaRelations(results, config, settings, {
      project,
      ancestorProjects,
      linkedWorkspaces,
      maxTimestamp: options.maxTimestamp
    })
    if (settings.minExpandedScore > 0) {
      if (diagnostic && searchNearMisses) {
        for (const result of results) {
          if (result.via && result.score < settings.minExpandedScore) {
            searchNearMisses.set(result.record.id, {
              record: result,
              exclusionReasons: [buildExclusionReason('score_below_threshold', settings.minExpandedScore, result.score)]
            })
          }
        }
      }
      results = results.filter(result => !result.via || result.score >= settings.minExpandedScore)
    }
  }

  let suppressionExclusions: NearMissRecord[] = []
  if (suppressedIds.size > 0) {
    const suppressionResult = applyRecentlyInjectedSuppression(results, suppressedIds, settings)
    results = suppressionResult.results
    suppressionExclusions = suppressionResult.exclusions
    if (diagnostic && searchNearMisses) {
      mergeNearMisses(searchNearMisses, suppressionExclusions)
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
      finalResults = mmrResult.selected
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
    promptEmbedding: suppressionEmbedding,
    suppressionStateVersion,
    stage1Candidates: searchQualifiedResult.results,
    telemetry: {
      pipeline: 'legacy',
      project,
      stage1CandidateCount: searchQualifiedResult.results.length,
      bm25HitCount: searchQualifiedResult.results.filter(r => r.keywordMatch).length,
      vectorHitCount: searchQualifiedResult.results.filter(r => r.similarity > 0).length,
      suppressedCount: suppressionExclusions.length,
      rerankerCalled: false,
      rerankerAbstained: finalResults.length === 0,
      rerankerFallback: false
    },
    diagnostics: diagnostic
      ? {
          search: searchDiagnostics ?? { qualified: [], nearMisses: [] },
          mmrExclusions
        }
      : undefined
  }
}

function updateRetrievalPromptState(
  sessionId: string | undefined,
  searchResult: Pick<SearchMemoriesResult, 'promptEmbedding' | 'suppressionStateVersion'>,
  settings: RetrievalSettings,
  collection?: string,
  skipWriteback?: boolean
): number | undefined {
  if (skipWriteback || !sessionId || !settings.enableTopicSuppression) return undefined

  // In compaction-scoped ledger mode (topicChangeThreshold <= 0), we do not
  // track prompt-embedding drift; return the current version so pre-prompt
  // still appends newly injected IDs to the session ledger.
  if (settings.topicChangeThreshold <= 0) {
    return searchResult.suppressionStateVersion
  }

  const embedding = searchResult.promptEmbedding
  if (!embedding) return undefined

  try {
    const record = updateSessionPromptStateIfVersion(sessionId, {
      previousPromptEmbedding: embedding,
      lastPromptAt: new Date().toISOString(),
      expectedRetrievalStateVersion: searchResult.suppressionStateVersion
    }, collection)
    return record?.retrievalStateVersion
  } catch (error) {
    console.error('[claude-memory] Failed to update prompt suppression state:', error)
    return undefined
  }
}

function resolveSuppressedIds(args: {
  sessionId?: string
  session: ReturnType<typeof loadSessionTracking>
  embedding?: number[]
  settings: RetrievalSettings
  collection?: string
  skipWriteback?: boolean
  stateVersion: number
}): { ids: Set<string>; stateVersion: number } {
  const { sessionId, session, embedding, settings, collection, skipWriteback } = args
  if (!sessionId || !settings.enableTopicSuppression) {
    return { ids: new Set(), stateVersion: args.stateVersion }
  }
  if (settings.recentlyInjectedWindow <= 0) {
    return { ids: new Set(), stateVersion: args.stateVersion }
  }

  // Compaction-scoped session ledger (default: topicChangeThreshold === 0):
  // hard-suppress every memory already injected in this compaction epoch until
  // PreCompact explicitly resets the ledger, independent of prompt similarity.
  if (settings.topicChangeThreshold <= 0) {
    return {
      ids: new Set((session?.recentlyInjectedIds ?? []).slice(-settings.recentlyInjectedWindow)),
      stateVersion: args.stateVersion
    }
  }

  if (!embedding) {
    return { ids: new Set(), stateVersion: args.stateVersion }
  }

  const previousEmbedding = session?.previousPromptEmbedding
  if (!previousEmbedding || previousEmbedding.length === 0) {
    return { ids: new Set(), stateVersion: args.stateVersion }
  }

  const topicSimilarity = cosineSimilarity(embedding, previousEmbedding)
  if (topicSimilarity < settings.topicChangeThreshold) {
    const cleared = session?.recentlyInjectedIds?.length ?? 0
    console.error(
      `[claude-memory] Topic shift detected: prompt similarity ${topicSimilarity.toFixed(3)} < threshold ${settings.topicChangeThreshold.toFixed(3)}; clearing ${cleared} recently injected memor${cleared === 1 ? 'y' : 'ies'}`
    )
    let stateVersion = args.stateVersion
    if (!skipWriteback) {
      try {
        const record = updateSessionRetrievalState(sessionId, { recentlyInjectedIds: [] }, collection)
        stateVersion = record?.retrievalStateVersion ?? stateVersion
      } catch (error) {
        console.error('[claude-memory] Failed to clear recently injected memories after topic shift:', error)
      }
    }
    return { ids: new Set(), stateVersion }
  }

  return {
    ids: new Set((session?.recentlyInjectedIds ?? []).slice(-settings.recentlyInjectedWindow)),
    stateVersion: args.stateVersion
  }
}

type SuppressionResult = {
  results: HybridSearchResult[]
  exclusions: NearMissRecord[]
}

export function applyRecentlyInjectedSuppression(
  candidates: HybridSearchResult[],
  suppressedIds: Set<string>,
  settings: Pick<RetrievalSettings, 'suppressionMode' | 'suppressionPenalty'>
): SuppressionResult {
  if (candidates.length === 0 || suppressedIds.size === 0) {
    return { results: candidates, exclusions: [] }
  }

  const mode: SuppressionMode = settings.suppressionMode === 'hard' ? 'hard' : 'soft'
  const penalty = Math.min(1, Math.max(0, settings.suppressionPenalty))
  const results: HybridSearchResult[] = []
  const exclusions: NearMissRecord[] = []

  for (const candidate of candidates) {
    if (!suppressedIds.has(candidate.record.id)) {
      results.push(candidate)
      continue
    }

    const originalScore = candidate.score
    const suppression = { suppressed: true as const, mode, originalScore }

    if (mode === 'hard') {
      const suppressedCandidate = { ...candidate, suppression }
      exclusions.push({
        record: suppressedCandidate,
        exclusionReasons: [
          buildExclusionReason('recently_injected_suppression', originalScore, 0)
        ]
      })
      continue
    }

    results.push({
      ...candidate,
      score: originalScore * (1 - penalty),
      suppression
    })
  }

  return {
    results: mode === 'soft' ? sortByScore(results) : results,
    exclusions
  }
}

type RelationExpansionCandidate = {
  targetId: string
  parent: HybridSearchResult
  kind: RelationKind
  hop: number
  rootScore: number
  rootSimilarity: number
  cumulativeWeight: number
  score: number
  similarity: number
}

type RelationExpansionFrontierEntry = {
  result: HybridSearchResult
  rootScore: number
  rootSimilarity: number
  cumulativeWeight: number
}

export async function expandViaRelations(
  initialResults: HybridSearchResult[],
  config: Config,
  settings: Pick<RetrievalSettings, 'maxRelationHops' | 'maxRelationExpansions' | 'relationHopDecay' | 'enableEntityEdges'>,
  scope?: { project?: string; ancestorProjects?: string[]; linkedWorkspaces?: string[]; maxTimestamp?: number }
): Promise<HybridSearchResult[]> {
  const maxHops = Math.max(0, Math.trunc(settings.maxRelationHops))
  const maxExpansions = Math.max(0, Math.trunc(settings.maxRelationExpansions))
  const hopDecay = Math.min(1, Math.max(0.1, settings.relationHopDecay))
  if (initialResults.length === 0 || maxHops <= 0 || maxExpansions <= 0) return initialResults

  const byId = new Map<string, HybridSearchResult>()
  for (const result of initialResults) {
    byId.set(result.record.id, result)
  }

  let frontier: RelationExpansionFrontierEntry[] = initialResults.map(result => ({
    result,
    rootScore: result.score,
    rootSimilarity: result.similarity,
    cumulativeWeight: 1
  }))
  const expanded: HybridSearchResult[] = []

  const canonicalScopeProject = scope?.project ? canonicalizePath(scope.project) : undefined
  const canonicalAncestorProjects = scope?.ancestorProjects
    ? new Set(scope.ancestorProjects.map(ancestor => canonicalizePath(ancestor)))
    : undefined
  const canonicalLinkedWorkspaces = scope?.linkedWorkspaces
    ? new Set(scope.linkedWorkspaces.map(workspace => canonicalizePath(workspace)))
    : undefined

  for (let hop = 1; hop <= maxHops && expanded.length < maxExpansions; hop += 1) {
    const candidatesById = new Map<string, RelationExpansionCandidate>()

    for (const parent of frontier) {
      for (const relation of parent.result.record.relations ?? []) {
        if (!relation.targetId || relation.weight <= 0) continue
        if (relation.kind === 'shares_entity' && !settings.enableEntityEdges) continue
        if (byId.has(relation.targetId)) continue

        const decay = Math.pow(hopDecay, hop)
        const cumulativeWeight = parent.cumulativeWeight * relation.weight
        const score = parent.rootScore * cumulativeWeight * decay
        if (score <= 0) continue

        const candidate: RelationExpansionCandidate = {
          targetId: relation.targetId,
          parent: parent.result,
          kind: relation.kind,
          hop,
          rootScore: parent.rootScore,
          rootSimilarity: parent.rootSimilarity,
          cumulativeWeight,
          score,
          similarity: Math.max(0, Math.min(1, parent.rootSimilarity * cumulativeWeight * decay))
        }
        const existing = candidatesById.get(relation.targetId)
        if (!existing || candidate.score > existing.score) {
          candidatesById.set(relation.targetId, candidate)
        }
      }
    }

    if (candidatesById.size === 0) break

    let fetchedRecords: MemoryRecord[]
    try {
      fetchedRecords = await fetchRecordsByIds([...candidatesById.keys()], config, { includeEmbeddings: true })
    } catch (error) {
      console.error('[claude-memory] Relation expansion lookup failed:', error)
      break
    }

    const recordsById = new Map(fetchedRecords.map(record => [record.id, record]))
    const nextFrontier: RelationExpansionFrontierEntry[] = []
    const candidates = Array.from(candidatesById.values())
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score
        return a.targetId.localeCompare(b.targetId)
      })

    for (const candidate of candidates) {
      if (expanded.length >= maxExpansions) break
      if (byId.has(candidate.targetId)) continue

      const record = recordsById.get(candidate.targetId)
      if (!record || record.deprecated) continue
      if (
        typeof scope?.maxTimestamp === 'number'
        && Number.isFinite(scope.maxTimestamp)
        && typeof record.timestamp === 'number'
        && record.timestamp >= scope.maxTimestamp
      ) {
        continue
      }
      if (canonicalScopeProject && record.scope !== 'global' && record.scope !== 'environment' && record.project) {
        const canonicalRecordProject = canonicalizePath(record.project)
        const canonicalParentProject = candidate.parent.record.scope !== 'global' && candidate.parent.record.scope !== 'environment' && candidate.parent.record.project
          ? canonicalizePath(candidate.parent.record.project)
          : undefined
        if (
          canonicalRecordProject !== canonicalScopeProject
          && !(canonicalAncestorProjects?.has(canonicalRecordProject))
          && !(canonicalLinkedWorkspaces?.has(canonicalRecordProject))
          && canonicalParentProject !== canonicalRecordProject
        ) {
          continue
        }
      }

      const result: HybridSearchResult = {
        record,
        score: candidate.score,
        similarity: candidate.similarity,
        keywordMatch: false,
        via: {
          parentId: candidate.parent.record.id,
          kind: candidate.kind,
          hop: candidate.hop
        }
      }
      byId.set(record.id, result)
      expanded.push(result)
      nextFrontier.push({
        result,
        rootScore: candidate.rootScore,
        rootSimilarity: candidate.rootSimilarity,
        cumulativeWeight: candidate.cumulativeWeight
      })
    }

    frontier = nextFrontier
    if (frontier.length === 0) break
  }

  return [...initialResults, ...expanded]
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

  // If no embeddings are available, preserve score ordering and enforce the
  // same global limit as the embedding-backed MMR branch.
  if (withEmbeddings.length === 0) {
    const ordered = sortByScore(candidates)
    const selected = ordered.slice(0, limit)
    return diagnostic ? { selected, ordered, exclusions: [] } : selected
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

export function extractFallbackKeywords(cleanPrompt: string, maxKeywords = Number.POSITIVE_INFINITY): string[] {
  const normalizedPrompt = stripNoiseWords(cleanPrompt).normalize('NFC')
  const tokens = normalizedPrompt.match(FALLBACK_TOKEN_PATTERN) ?? []
  const seenLower = new Set<string>()
  const keywords: string[] = []

  for (const token of tokens) {
    const lower = token.toLowerCase()
    if (seenLower.has(lower) || FALLBACK_KEYWORD_STOPWORDS.has(lower)) continue

    const tokenLength = Array.from(token).length
    const isShortTechKeyword = FALLBACK_SHORT_TECH_KEYWORDS.has(lower)
    const isAcronym = tokenLength >= 3 && /^\p{Lu}[\p{Lu}\p{N}_+-]+$/u.test(token)
    const isProperNoun = tokenLength >= 3 && /^\p{Lu}/u.test(token)
    const isVersionish = /^v?\d+(?:\.\d+)+(?:[-+][A-Za-z0-9.]+)?$/i.test(token)
    const isPathish = /[/:\\]/.test(token) || /\.[A-Za-z0-9]+/.test(token)
    const hasDigit = /\d/.test(token)
    const isPlainLowercase = /^[\p{Ll}\p{M}]+$/u.test(token)
    const keep = (
      isShortTechKeyword ||
      isProperNoun ||
      isAcronym ||
      hasDigit ||
      isVersionish ||
      isPathish ||
      (isPlainLowercase && tokenLength >= 4)
    )
    if (!keep) continue

    keywords.push(lower)
    seenLower.add(lower)
    if (keywords.length >= maxKeywords) break
  }

  return keywords
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
    result.push(...extractFallbackKeywords(fallback, settings.maxKeywordQueries))
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

function normalizeSemanticQueries(
  semanticQueries: string[],
  signals: ContextSignals,
  settings: RetrievalSettings
): string[] {
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const query of semanticQueries) {
    const entry = normalizeSemanticQuery(query, signals, settings)
    if (!entry) continue
    const key = entry.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    normalized.push(entry)
  }
  return normalized
}

export function buildKeywordQueries(
  signals: ContextSignals,
  cleanPrompt: string,
  settings: RetrievalSettings,
  entityVocabulary?: ReadonlySet<string>
): string[] {
  const errorQueries = signals.errors.slice(0, settings.maxKeywordErrors)
  const commandQueries = signals.commands.slice(0, settings.maxKeywordCommands)
  const queries = [...errorQueries, ...commandQueries]

  // Fallback: if no specific signals, use conservative discrete needles.
  if (queries.length === 0 && cleanPrompt.trim()) {
    queries.push(...extractFallbackKeywords(cleanPrompt, settings.maxKeywordQueries))
  }

  const base = queries.length <= settings.maxKeywordQueries
    ? queries
    : queries.slice(0, settings.maxKeywordQueries)
  if (!settings.enableEntityKeywords) return base

  // Entity needles get a separate small budget appended AFTER the
  // maxKeywordQueries slice so they never displace error/command queries and
  // flag-off behavior stays byte-identical.
  const seen = new Set(base.map(query => query.toLowerCase()))
  for (const needle of extractEntityNeedles(cleanPrompt, ENTITY_NEEDLE_CAP, entityVocabulary)) {
    if (seen.has(needle)) continue
    seen.add(needle)
    base.push(needle)
  }
  return base
}

/**
 * Distinct entity strings across the table, used to recognize prompt tokens
 * that are known entities but look like ordinary words (lowercase hostnames).
 * One full-table scan per process, cached per directory::table. Fine for the
 * eval harness and short-lived hook processes with the flag off; production
 * enablement of enableEntityKeywords should replace this with a maintained
 * vocabulary artifact.
 */
const entityVocabularyCache = new Map<string, ReadonlySet<string>>()

async function loadEntityVocabulary(config: Config): Promise<ReadonlySet<string>> {
  const key = `${config.lancedb.directory}::${config.lancedb.table}`
  const cached = entityVocabularyCache.get(key)
  if (cached) return cached

  const vocabulary = new Set<string>()
  try {
    for await (const record of iterateRecords({ filter: 'deprecated = false' }, config)) {
      for (const entity of record.entities ?? []) vocabulary.add(entity)
    }
  } catch (error) {
    console.error('[claude-memory] Entity vocabulary load failed; needles fall back to shape heuristics:', error)
  }
  entityVocabularyCache.set(key, vocabulary)
  return vocabulary
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
