import Anthropic from '@anthropic-ai/sdk'
import { CLAUDE_CODE_SYSTEM_PROMPT, createAnthropicClient } from './anthropic.js'
import { extractSignals, stripNoiseWords, type ContextSignals } from './context.js'
import { embedBatch } from './embed.js'
import { buildFilter, escapeFilterValue, fetchRecordsByIds, vectorSearchSimilar } from './milvus.js'
import { dedupeInjectedMemories, loadSessionTracking } from './session-tracking.js'
import { buildRecordSnippet, truncateSnippet } from './shared.js'
import { asString, isPlainObject, isToolUseBlock, type ToolUseBlock } from './parsing.js'
import { clampScore, parseInjectionVerdict, parseOverallRelevance } from './review-coercion.js'
import { DEFAULT_CONFIG, type Config, type InjectedMemoryEntry, type MemoryRecord } from './types.js'
import type { InjectedMemoryVerdict, InjectionReview, MissedMemory } from '../../shared/types.js'

export type { InjectedMemoryVerdict, InjectionReview, MissedMemory } from '../../shared/types.js'

const REVIEW_MODEL = 'claude-opus-4-5-20251101'
const REVIEW_TOOL_NAME = 'emit_injection_review'
const REVIEW_MAX_TOKENS = 1800
const REVIEW_SIMILARITY_THRESHOLD = 0.35
const REVIEW_SIMILAR_LIMIT = 15
const REVIEW_SIMILAR_COMBINED_MAX_CHARS = 12000

const REVIEW_SYSTEM_PROMPT = `You are reviewing the quality of memory injection for a live Claude Code session.

Rules:
- Output ONLY via the tool call "${REVIEW_TOOL_NAME}" exactly once.
- Judge relevance strictly against the user's prompt.
- Every injected memory must receive a verdict with a concrete reason.
- "irrelevant" means it should not have been injected.
- Identify missed memories only from the provided candidate list.
- Provide a concise, actionable summary of what to improve.
`

const REVIEW_TOOL: Anthropic.Tool = {
  name: REVIEW_TOOL_NAME,
  description: 'Emit an injection quality review with relevance ratings and missed candidates.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['overallRelevance', 'relevanceScore', 'injectedVerdicts', 'missedMemories', 'summary'],
    properties: {
      sessionId: { type: 'string' },
      prompt: { type: 'string' },
      reviewedAt: { type: 'number' },
      overallRelevance: { type: 'string', enum: ['excellent', 'good', 'mixed', 'poor'] },
      relevanceScore: { type: 'number' },
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
}

type ReviewPayload = {
  overallRelevance: InjectionReview['overallRelevance']
  relevanceScore: number
  injectedVerdicts: InjectedMemoryVerdict[]
  missedMemories: MissedMemory[]
  summary: string
}

export async function reviewInjection(
  sessionId: string,
  config: Config = DEFAULT_CONFIG
): Promise<InjectionReview> {
  const startTime = Date.now()
  const session = loadSessionTracking(sessionId)
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
    similarMemories = await collectSimilarMemories(prompt, signals, injectedIds, projectRoot, config)
  } catch (error) {
    console.error('[claude-memory] Failed to fetch similar memories for injection review:', error)
  }

  const client = await createAnthropicClient()
  if (!client) {
    throw new Error('No authentication available for injection review. Set ANTHROPIC_API_KEY or run kira login.')
  }

  const reviewPrompt = buildReviewPrompt({
    sessionId,
    prompt,
    cwd: session.cwd ?? projectRoot,
    injectedAt: injection.injectedAt,
    signals,
    injectedPayload,
    similarMemories
  })

  const response = await client.messages.create({
    model: REVIEW_MODEL,
    max_tokens: Math.min(REVIEW_MAX_TOKENS, config.extraction.maxTokens),
    temperature: 0,
    system: [
      { type: 'text', text: CLAUDE_CODE_SYSTEM_PROMPT },
      { type: 'text', text: REVIEW_SYSTEM_PROMPT }
    ],
    messages: [{ role: 'user', content: reviewPrompt }],
    tools: [REVIEW_TOOL],
    tool_choice: { type: 'tool', name: REVIEW_TOOL_NAME }
  })

  const toolInput = response.content.find((block): block is ToolUseBlock =>
    isToolUseBlock(block) && block.name === REVIEW_TOOL_NAME
  )?.input

  if (!toolInput) {
    throw new Error('Review tool call missing in response.')
  }

  const payload = coerceReviewPayload(toolInput)
  if (!payload) {
    throw new Error('Review response invalid or incomplete.')
  }

  const injectedVerdicts = normalizeInjectedVerdicts(payload.injectedVerdicts, injection.entries)
  const reviewedAt = Date.now()
  return {
    sessionId,
    prompt,
    reviewedAt,
    overallRelevance: payload.overallRelevance,
    relevanceScore: payload.relevanceScore,
    injectedVerdicts,
    missedMemories: payload.missedMemories,
    summary: payload.summary,
    model: REVIEW_MODEL,
    durationMs: reviewedAt - startTime
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
    projectName: undefined,
    domain: undefined
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
      domain: record?.domain,
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
  if (signals.domain) contextParts.push(`domain: ${signals.domain}`)

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

  const baseFilter = buildFilter({
    project: project ?? undefined,
    includeGlobal: true,
    domain: signals.domain,
    excludeDeprecated: true
  })

  const parts: string[] = baseFilter ? [baseFilter] : ['scope == "global"']

  for (const id of excludeIds) {
    parts.push(`id != "${escapeFilterValue(id)}"`)
  }

  return parts.join(' && ')
}

function buildReviewPrompt(args: {
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
- domain: ${signals.domain ?? 'unknown'}

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

function formatSimilarRecord(record: MemoryRecord, similarity: number): Record<string, unknown> {
  const summary = truncateSnippet(buildRecordSnippet(record), 160)
  return {
    id: record.id,
    type: record.type,
    similarity: Number(similarity.toFixed(3)),
    summary,
    project: record.project,
    domain: record.domain,
    scope: record.scope
  }
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

  const overallRelevance = parseOverallRelevance(record.overallRelevance)
  const relevanceScore = parseRelevanceScore(record.relevanceScore)
  const summary = asString(record.summary)?.trim() ?? ''
  const injectedVerdicts = Array.isArray(record.injectedVerdicts)
    ? record.injectedVerdicts.map(coerceInjectedVerdict).filter((item): item is InjectedMemoryVerdict => Boolean(item))
    : []
  const missedMemories = Array.isArray(record.missedMemories)
    ? record.missedMemories.map(coerceMissedMemory).filter((item): item is MissedMemory => Boolean(item))
    : []

  if (!overallRelevance || relevanceScore === null || summary === '') return null

  return {
    overallRelevance,
    relevanceScore,
    injectedVerdicts,
    missedMemories,
    summary
  }
}

function parseRelevanceScore(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return clampScore(value)
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return clampScore(parsed)
  }
  return null
}

function coerceInjectedVerdict(value: unknown): InjectedMemoryVerdict | null {
  if (!isPlainObject(value)) return null
  const record = value

  const id = asString(record.id)?.trim()
  const snippet = asString(record.snippet)?.trim()
  const verdict = parseInjectionVerdict(record.verdict)
  const reason = asString(record.reason)?.trim()

  if (!id || !snippet || !verdict || !reason) return null

  return {
    id,
    snippet,
    verdict,
    reason
  }
}

function coerceMissedMemory(value: unknown): MissedMemory | null {
  if (!isPlainObject(value)) return null
  const record = value

  const id = asString(record.id)?.trim()
  const snippet = asString(record.snippet)?.trim()
  const reason = asString(record.reason)?.trim()

  if (!id || !snippet || !reason) return null

  return {
    id,
    snippet,
    reason
  }
}
