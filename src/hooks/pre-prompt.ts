#!/usr/bin/env -S npx tsx

import path from 'path'
import { fileURLToPath } from 'url'
import { SKIP_MARKER, getCommandFilePath } from '../lib/claude-commands.js'
import { readFileIfExists } from '../lib/shared.js'
import { closeMilvus, initMilvus, hybridSearch } from '../lib/milvus.js'
import { buildContext, extractSignals, findGitRoot, formatRecordSnippet, stripNoiseWords, type ContextSignals } from '../lib/context.js'
import { embed } from '../lib/embed.js'
import { loadConfig } from '../lib/config.js'
import { mergeNearMisses } from '../lib/diagnostics.js'
import { generateRetrievalQueryPlan } from '../lib/retrieval-query-generator.js'
import { loadSettings, type RetrievalSettings } from '../lib/settings.js'
import {
  DEFAULT_CONFIG,
  type Config,
  type DiagnosticContextResult,
  type DiagnosticSearchResults,
  type ExclusionReason,
  type HybridSearchResult,
  type HybridSearchParams,
  type InjectionStatus,
  type MemoryRecord,
  type NearMissRecord,
  type PrePromptInput,
  type UserPromptSubmitInput
} from '../lib/types.js'
import { appendSessionTracking } from '../lib/session-tracking.js'

const MAX_KEYWORD_QUERIES = 4
const MAX_KEYWORD_ERRORS = 2
const MAX_KEYWORD_COMMANDS = 2
const PREPROMPT_TIMEOUT_MS = 4000
const HAIKU_QUERY_TIMEOUT_MS = 1500
const MAX_SEMANTIC_QUERY_CHARS = 1200

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

export interface PrePromptResult {
  context: string | null
  signals: ContextSignals
  results: HybridSearchResult[]
  injectedRecords: MemoryRecord[]
  timedOut: boolean
  diagnostics?: PrePromptDiagnostics
}

export interface PrePromptDiagnostics {
  search: DiagnosticSearchResults
  context: DiagnosticContextResult
}

/**
 * Core pre-prompt hook logic. Exported for testing.
 *
 * Searches memories based on the prompt and returns formatted context.
 */
export async function handlePrePrompt(
  input: PrePromptInput,
  config: Config = DEFAULT_CONFIG,
  options: { projectRoot?: string; settingsOverride?: Partial<RetrievalSettings>; diagnostic?: boolean } = {}
): Promise<PrePromptResult> {
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

  const result = await runWithTimeout(async (signal) => {
    const unregister = registerAbortCleanup(signal, () => {
      void closeMilvus()
    })
    try {
      await initMilvus(runtimeConfig)
      const searchResult = await searchMemories(
        input.prompt,
        signals,
        runtimeConfig,
        settings,
        input.cwd,
        signal,
        { diagnostic, transcriptPath: input.transcript_path }
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
  }, PREPROMPT_TIMEOUT_MS, () => {
    void closeMilvus()
  })

  if (!result.completed) {
    return {
      context: null,
      signals,
      results: [],
      injectedRecords: [],
      timedOut: true
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

  const queryPlan = await generateRetrievalQueryPlan(
    prompt,
    options.transcriptPath,
    config,
    { signal, timeoutMs: HAIKU_QUERY_TIMEOUT_MS }
  )
  const resolvedPrompt = queryPlan?.resolvedQuery
    ? stripNoiseWords(queryPlan.resolvedQuery)
    : cleanPrompt
  const effectivePrompt = resolvedPrompt || cleanPrompt
  const effectiveDomain = queryPlan?.domain ?? signals.domain
  const signalsForQuery = effectiveDomain === signals.domain
    ? signals
    : { ...signals, domain: effectiveDomain }

  const keywordQueries = queryPlan
    ? normalizeKeywordQueries(queryPlan.keywordQueries, effectivePrompt)
    : buildKeywordQueries(signals, cleanPrompt)

  const semanticBase = queryPlan?.semanticQuery?.trim()
  const semanticQuery = semanticBase
    ? normalizeSemanticQuery(semanticBase, signalsForQuery)
    : buildSemanticQuery(cleanPrompt, signalsForQuery)
  const scope = {
    project: signals.projectRoot ?? cwd,
    domain: signalsForQuery.domain
  }

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
    scope,
    embedding,
    signal,
    { diagnostic }
  )
  let results = searchQualifiedResult.results
  const searchNearMisses = diagnostic ? new Map<string, NearMissRecord>() : null
  if (diagnostic && searchNearMisses) {
    mergeNearMisses(searchNearMisses, searchQualifiedResult.nearMisses)
  }

  if (results.length === 0 && scope.project) {
    // Fallback: remove project filter but preserve domain to avoid cross-domain noise
    console.error('[claude-memory] No project-scoped hits; retrying with domain filter only.')
    searchQualifiedResult = await searchWithScope(
      keywordQueries,
      config,
      settings,
      { domain: scope.domain },
      embedding,
      signal,
      { diagnostic }
    )
    results = searchQualifiedResult.results
    if (diagnostic && searchNearMisses) {
      mergeNearMisses(searchNearMisses, searchQualifiedResult.nearMisses)
    }
  }

  if (diagnostic && searchNearMisses) {
    for (const result of results) {
      searchNearMisses.delete(result.record.id)
    }
  }

  const searchDiagnostics = diagnostic
    ? {
        qualified: results,
        nearMisses: Array.from(searchNearMisses?.values() ?? [])
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
  scope: { project?: string; domain?: string },
  precomputedEmbedding?: number[],
  signal?: AbortSignal,
  options: { diagnostic?: boolean } = {}
): Promise<SearchWithScopeResult> {
  const maxRecords = config.injection.maxRecords
  const resultsById = new Map<string, HybridSearchResult>()
  const diagnostic = options.diagnostic === true
  const limit = maxRecords
  const nearMisses = diagnostic ? new Map<string, NearMissRecord>() : null

  console.error(`[claude-memory] Search scope: keywords=${keywordQueries.length}, project=${scope.project ?? 'none'}, domain=${scope.domain ?? 'none'}`)

  for (const query of keywordQueries) {
    if (resultsById.size >= limit) break
    const keywordResults = await runHybridSearch({
      query,
      limit,
      project: scope.project,
      domain: scope.domain,
      excludeDeprecated: true,
      vectorWeight: 0,
      keywordWeight: 1,
      keywordLimit: limit,
      usageRatioWeight: settings.usageRatioWeight,
      includeEmbeddings: true,
      signal
    }, config, diagnostic)
    for (const item of keywordResults.results) {
      if (resultsById.size >= limit) break
      if (!resultsById.has(item.record.id)) {
        resultsById.set(item.record.id, item)
      }
    }
    if (diagnostic && nearMisses) {
      mergeNearMisses(nearMisses, keywordResults.nearMisses)
    }
  }

  if (precomputedEmbedding) {
    const semanticResults = await runHybridSearch({
      query: '', // Not used when embedding provided
      embedding: precomputedEmbedding,
      limit,
      project: scope.project,
      domain: scope.domain,
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
      const existing = resultsById.get(item.record.id)
      if (existing) {
        // Merge: record was found by both keyword and semantic search
        existing.similarity = Math.max(existing.similarity, item.similarity)
        existing.score = Math.max(existing.score, item.score)
      } else if (resultsById.size < limit) {
        resultsById.set(item.record.id, item)
      }
    }
    if (diagnostic && nearMisses) {
      mergeNearMisses(nearMisses, semanticResults.nearMisses)
    }
  }

  const filteredResults = Array.from(resultsById.values())
    .filter(result => result.keywordMatch || result.score >= settings.minScore)
  if (diagnostic && nearMisses) {
    for (const result of filteredResults) {
      nearMisses.delete(result.record.id)
    }
  }
  return { results: filteredResults, nearMisses: Array.from(nearMisses?.values() ?? []) }
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

function normalizeKeywordQueries(queries: string[], fallback: string): string[] {
  const trimmed = queries.map(query => query.trim()).filter(query => query.length > 0)
  const deduped: string[] = []
  const seen = new Set<string>()

  for (const entry of trimmed) {
    if (seen.has(entry)) continue
    deduped.push(entry)
    seen.add(entry)
  }

  if (deduped.length === 0 && fallback.trim()) {
    deduped.push(fallback.trim())
  }

  if (deduped.length <= MAX_KEYWORD_QUERIES) return deduped
  return deduped.slice(0, MAX_KEYWORD_QUERIES)
}

function normalizeSemanticQuery(semanticQuery: string, signals: ContextSignals): string {
  const trimmed = semanticQuery.trim()
  if (!trimmed) return ''

  const parts = [trimmed]
  const lowered = trimmed.toLowerCase()
  if (signals.projectName && !lowered.includes('project:')) {
    parts.push(`project: ${signals.projectName}`)
  }
  if (signals.domain && !lowered.includes('domain:')) {
    parts.push(`domain: ${signals.domain}`)
  }

  return truncateText(parts.join('\n'), MAX_SEMANTIC_QUERY_CHARS)
}

function buildKeywordQueries(signals: ContextSignals, cleanPrompt: string): string[] {
  const errorQueries = signals.errors.slice(0, MAX_KEYWORD_ERRORS)
  const commandQueries = signals.commands.slice(0, MAX_KEYWORD_COMMANDS)
  const queries = [...errorQueries, ...commandQueries]

  // Fallback: if no specific signals, use the prompt itself for keyword matching.
  if (queries.length === 0 && cleanPrompt.trim()) {
    queries.push(cleanPrompt.trim())
  }

  if (queries.length <= MAX_KEYWORD_QUERIES) return queries
  return queries.slice(0, MAX_KEYWORD_QUERIES)
}

function buildSemanticQuery(prompt: string, signals: ContextSignals): string {
  const trimmed = prompt.trim()
  if (!trimmed) return ''

  const parts = [trimmed]
  if (signals.projectName) parts.push(`project: ${signals.projectName}`)
  if (signals.domain) parts.push(`domain: ${signals.domain}`)

  return truncateText(parts.join('\n'), MAX_SEMANTIC_QUERY_CHARS)
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return value.slice(0, maxLength - 3) + '...'
}

/**
 * Check if injection should be skipped for this prompt.
 *
 * Checks:
 * 1. If prompt content contains the skip marker directly
 * 2. If prompt is a slash command whose file contains the skip marker
 */
function shouldSkipInjection(prompt: string): boolean {
  // Direct marker check (for expanded command content)
  if (prompt.includes(SKIP_MARKER)) {
    return true
  }

  // Check if it's a slash command
  const trimmed = prompt.trim()
  const match = trimmed.match(/^\/([a-zA-Z0-9_-]+)(?:\s|$)/)
  if (!match) {
    return false
  }

  const commandName = match[1]

  // Check user commands directory
  const userCommandPath = getCommandFilePath(commandName)
  if (commandFileHasSkipMarker(userCommandPath)) {
    return true
  }

  // Could also check project commands (.claude/commands/) if needed
  // but user commands are the primary use case for now

  return false
}

function commandFileHasSkipMarker(filePath: string): boolean {
  try {
    const content = readFileIfExists(filePath)
    return content !== null && content.includes(SKIP_MARKER)
  } catch {
    // File doesn't exist or can't be read - don't skip
    return false
  }
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

async function runWithTimeout<T>(
  task: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void
): Promise<{ completed: boolean; value?: T }> {
  let timeoutId: NodeJS.Timeout | null = null
  const controller = new AbortController()
  try {
    const timeoutPromise = new Promise<{ completed: boolean }>(resolve => {
      timeoutId = setTimeout(() => {
        controller.abort()
        if (onTimeout) {
          try {
            onTimeout()
          } catch (error) {
            console.error('[claude-memory] Timeout cleanup failed:', error)
          }
        }
        resolve({ completed: false })
      }, timeoutMs)
    })
    const taskPromise = task(controller.signal)
      .then(value => ({ completed: true as const, value }))
      .catch(error => {
        if (controller.signal.aborted) {
          return { completed: false as const }
        }
        return { completed: true as const, error }
      })
    const result = await Promise.race([taskPromise, timeoutPromise])
    if (result.completed && 'error' in result) throw result.error
    return result
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

async function readHookInput(): Promise<UserPromptSubmitInput | null> {
  const raw = await readStdin()
  if (!raw.trim()) {
    console.error('[claude-memory] Empty hook input.')
    return null
  }

  try {
    return JSON.parse(raw) as UserPromptSubmitInput
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to parse hook input: ${message}`)
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    process.stdin.setEncoding('utf-8')
    process.stdin.on('data', chunk => {
      data += chunk
    })
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', reject)
  })
}

async function main(): Promise<void> {
  const payload = await readHookInput()
  if (!payload) return

  try {
    if (payload.hook_event_name !== 'UserPromptSubmit') {
      console.error('[claude-memory] Unexpected hook event:', payload.hook_event_name)
      return
    }

    if (!payload.prompt || !payload.prompt.trim()) {
      console.error('[claude-memory] Empty prompt; skipping injection.')
      trackSession(payload.session_id, [], [], payload.cwd, payload.prompt, 'empty_prompt')
      return
    }

    // Skip injection if prompt contains skip marker (expanded command content)
    // or if it's a slash command whose file contains the skip marker
    if (shouldSkipInjection(payload.prompt)) {
      console.error('[claude-memory] Skip marker detected; skipping injection.')
      return
    }

    const projectRoot = findGitRoot(payload.cwd)
    const configRoot = projectRoot ?? payload.cwd
    const config = loadConfig(configRoot)

    const result = await handlePrePrompt(payload, config, { projectRoot })

    if (result.timedOut) {
      console.error(`[claude-memory] Pre-prompt timed out after ${PREPROMPT_TIMEOUT_MS}ms; skipping injection.`)
      trackSession(payload.session_id, [], [], payload.cwd, payload.prompt, 'timeout')
      return
    }

    if (result.results.length === 0) {
      console.error('[claude-memory] No matching memories found.')
      trackSession(payload.session_id, [], [], payload.cwd, payload.prompt, 'no_matches')
      return
    }

    if (!result.context) {
      console.error('[claude-memory] Context empty after formatting.')
      trackSession(payload.session_id, [], [], payload.cwd, payload.prompt, 'no_matches')
      return
    }

    let injected = false
    try {
      await writeStdout(result.context)
      injected = true
    } catch (error) {
      console.error('[claude-memory] Failed to write injected context:', error)
    }

    if (injected) {
      trackSession(payload.session_id, result.injectedRecords, result.results, payload.cwd, payload.prompt, 'injected')
    } else {
      trackSession(payload.session_id, [], [], payload.cwd, payload.prompt, 'error')
    }
  } finally {
    await closeMilvus()
  }
}

function trackSession(
  sessionId: string,
  records: MemoryRecord[],
  searchResults: HybridSearchResult[],
  cwd: string,
  prompt: string,
  status: InjectionStatus
): void {
  if (!sessionId) return

  // Strip noise words (ultrathink, etc.) before storing
  const cleanPrompt = stripNoiseWords(prompt)

  // Build lookup map for retrieval metadata
  const resultById = new Map(searchResults.map(r => [r.record.id, r]))

  const injectedAt = Date.now()
  const entries = records.map(record => {
    const searchResult = resultById.get(record.id)
    return {
      id: record.id,
      snippet: normalizeSnippet(formatRecordSnippet(record) ?? `type: ${record.type}`),
      type: record.type,
      injectedAt,
      // Include retrieval trigger metadata
      similarity: searchResult?.similarity,
      keywordMatch: searchResult?.keywordMatch,
      score: searchResult?.score
    }
  })

  appendSessionTracking(sessionId, entries, cwd, cleanPrompt, status)
}

function normalizeSnippet(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function writeStdout(value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(value, error => {
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    })
  })
}

let hardExitTimer: NodeJS.Timeout | null = null

function scheduleHardExit(exitCode?: number): void {
  if (hardExitTimer) return
  const code = typeof exitCode === 'number' ? exitCode : (process.exitCode ?? 0)
  hardExitTimer = setTimeout(() => process.exit(code), 50)
  hardExitTimer.unref()
}

// Only run main when executed directly (not imported)
const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
const isMainModule = fileURLToPath(import.meta.url) === entryPath
if (isMainModule) {
  main()
    .then(() => {
      process.exitCode = 0
    })
    .catch(error => {
      console.error('[claude-memory] pre-prompt failed:', error)
      process.exitCode = 2
    })
    .finally(() => {
      scheduleHardExit(typeof process.exitCode === 'number' ? process.exitCode : undefined)
    })
}
