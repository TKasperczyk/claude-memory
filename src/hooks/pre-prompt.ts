#!/usr/bin/env -S npx tsx

import fs from 'fs'
import path from 'path'
import { initMilvus } from '../lib/milvus.js'
import { extractSignals, formatContext, type ContextSignals } from '../lib/context.js'
import { hybridSearch } from '../lib/milvus.js'
import { DEFAULT_CONFIG, type Config, type HybridSearchResult, type UserPromptSubmitInput } from '../lib/types.js'

const MAX_KEYWORD_QUERIES = 4
const MAX_KEYWORD_ERRORS = 2
const MAX_KEYWORD_COMMANDS = 2
const PREPROMPT_TIMEOUT_MS = 4000
const MAX_SEMANTIC_QUERY_CHARS = 1200

export interface PrePromptResult {
  context: string | null
  signals: ContextSignals
  results: HybridSearchResult[]
  timedOut: boolean
}

/**
 * Core pre-prompt hook logic. Exported for testing.
 *
 * Searches memories based on the prompt and returns formatted context.
 */
export async function handlePrePrompt(
  input: UserPromptSubmitInput,
  config: Config = DEFAULT_CONFIG
): Promise<PrePromptResult> {
  if (!input.prompt || !input.prompt.trim()) {
    return {
      context: null,
      signals: { errors: [], commands: [] },
      results: [],
      timedOut: false
    }
  }

  const signals = extractSignals(input.prompt, input.cwd)

  const result = await runWithTimeout(async () => {
    const results = await searchMemories(input.prompt, signals, config, input.cwd)
    if (results.length === 0) {
      return { context: null, results }
    }

    const context = formatContext(results.map(r => r.record), config)
    return { context: context || null, results }
  }, PREPROMPT_TIMEOUT_MS)

  if (!result.completed) {
    return {
      context: null,
      signals,
      results: [],
      timedOut: true
    }
  }

  return {
    context: result.value?.context ?? null,
    signals,
    results: result.value?.results ?? [],
    timedOut: false
  }
}

async function searchMemories(
  prompt: string,
  signals: ContextSignals,
  config: Config,
  cwd: string
): Promise<HybridSearchResult[]> {
  const scope = {
    project: signals.projectRoot ?? cwd,
    domain: signals.domain
  }

  let results = await searchWithScope(prompt, signals, config, scope)
  if (results.length === 0 && (scope.project || scope.domain)) {
    console.error('[claude-memory] No project-scoped hits; retrying without scope.')
    results = await searchWithScope(prompt, signals, config, {})
  }

  return results
}

async function searchWithScope(
  prompt: string,
  signals: ContextSignals,
  config: Config,
  scope: { project?: string; domain?: string }
): Promise<HybridSearchResult[]> {
  const limit = config.injection.maxRecords
  const keywordQueries = buildKeywordQueries(signals)
  const results: HybridSearchResult[] = []
  const seen = new Set<string>()

  console.error(`[claude-memory] Signals: errors=${signals.errors.length}, commands=${signals.commands.length}, project=${scope.project ?? 'none'}, domain=${scope.domain ?? 'none'}`)

  const addResults = (items: HybridSearchResult[]): void => {
    for (const item of items) {
      if (results.length >= limit) break
      if (seen.has(item.record.id)) continue
      seen.add(item.record.id)
      results.push(item)
    }
  }

  for (const query of keywordQueries) {
    if (results.length >= limit) break
    const keywordResults = await hybridSearch({
      query,
      limit,
      project: scope.project,
      domain: scope.domain,
      vectorWeight: 0,
      keywordWeight: 1,
      keywordLimit: limit
    }, config)
    addResults(keywordResults)
  }

  if (results.length < limit) {
    const semanticQuery = buildSemanticQuery(prompt, signals)
    if (semanticQuery) {
      const semanticResults = await hybridSearch({
        query: semanticQuery,
        limit: limit - results.length,
        project: scope.project,
        domain: scope.domain,
        vectorWeight: 1,
        keywordWeight: 0
      }, config)
      addResults(semanticResults)
    }
  }

  return results
}

function buildKeywordQueries(signals: ContextSignals): string[] {
  const errorQueries = signals.errors.slice(0, MAX_KEYWORD_ERRORS)
  const commandQueries = signals.commands.slice(0, MAX_KEYWORD_COMMANDS)
  const queries = [...errorQueries, ...commandQueries]

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

function loadConfig(root: string): Config {
  if (!root) return DEFAULT_CONFIG
  const configPath = path.join(root, 'config.json')
  if (!fs.existsSync(configPath)) return DEFAULT_CONFIG

  try {
    const raw = fs.readFileSync(configPath, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<Config>
    return {
      ...DEFAULT_CONFIG,
      milvus: { ...DEFAULT_CONFIG.milvus, ...parsed.milvus },
      embeddings: { ...DEFAULT_CONFIG.embeddings, ...parsed.embeddings },
      extraction: { ...DEFAULT_CONFIG.extraction, ...parsed.extraction },
      injection: { ...DEFAULT_CONFIG.injection, ...parsed.injection }
    }
  } catch (error) {
    console.error('[claude-memory] Failed to load config.json:', error)
    return DEFAULT_CONFIG
  }
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return value.slice(0, maxLength - 3) + '...'
}

async function runWithTimeout<T>(
  task: () => Promise<T>,
  timeoutMs: number
): Promise<{ completed: boolean; value?: T }> {
  let timeoutId: NodeJS.Timeout | null = null
  try {
    const timeoutPromise = new Promise<{ completed: boolean }>(resolve => {
      timeoutId = setTimeout(() => resolve({ completed: false }), timeoutMs)
    })
    const taskPromise = task()
      .then(value => ({ completed: true as const, value }))
      .catch(error => ({ completed: true as const, error }))
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
    return
  }

  const config = loadConfig(extractSignals(payload.prompt, payload.cwd).projectRoot ?? payload.cwd)
  await initMilvus(config)

  const result = await handlePrePrompt(payload, config)

  if (result.timedOut) {
    console.error(`[claude-memory] Pre-prompt timed out after ${PREPROMPT_TIMEOUT_MS}ms; skipping injection.`)
    return
  }

  if (result.results.length === 0) {
    console.error('[claude-memory] No matching memories found.')
    return
  }

  if (!result.context) {
    console.error('[claude-memory] Context empty after formatting.')
    return
  }

  process.stdout.write(result.context)
}

// Only run main when executed directly (not imported)
const isMainModule = import.meta.url === `file://${process.argv[1]}`
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
