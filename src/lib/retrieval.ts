import { truncateText, withTimeout } from './shared.js'
import { closeLanceDB, initLanceDB, hybridSearch, computeUsageRatio, fetchRecordsByIds, iterateRecords } from './lancedb.js'
import { ENTITY_TOKEN_PATTERN, extractEntityNeedles } from './entities.js'
import { buildContext, extractSignals, findAncestorProjects, stripNoiseWords, type ContextSignals } from './context.js'
import { embed } from './embed.js'
import { mergeNearMisses, buildExclusionReason } from './diagnostics.js'
import { generateRetrievalQueryPlan } from './retrieval-query-generator.js'
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
  type HybridSearchParams,
  type MemoryRecord,
  type NearMissRecord,
  type PrePromptInput,
  type RelationKind,
  type SuppressionMode
} from './types.js'

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
}

export interface RetrievalResult {
  context: string | null
  signals: ContextSignals
  results: HybridSearchResult[]
  injectedRecords: MemoryRecord[]
  timedOut: boolean
  diagnostics?: RetrievalDiagnostics
  suppressionWritebackVersion?: number
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
        {
          diagnostic,
          transcriptPath: input.transcriptPath,
          sessionId: input.sessionId,
          skipSuppressionWriteback: input.skipSuppressionWriteback
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
          diagnostics: searchResult.diagnostics
            ? { search: searchResult.diagnostics.search, context: contextResult }
            : undefined
        }
      }

      if (results.length === 0) {
        const suppressionWritebackVersion = updateRetrievalPromptState(input.sessionId, searchResult, settings, runtimeConfig.lancedb.table, input.skipSuppressionWriteback)
        return { context: null, results, injectedRecords: [], suppressionWritebackVersion }
      }

      const { context, records: injectedRecords } = buildContext(results, runtimeConfig)
      const suppressionWritebackVersion = updateRetrievalPromptState(input.sessionId, searchResult, settings, runtimeConfig.lancedb.table, input.skipSuppressionWriteback)
      return { context: context || null, results, injectedRecords, suppressionWritebackVersion }
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
    diagnostics: result.value?.diagnostics,
    suppressionWritebackVersion: result.value?.suppressionWritebackVersion
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
  }, config, options)
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
}

type SearchWithScopeResult = {
  results: HybridSearchResult[]
  nearMisses: NearMissRecord[]
  rawKeywordMatchIds?: Set<string>
  rawKeywordQualificationScores?: Map<string, number>
}

async function searchMemories(
  prompt: string,
  signals: ContextSignals,
  config: Config,
  settings: RetrievalSettings,
  cwd: string,
  signal?: AbortSignal,
  options: { diagnostic?: boolean; transcriptPath?: string; sessionId?: string; skipSuppressionWriteback?: boolean } = {}
): Promise<SearchMemoriesResult> {
  const cleanPrompt = stripNoiseWords(prompt)
  const diagnostic = options.diagnostic === true
  const session = options.sessionId && settings.enableTopicSuppression
    ? loadSessionTracking(options.sessionId, config.lancedb.table)
    : null
  let suppressionStateVersion = session?.retrievalStateVersion ?? 0

  const queryPlanResult = settings.enableHaikuRetrieval
    ? await generateRetrievalQueryPlan(
        prompt,
        options.transcriptPath,
        { signal, timeoutMs: settings.haikuQueryTimeoutMs, expansionCount: settings.haikuExpansionCount }
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
  const rawSemanticQuery = buildSemanticQuery(cleanPrompt, signals, settings)
  const project = signals.projectRoot ?? cwd
  const ancestorProjects = project ? findAncestorProjects(project) : []

  // Embed the raw prompt independently from Haiku variants. Haiku embeddings
  // improve recall/ranking, but only the raw embedding may open the anchor gate.
  const embeddingQueries = Array.from(new Set([
    ...(rawSemanticQuery ? [rawSemanticQuery] : []),
    ...semanticQueries
  ]))
  const embeddingResults = await Promise.all(embeddingQueries.map(async query => {
    try {
      return { query, embedding: await embed(query, config, { signal }) }
    } catch (error) {
      if (signal?.aborted) throw error
      return { query, error }
    }
  }))
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

  let searchQualifiedResult = await searchWithScope(
    rawKeywordQueries,
    plannedKeywordQueries,
    config,
    settings,
    project,
    ancestorProjects,
    embeddings,
    rawPromptEmbedding,
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
        rawKeywordMatchIds.has(result.record.id) &&
        (rawKeywordQualificationScores.get(result.record.id) ?? 0) >= settings.minScore &&
        (
          result.record.project === project ||
          (result.record.project ? ancestorProjects.includes(result.record.project) : false) ||
          result.record.scope === 'global'
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
    results = await expandViaRelations(results, config, settings)
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
  const embedding = searchResult.promptEmbedding
  if (skipWriteback || !sessionId || !settings.enableTopicSuppression || !embedding) return undefined

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
  if (!sessionId || !settings.enableTopicSuppression || !embedding) {
    return { ids: new Set(), stateVersion: args.stateVersion }
  }
  if (settings.recentlyInjectedWindow <= 0) {
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
  rawKeywordQueries: string[],
  plannedKeywordQueries: string[],
  config: Config,
  settings: RetrievalSettings,
  project: string | undefined,
  ancestorProjects: string[],
  precomputedEmbeddings: number[][] = [],
  rawPromptEmbedding?: number[],
  signal?: AbortSignal,
  options: { diagnostic?: boolean } = {}
): Promise<SearchWithScopeResult> {
  const maxRecords = config.injection.maxRecords
  const candidateLimit = Math.max(maxRecords * 3, maxRecords)
  const resultsById = new Map<string, HybridSearchResult>()
  const rawKeywordMatchIds = new Set<string>()
  const rawKeywordScores = new Map<string, number>()
  const rawKeywordQualificationScores = new Map<string, number>()
  const diagnostic = options.diagnostic === true
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
      limit: candidateLimit,
      project,
      ancestorProjects,
      excludeDeprecated: true,
      vectorWeight: 0,
      keywordWeight: 1,
      keywordLimit: candidateLimit * search.queries.length,
      usageRatioWeight: settings.usageRatioWeight,
      includeEmbeddings: true,
      signal
    }, config, diagnostic)
  })))
  for (const keywordResults of keywordResultSets) {
    for (const item of keywordResults.result.results) {
      if (keywordResults.raw) {
        rawKeywordScores.set(
          item.record.id,
          Math.max(rawKeywordScores.get(item.record.id) ?? Number.NEGATIVE_INFINITY, item.score)
        )
      }
      upsertResult(item)
      if (keywordResults.raw) rawKeywordMatchIds.add(item.record.id)
    }
    if (diagnostic && nearMisses) {
      mergeNearMisses(nearMisses, keywordResults.result.nearMisses)
    }
  }

  if (precomputedEmbeddings.length > 0) {
    // Semantic search runs WITHOUT project filter. Embedding similarity
    // minSemanticSimilarity already gates relevance, and the
    // projectMatchBonus in unified re-scoring ranks same-project memories
    // higher. Hard project filtering here excluded relevant memories from
    // sibling repos (e.g., aura-billing-agent invisible when searching
    // from aura) — the exact scenario the scoring formula handles well.
    // Keyword search keeps its project filter since substring matching is
    // too broad without it.
    const semanticResultSets = await Promise.all(
      precomputedEmbeddings.map(embedding => runHybridSearch({
        query: '', // Not used when embedding provided
        embedding,
        limit: candidateLimit,
        excludeDeprecated: true,
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

  if (precomputedEmbeddings.length > 0 || rawPromptEmbedding) {
    for (const item of allCandidates) {
      const candidateEmbedding = item.record.embedding
      let rankingScore = item.score

      if (precomputedEmbeddings.length > 0) {
        // Compute real cosine similarity for keyword-only matches that came in with similarity=0.
        if (item.similarity === 0 && item.keywordMatch && candidateEmbedding && candidateEmbedding.length > 0) {
          item.similarity = maxCosineSimilarity(precomputedEmbeddings, candidateEmbedding)
        }
        const usageRatio = computeUsageRatio(item.record)
        // Scale keyword bonus by similarity: low-similarity keyword matches get proportionally
        // less boost, preventing broad substring matches from rescuing irrelevant results.
        rankingScore = computeUnifiedScore({
          similarity: item.similarity,
          keywordMatch: item.keywordMatch,
          usageRatio,
          projectMatch: Boolean(project && item.record.project === project),
          settings
        }).total
      }

      if (!rawKeywordMatchIds.has(item.record.id)) {
        item.score = rankingScore
        continue
      }

      // Raw-keyword candidates must reach the raw anchor gate even when Haiku
      // topicalized away from them. Qualify those candidates against the raw
      // prompt when possible; if the raw embedding is unavailable, retain the
      // keyword search's original score for the fail-closed survivor path.
      let qualificationScore = rawKeywordScores.get(item.record.id) ?? item.score
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
  // When no embeddings are available (embedding generation failed),
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
  return {
    results: rankedResults,
    nearMisses: Array.from(nearMisses?.values() ?? []),
    rawKeywordMatchIds,
    rawKeywordQualificationScores
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
  settings: Pick<RetrievalSettings, 'maxRelationHops' | 'maxRelationExpansions' | 'relationHopDecay' | 'enableEntityEdges'>
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
