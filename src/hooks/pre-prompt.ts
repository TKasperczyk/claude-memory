#!/usr/bin/env -S npx tsx

import path from 'path'
import { fileURLToPath } from 'url'
import { initMilvus, hybridSearch } from '../lib/milvus.js'
import { buildContext, extractSignals, findGitRoot, formatRecordSnippet, stripNoiseWords, type ContextSignals } from '../lib/context.js'
import { embed } from '../lib/embed.js'
import { loadConfig } from '../lib/config.js'
import { loadSettings, type RetrievalSettings } from '../lib/settings.js'
import { DEFAULT_CONFIG, type Config, type HybridSearchResult, type InjectionStatus, type MemoryRecord, type PrePromptInput, type UserPromptSubmitInput } from '../lib/types.js'
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
}

/**
 * Core pre-prompt hook logic. Exported for testing.
 *
 * Searches memories based on the prompt and returns formatted context.
 */
export async function handlePrePrompt(
  input: PrePromptInput,
  config: Config = DEFAULT_CONFIG,
  options: { projectRoot?: string } = {}
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
  const settings = loadSettings()
  const runtimeConfig = applySettingsToConfig(config, settings)

  const result = await runWithTimeout(async (signal) => {
    await initMilvus(runtimeConfig)
    const results = await searchMemories(input.prompt, signals, runtimeConfig, settings, input.cwd, signal)
    if (results.length === 0) {
      return { context: null, results, injectedRecords: [] }
    }

    const { context, records: injectedRecords } = buildContext(results.map(r => r.record), runtimeConfig)
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
    timedOut: false
  }
}

async function searchMemories(
  prompt: string,
  signals: ContextSignals,
  config: Config,
  settings: RetrievalSettings,
  cwd: string,
  signal?: AbortSignal
): Promise<HybridSearchResult[]> {
  const cleanPrompt = stripNoiseWords(prompt)
  const scope = {
    project: signals.projectRoot ?? cwd,
    domain: signals.domain
  }

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

  let results = await searchWithScope(cleanPrompt, signals, config, settings, scope, embedding, signal)
  if (results.length === 0 && scope.project) {
    // Fallback: remove project filter but preserve domain to avoid cross-domain noise
    console.error('[claude-memory] No project-scoped hits; retrying with domain filter only.')
    results = await searchWithScope(cleanPrompt, signals, config, settings, { domain: scope.domain }, embedding, signal)
  }

  // Apply MMR for diversity if we have multiple results with embeddings
  if (results.length > 1) {
    const diverseResults = applyMMR(results, settings.mmrLambda, config.injection.maxRecords)
    if (diverseResults.length !== results.length) {
      console.error(`[claude-memory] MMR reranked ${results.length} -> ${diverseResults.length} results`)
    }
    return diverseResults
  }

  return results
}

async function searchWithScope(
  cleanPrompt: string,
  signals: ContextSignals,
  config: Config,
  settings: RetrievalSettings,
  scope: { project?: string; domain?: string },
  precomputedEmbedding?: number[],
  signal?: AbortSignal
): Promise<HybridSearchResult[]> {
  const limit = config.injection.maxRecords
  const keywordQueries = buildKeywordQueries(signals, cleanPrompt)
  const resultsById = new Map<string, HybridSearchResult>()

  console.error(`[claude-memory] Signals: errors=${signals.errors.length}, commands=${signals.commands.length}, project=${scope.project ?? 'none'}, domain=${scope.domain ?? 'none'}`)

  for (const query of keywordQueries) {
    if (resultsById.size >= limit) break
    const keywordResults = await hybridSearch({
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
    }, config)
    for (const item of keywordResults) {
      if (resultsById.size >= limit) break
      if (!resultsById.has(item.record.id)) {
        resultsById.set(item.record.id, item)
      }
    }
  }

  if (precomputedEmbedding) {
    const semanticResults = await hybridSearch({
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
    }, config)
    for (const item of semanticResults) {
      const existing = resultsById.get(item.record.id)
      if (existing) {
        // Merge: record was found by both keyword and semantic search
        existing.similarity = Math.max(existing.similarity, item.similarity)
        existing.score = Math.max(existing.score, item.score)
      } else if (resultsById.size < limit) {
        resultsById.set(item.record.id, item)
      }
    }
  }

  return Array.from(resultsById.values())
    .filter(result => result.keywordMatch || result.score >= settings.minScore)
}

/**
 * Apply Maximal Marginal Relevance to diversify results.
 * Penalizes candidates that are too similar to already-selected items.
 */
function applyMMR(
  candidates: HybridSearchResult[],
  lambda: number,
  limit: number
): HybridSearchResult[] {
  if (candidates.length <= 1) return candidates

  // Filter to candidates with embeddings
  const withEmbeddings = candidates.filter(c => c.record.embedding && c.record.embedding.length > 0)
  const withoutEmbeddings = candidates.filter(c => !c.record.embedding || c.record.embedding.length === 0)

  // If no embeddings available, return original order
  if (withEmbeddings.length === 0) return candidates

  const selected: HybridSearchResult[] = []
  const remaining = [...withEmbeddings]

  // First pick is always highest relevance
  remaining.sort((a, b) => b.score - a.score)
  selected.push(remaining.shift()!)

  while (remaining.length > 0 && selected.length < limit) {
    let bestIdx = 0
    let bestMMR = -Infinity

    for (let i = 0; i < remaining.length; i++) {
      const relevance = remaining[i].score

      // Max similarity to any already-selected item
      const maxSim = Math.max(...selected.map(s =>
        cosineSimilarity(s.record.embedding!, remaining[i].record.embedding!)
      ))

      // MMR = λ * relevance - (1-λ) * maxSimilarity
      const mmr = lambda * relevance - (1 - lambda) * maxSim

      if (mmr > bestMMR) {
        bestMMR = mmr
        bestIdx = i
      }
    }

    selected.push(remaining.splice(bestIdx, 1)[0])
  }

  // Append any records without embeddings at the end (they couldn't be compared)
  for (const item of withoutEmbeddings) {
    if (selected.length >= limit) break
    selected.push(item)
  }

  return selected.slice(0, limit)
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
