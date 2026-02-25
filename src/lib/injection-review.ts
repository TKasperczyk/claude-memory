import type Anthropic from '@anthropic-ai/sdk'
import { extractSignals, findAncestorProjects, stripNoiseWords, type ContextSignals } from './context.js'
import { embedBatch } from './embed.js'
import { buildFilter, escapeFilterValue, fetchRecordsByIds, vectorSearchSimilar } from './lancedb.js'
import { dedupeInjectedMemories, loadSessionTracking } from './session-tracking.js'
import { buildRecordSnippet, truncateSnippet } from './shared.js'
import { formatSimilarRecord } from './review-formatters.js'
import { asString, isPlainObject } from './parsing.js'
import { clampScore, coerceInjectedVerdict, coerceMissedMemory, parseReviewRating } from './review-coercion.js'
import { executeReview, executeReviewStreaming, type ThinkingCallback } from './review-framework.js'
import { loadSettings } from './settings.js'
import { DEFAULT_CONFIG, type Config, type InjectedMemoryEntry, type MemoryRecord } from './types.js'
import type { InjectedMemoryVerdict, InjectionReview, MissedMemory } from '../../shared/types.js'

export type { InjectedMemoryVerdict, InjectionReview, MissedMemory } from '../../shared/types.js'

const REVIEW_TOOL_NAME = 'emit_injection_review'
const REVIEW_MAX_TOKENS = 4000
const REVIEW_SIMILARITY_THRESHOLD = 0.35
const REVIEW_SIMILAR_LIMIT = 15
const REVIEW_SIMILAR_COMBINED_MAX_CHARS = 30000

const REVIEW_SYSTEM_PROMPT = `You are reviewing the quality of memory injection for a live Claude Code session.

Rules:
- Output ONLY via the tool call "${REVIEW_TOOL_NAME}" exactly once.
- Judge relevance strictly against the user's prompt.
- Every injected memory must receive a verdict with a concrete reason.
- "irrelevant" means it should not have been injected.
- Identify missed memories only from the provided candidate list.
- Provide a concise, actionable summary of what to improve.
- overallRating must be exactly one of: good, mixed, poor
`

const REVIEW_TOOL_DESCRIPTION = 'Emit an injection quality review with an overall rating and missed candidates.'
const REVIEW_TOOL_SCHEMA: Anthropic.Tool['input_schema'] = {
  type: 'object',
  additionalProperties: false,
  required: ['overallRating', 'relevanceScore', 'injectedVerdicts', 'missedMemories', 'summary'],
  properties: {
    sessionId: { type: 'string' },
    prompt: { type: 'string' },
    reviewedAt: { type: 'number' },
    overallRating: { type: 'string', enum: ['good', 'mixed', 'poor'] },
    relevanceScore: {
      type: 'number',
      description: 'Overall relevance of injected memories (0-100). 100 = all highly relevant, 0 = all irrelevant.'
    },
    injectedVerdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'snippet', 'verdict', 'reason'],
        properties: {
          id: { type: 'string' },
          snippet: { type: 'string' },
          verdict: { type: 'string', enum: ['relevant', 'partially_relevant', 'irrelevant'] },
          reason: { type: 'string' }
        }
      }
    },
    missedMemories: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'snippet', 'reason'],
        properties: {
          id: { type: 'string' },
          snippet: { type: 'string' },
          reason: { type: 'string' }
        }
      }
    },
    summary: { type: 'string' },
    model: { type: 'string' },
    durationMs: { type: 'number' }
  }
}

type ReviewPayload = {
  overallRating: InjectionReview['overallRating']
  relevanceScore: number
  injectedVerdicts: InjectedMemoryVerdict[]
  missedMemories: MissedMemory[]
  summary: string
}

type InjectionReviewInput = {
  sessionId: string
  prompt: string
  cwd?: string
  injectedAt: number
  signals: ContextSignals
  injectedPayload: Array<Record<string, unknown>>
  similarMemories: Array<{ record: MemoryRecord; similarity: number }>
}

export async function reviewInjection(
  sessionId: string,
  config: Config = DEFAULT_CONFIG
): Promise<InjectionReview> {
  const startTime = Date.now()
  const { input, injectedEntries } = await buildInjectionReviewInput(sessionId, config)
  const settings = loadSettings()
  const { payload, reviewedAt, model, durationMs } = await executeReview(input, {
    toolName: REVIEW_TOOL_NAME,
    toolDescription: REVIEW_TOOL_DESCRIPTION,
    toolSchema: REVIEW_TOOL_SCHEMA,
    maxTokens: REVIEW_MAX_TOKENS,
    systemPrompt: REVIEW_SYSTEM_PROMPT,
    model: settings.reviewModel,
    buildPrompt: buildInjectionReviewPrompt,
    coercePayload: coerceReviewPayload,
    authErrorMessage: 'No authentication available for injection review. Set ANTHROPIC_API_KEY or run kira login.',
    startedAt: startTime
  }, config)

  const injectedVerdicts = normalizeInjectedVerdicts(payload.injectedVerdicts, injectedEntries)
  return {
    sessionId,
    prompt: input.prompt,
    reviewedAt,
    overallRating: payload.overallRating,
    relevanceScore: payload.relevanceScore,
    injectedVerdicts,
    missedMemories: payload.missedMemories,
    summary: payload.summary,
    model,
    durationMs
  }
}

export async function reviewInjectionStreaming(
  sessionId: string,
  config: Config,
  onThinking: ThinkingCallback,
  abortSignal?: AbortSignal
): Promise<InjectionReview> {
  const startTime = Date.now()
  const { input, injectedEntries } = await buildInjectionReviewInput(sessionId, config)
  const settings = loadSettings()
  const { payload, reviewedAt, model, durationMs } = await executeReviewStreaming(input, {
    toolName: REVIEW_TOOL_NAME,
    toolDescription: REVIEW_TOOL_DESCRIPTION,
    toolSchema: REVIEW_TOOL_SCHEMA,
    maxTokens: REVIEW_MAX_TOKENS,
    systemPrompt: REVIEW_SYSTEM_PROMPT,
    model: settings.reviewModel,
    buildPrompt: buildInjectionReviewPrompt,
    coercePayload: coerceReviewPayload,
    authErrorMessage: 'No authentication available for injection review. Set ANTHROPIC_API_KEY or run kira login.',
    startedAt: startTime
  }, config, onThinking, abortSignal)

  const injectedVerdicts = normalizeInjectedVerdicts(payload.injectedVerdicts, injectedEntries)
  return {
    sessionId,
    prompt: input.prompt,
    reviewedAt,
    overallRating: payload.overallRating,
    relevanceScore: payload.relevanceScore,
    injectedVerdicts,
    missedMemories: payload.missedMemories,
    summary: payload.summary,
    model,
    durationMs
  }
}

async function buildInjectionReviewInput(
  sessionId: string,
  config: Config
): Promise<{ input: InjectionReviewInput; injectedEntries: InjectedMemoryEntry[] }> {
  const session = loadSessionTracking(sessionId, config.lancedb.table)
  if (!session) {
    throw new Error('Session not found.')
  }

  const injection = selectLatestInjection(session.memories)
  if (!injection) {
    throw new Error('No injected memories with prompts found for review.')
  }

  const prompt = injection.prompt.trim()
  if (!prompt) {
    throw new Error('No prompt available for injection review.')
  }

  const injectedIds = injection.entries.map(entry => entry.id)
  const records = await fetchRecordsByIds(injectedIds, config)
  const injectedPayload = buildInjectedPayload(injection.entries, records)
  if (injectedPayload.length === 0) {
    throw new Error('Injected memories missing for review.')
  }

  const projectRoot = resolveReviewProjectRoot(session.cwd, records)
  const signals = buildReviewSignals(prompt, projectRoot)

  let similarMemories: Array<{ record: MemoryRecord; similarity: number }> = []
  try {
    similarMemories = await collectSimilarMemories(prompt, signals, injectedIds, projectRoot, injection.injectedAt, config)
  } catch (error) {
    console.error('[claude-memory] Failed to fetch similar memories for injection review:', error)
  }

  return {
    input: {
      sessionId,
      prompt,
      cwd: session.cwd ?? projectRoot,
      injectedAt: injection.injectedAt,
      signals,
      injectedPayload,
      similarMemories
    },
    injectedEntries: injection.entries
  }
}

function selectLatestInjection(memories: InjectedMemoryEntry[]): {
  prompt: string
  injectedAt: number
  entries: InjectedMemoryEntry[]
} | null {
  if (!memories || memories.length === 0) return null

  const sorted = [...memories].sort((a, b) => b.injectedAt - a.injectedAt)
  const withPrompt = sorted.find(entry => Boolean(entry.prompt && entry.prompt.trim()))
  if (!withPrompt) return null

  const latestInjectedAt = sorted[0].injectedAt
  if (withPrompt.injectedAt !== latestInjectedAt) {
    console.warn(
      `[claude-memory] Latest injection missing prompt; reviewing injection at ${withPrompt.injectedAt} instead of ${latestInjectedAt}.`
    )
  }

  const injectedAt = withPrompt.injectedAt
  const prompt = withPrompt.prompt?.trim() ?? ''
  const entries = dedupeInjectedMemories(memories.filter(entry => entry.injectedAt === injectedAt))

  if (!entries.length) return null
  return { prompt, injectedAt, entries }
}

function resolveReviewProjectRoot(
  cwd: string | undefined,
  records: MemoryRecord[]
): string | undefined {
  if (cwd && cwd.trim()) return cwd
  return records.find(record => Boolean(record.project))?.project
}

function buildReviewSignals(prompt: string, projectRoot: string | undefined): ContextSignals {
  if (projectRoot) {
    return extractSignals(prompt, projectRoot, projectRoot)
  }

  const signals = extractSignals(prompt, '')
  return {
    ...signals,
    projectRoot: undefined,
    projectName: undefined
  }
}

function buildInjectedPayload(
  entries: InjectedMemoryEntry[],
  records: MemoryRecord[]
): Array<Record<string, unknown>> {
  const recordMap = new Map(records.map(record => [record.id, record]))

  return entries.map(entry => {
    const record = recordMap.get(entry.id)
    return {
      id: entry.id,
      snippet: entry.snippet,
      type: entry.type ?? record?.type,
      project: record?.project,
      scope: record?.scope,
      similarity: entry.similarity,
      keywordMatch: entry.keywordMatch,
      score: entry.score,
      recordSummary: record ? truncateSnippet(buildRecordSnippet(record), 160) : undefined
    }
  })
}

async function collectSimilarMemories(
  prompt: string,
  signals: ContextSignals,
  excludeIds: string[],
  cwd: string | undefined,
  injectedAt: number,
  config: Config
): Promise<Array<{ record: MemoryRecord; similarity: number }>> {
  const inputs = buildPromptEmbeddingInputs(prompt, signals)
  if (inputs.length === 0) return []

  const filter = buildSimilarFilter(signals, excludeIds, cwd)
  const excludeSet = new Set(excludeIds)
  const seen = new Map<string, { record: MemoryRecord; similarity: number }>()

  const embeddings = await embedBatch(inputs, config)

  for (const embedding of embeddings) {
    const results = await vectorSearchSimilar(embedding, {
      filter,
      limit: REVIEW_SIMILAR_LIMIT,
      similarityThreshold: REVIEW_SIMILARITY_THRESHOLD
    }, config)

    for (const result of results) {
      if (excludeSet.has(result.record.id)) continue
      // Skip memories created after the injection - they couldn't have been injected
      if ((result.record.timestamp ?? 0) > injectedAt) continue
      const existing = seen.get(result.record.id)
      if (!existing || result.similarity > existing.similarity) {
        seen.set(result.record.id, result)
      }
    }
  }

  return Array.from(seen.values())
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, REVIEW_SIMILAR_LIMIT)
}

function buildPromptEmbeddingInputs(prompt: string, signals: ContextSignals): string[] {
  const inputs: string[] = []
  const cleanedPrompt = stripNoiseWords(prompt).trim()
  if (cleanedPrompt) inputs.push(cleanedPrompt)

  for (const error of signals.errors) {
    if (error) inputs.push(error)
  }

  for (const command of signals.commands) {
    if (command) inputs.push(command)
  }

  const contextParts: string[] = []
  if (cleanedPrompt) contextParts.push(cleanedPrompt)
  if (signals.projectName) contextParts.push(`project: ${signals.projectName}`)

  const combined = truncateForEmbedding(contextParts.join('\n'), REVIEW_SIMILAR_COMBINED_MAX_CHARS)
  if (combined) inputs.push(combined)

  return Array.from(new Set(inputs.map(value => value.trim()).filter(Boolean)))
}

function truncateForEmbedding(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  if (maxLength <= 3) return value.slice(0, maxLength)
  const head = value.slice(0, Math.max(0, maxLength - 300))
  const tail = value.slice(-300)
  return `${head}\n...\n${tail}`
}

function buildSimilarFilter(signals: ContextSignals, excludeIds: string[], cwd: string | undefined): string {
  const project = signals.projectRoot ?? cwd
  const ancestorProjects = project ? findAncestorProjects(project) : undefined

  const baseFilter = buildFilter({
    project: project ?? undefined,
    ancestorProjects,
    includeGlobal: true,
    excludeDeprecated: true
  })

  const parts: string[] = baseFilter ? [baseFilter] : [`scope = 'global'`]

  for (const id of excludeIds) {
    parts.push(`id <> '${escapeFilterValue(id)}'`)
  }

  return parts.join(' AND ')
}

function buildInjectionReviewPrompt(args: {
  sessionId: string
  prompt: string
  cwd?: string
  injectedAt: number
  signals: ContextSignals
  injectedPayload: Array<Record<string, unknown>>
  similarMemories: Array<{ record: MemoryRecord; similarity: number }>
}): string {
  const { sessionId, prompt, cwd, injectedAt, signals, injectedPayload, similarMemories } = args
  const similarPayload = similarMemories.map(entry => formatSimilarRecord(entry.record, entry.similarity))

  return `Session metadata:
- session_id: ${sessionId}
- injected_at: ${injectedAt}
- cwd: ${cwd ?? 'unknown'}
- project_root: ${signals.projectRoot ?? 'unknown'}
- project_name: ${signals.projectName ?? 'unknown'}

Detected signals (JSON):
${JSON.stringify({ errors: signals.errors, commands: signals.commands }, null, 2)}

User prompt:
${prompt}

Injected memories (JSON):
${JSON.stringify(injectedPayload, null, 2)}

Similar non-injected memories (JSON):
${JSON.stringify(similarPayload, null, 2)}
`
}

function normalizeInjectedVerdicts(
  verdicts: InjectedMemoryVerdict[],
  entries: InjectedMemoryEntry[]
): InjectedMemoryVerdict[] {
  const entryById = new Map(entries.map(entry => [entry.id, entry]))
  const verdictById = new Map<string, InjectedMemoryVerdict>()

  for (const verdict of verdicts) {
    if (!entryById.has(verdict.id)) continue
    if (!verdictById.has(verdict.id)) {
      verdictById.set(verdict.id, verdict)
    }
  }

  const normalized: InjectedMemoryVerdict[] = []
  const seen = new Set<string>()

  for (const entry of entries) {
    if (seen.has(entry.id)) continue
    seen.add(entry.id)

    const verdict = verdictById.get(entry.id)
    if (verdict) {
      normalized.push(verdict)
      continue
    }

    normalized.push({
      id: entry.id,
      snippet: entry.snippet,
      verdict: 'unknown',
      reason: 'Not evaluated by reviewer'
    })
  }

  return normalized
}

function coerceReviewPayload(input: unknown): ReviewPayload | null {
  if (!isPlainObject(input)) return null
  const record = input

  const overallRating = parseReviewRating(record.overallRating ?? record.overallRelevance)
  const relevanceScore = parseRelevanceScore(record.relevanceScore)
  const summary = asString(record.summary)?.trim() ?? ''
  const injectedVerdicts = Array.isArray(record.injectedVerdicts)
    ? record.injectedVerdicts.map(coerceInjectedVerdict).filter((item): item is InjectedMemoryVerdict => Boolean(item))
    : []
  const missedMemories = Array.isArray(record.missedMemories)
    ? record.missedMemories.map(coerceMissedMemory).filter((item): item is MissedMemory => Boolean(item))
    : []

  if (!overallRating || relevanceScore === null || summary === '') return null

  return {
    overallRating,
    relevanceScore,
    injectedVerdicts,
    missedMemories,
    summary
  }
}

function parseRelevanceScore(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Model might output 0.85 meaning 85% - scale to 0-100
    const scaled = value > 0 && value < 1 ? value * 100 : value
    return clampScore(scaled)
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      const scaled = parsed > 0 && parsed < 1 ? parsed * 100 : parsed
      return clampScore(scaled)
    }
  }
  return null
}
