#!/usr/bin/env -S npx tsx

import path from 'path'
import { fileURLToPath } from 'url'
import { initMilvus, hybridSearch } from '../lib/milvus.js'
import { buildContext, extractSignals, findGitRoot, formatRecordSnippet, stripNoiseWords, type ContextSignals } from '../lib/context.js'
import { embed } from '../lib/embed.js'
import { loadConfig } from '../lib/config.js'
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
    await initMilvus(runtimeConfig)
    const searchResult = await searchMemories(
      input.prompt,
      signals,
      runtimeConfig,
      settings,
      input.cwd,
      signal,
      { diagnostic }
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
  }, PREPROMPT_TIMEOUT_MS)

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
  options: { diagnostic?: boolean } = {}
): Promise<SearchMemoriesResult> {
  const cleanPrompt = stripNoiseWords(prompt)
  const scope = {
    project: signals.projectRoot ?? cwd,
    domain: signals.domain
  }
  const diagnostic = options.diagnostic === true

  // Pre-compute embedding once to avoid duplicate API calls on retry
  const semanticQuery = buildSemanticQuery(cleanPrompt, signals)
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
    cleanPrompt,
    signals,
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
      cleanPrompt,
      signals,
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
    diagnostics: diagnostic
      ? {
          search: searchDiagnostics ?? { qualified: [], nearMisses: [] },
          mmrExclusions
        }
      : undefined
  }
}

function mergeNearMisses(target: Map<string, NearMissRecord>, incoming: NearMissRecord[]): void {
  for (const entry of incoming) {
    const id = entry.record.record.id
    const existing = target.get(id)
    if (existing) {
      existing.exclusionReasons.push(...entry.exclusionReasons)
      continue
    }
    target.set(id, { record: entry.record, exclusionReasons: [...entry.exclusionReasons] })
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
  cleanPrompt: string,
  signals: ContextSignals,
  config: Config,
  settings: RetrievalSettings,
  scope: { project?: string; domain?: string },
  precomputedEmbedding?: number[],
  signal?: AbortSignal,
  options: { diagnostic?: boolean } = {}
): Promise<SearchWithScopeResult> {
  const limit = config.injection.maxRecords
  const keywordQueries = buildKeywordQueries(signals, cleanPrompt)
  const resultsById = new Map<string, HybridSearchResult>()
  const diagnostic = options.diagnostic === true
  const nearMisses = diagnostic ? new Map<string, NearMissRecord>() : null

  console.error(`[claude-memory] Signals: errors=${signals.errors.length}, commands=${signals.commands.length}, project=${scope.project ?? 'none'}, domain=${scope.domain ?? 'none'}`)

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
  exclusions: NearMissRecord[]
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
    return diagnostic ? { selected: [], exclusions: [] } : []
  }
  if (candidates.length <= 1) {
    return diagnostic ? { selected: candidates, exclusions: [] } : candidates
  }

  // Filter to candidates with embeddings
  const withEmbeddings = candidates.filter(c => c.record.embedding && c.record.embedding.length > 0)
  const withoutEmbeddings = candidates.filter(c => !c.record.embedding || c.record.embedding.length === 0)

  // If no embeddings available, return original order
  if (withEmbeddings.length === 0) {
    return diagnostic ? { selected: candidates, exclusions: [] } : candidates
  }

  const selected: HybridSearchResult[] = []
  const remaining = [...withEmbeddings]
  let lastSelectedMmr = 0

  // First pick is always highest relevance
  remaining.sort((a, b) => b.score - a.score)
  const first = remaining.shift()!
  selected.push(first)
  if (diagnostic) {
    lastSelectedMmr = lambda * first.score
  }

  while (remaining.length > 0 && selected.length < limit) {
    let bestIdx = 0
    let bestMMR = -Infinity

    for (let i = 0; i < remaining.length; i++) {
      const relevance = remaining[i].score

      // Max similarity to any already-selected item
      let maxSim = -Infinity
      for (const chosen of selected) {
        const sim = cosineSimilarity(chosen.record.embedding!, remaining[i].record.embedding!)
        maxSim = Math.max(maxSim, sim)
      }

      // MMR = λ * relevance - (1-λ) * maxSimilarity
      const mmr = lambda * relevance - (1 - lambda) * maxSim

      if (mmr > bestMMR) {
        bestMMR = mmr
        bestIdx = i
      }
    }

    selected.push(remaining.splice(bestIdx, 1)[0])
    if (diagnostic) {
      lastSelectedMmr = bestMMR
    }
  }

  // Append any records without embeddings at the end (they couldn't be compared)
  for (const item of withoutEmbeddings) {
    if (selected.length >= limit) break
    selected.push(item)
  }

  const finalSelected = selected.slice(0, limit)

  if (!diagnostic) {
    return finalSelected
  }

  const exclusions: NearMissRecord[] = []
  if (remaining.length > 0) {
    const selectedWithEmbeddings = finalSelected.filter(item =>
      item.record.embedding && item.record.embedding.length > 0
    )
    for (const candidate of remaining) {
      let maxSim = -Infinity
      let similarTo: string | undefined
      for (const chosen of selectedWithEmbeddings) {
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
  }

  return { selected: finalSelected, exclusions }
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

async function runWithTimeout<T>(
  task: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number
): Promise<{ completed: boolean; value?: T }> {
  let timeoutId: NodeJS.Timeout | null = null
  const controller = new AbortController()
  try {
    const timeoutPromise = new Promise<{ completed: boolean }>(resolve => {
      timeoutId = setTimeout(() => {
        controller.abort()
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

  if (payload.hook_event_name !== 'UserPromptSubmit') {
    console.error('[claude-memory] Unexpected hook event:', payload.hook_event_name)
    return
  }

  if (!payload.prompt || !payload.prompt.trim()) {
    console.error('[claude-memory] Empty prompt; skipping injection.')
    trackSession(payload.session_id, [], [], payload.cwd, payload.prompt, 'empty_prompt')
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
    scheduleHardExit()
  } else {
    trackSession(payload.session_id, [], [], payload.cwd, payload.prompt, 'error')
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

function scheduleHardExit(): void {
  const timer = setTimeout(() => process.exit(0), 50)
  timer.unref()
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
}
