import Anthropic from '@anthropic-ai/sdk'
import fs from 'fs'
import path from 'path'
import { CLAUDE_CODE_SYSTEM_PROMPT, createAnthropicClient } from './anthropic.js'
import { buildToolCallParams } from './model-capabilities.js'
import { asTrimmedString, isPlainObject, isToolUseBlock, type ToolUseBlock } from './parsing.js'
import { buildCacheControl } from './prompt-cache.js'
import { truncateText, withTimeout } from './shared.js'
import { extractTokenUsage } from './token-usage.js'
import { parseTranscriptTurns, type TranscriptTurn } from './transcript.js'
import type { HybridSearchResult, MemoryRecord, TokenUsage } from './types.js'

const TOOL_NAME = 'emit_reranked_memories'
const DEFAULT_RERANK_MODEL = 'claude-haiku-5-5'
const RERANK_MAX_TOKENS = 256
const MAX_CONTEXT_TURNS = 4
const MAX_TURN_CHARS = 500
const MAX_CANDIDATE_CHARS = 320

const SYSTEM_PROMPT = `You are a high-precision memory reranker and abstention gate for a coding assistant.

You will receive:
- PROJECT: the current working project/directory.
- RECENT_CONTEXT: optional brief recent conversation turns to resolve pronouns/references.
- USER_PROMPT: the developer's current prompt.
- CANDIDATES: numbered memory records [0]..[N-1] from local hybrid search (BM25 + vector).
- MAX_RECORDS: maximum number of memories you may select (typically 3).

Your job:
Select ONLY the 0 to MAX_RECORDS candidate indices that are genuinely, materially helpful for the current USER_PROMPT, ordered most helpful first.

Strict precision & abstention rules:
1. Prefer abstaining (selectedIndices: []) over injecting tangential, generic, or loosely-related memories. Injecting noise degrades assistant performance.
2. Select a memory ONLY if it provides concrete, actionable value for THIS prompt:
   - Exact fix/cause for an error or failure mentioned in the prompt.
   - A specific command, flag, endpoint, credential location, or procedure directly needed for the task.
   - A non-obvious warning, constraint, architecture quirk, or past decision that prevents a real mistake on this task.
3. Reject memories that:
   - Only share superficial vocabulary or mention the same repo/tool without helping the specific request.
   - Belong to a different project and describe project-local details unrelated to the current project.
   - Duplicate another selected candidate (pick only the single most complete/recent one).
   - State obvious general programming facts or outdated one-off status notes.
4. Never pad results to reach MAX_RECORDS. Returning 0, 1, or 2 records is often optimal.
5. Output ONLY via the tool "${TOOL_NAME}" with integer indices from [0..N-1].`

export interface RerankCandidatesRequest {
  prompt: string
  cwd: string
  project?: string
  transcriptPath?: string
  candidates: HybridSearchResult[]
  maxRecords: number
  timeoutMs?: number
  signal?: AbortSignal
  model?: string
}

export interface RerankCandidatesResult {
  selected: HybridSearchResult[]
  selectedIndices: number[]
  abstained: boolean
  abstainReason?: string
  tokenUsage: TokenUsage
  model: string
  durationMs: number
}

function buildRerankTool(maxCandidateIndex: number, maxRecords: number): Anthropic.Tool {
  return {
    name: TOOL_NAME,
    description: 'Select 0 to MAX_RECORDS high-confidence memory indices for injection, or abstain with an empty list.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['selectedIndices'],
      properties: {
        selectedIndices: {
          type: 'array',
          maxItems: Math.max(0, maxRecords),
          items: {
            type: 'integer',
            minimum: 0,
            maximum: Math.max(0, maxCandidateIndex)
          },
          description: 'Ordered indices of candidates to inject (0-based, most useful first). Empty array to abstain.'
        },
        abstainReason: {
          type: 'string',
          description: 'Brief reason if selectedIndices is empty.'
        }
      }
    }
  }
}

function formatCompactAge(timestampMs?: number): string {
  if (!timestampMs || !Number.isFinite(timestampMs)) return ''
  const diffMs = Math.max(0, Date.now() - timestampMs)
  const hours = Math.floor(diffMs / (60 * 60 * 1000))
  if (hours < 24) return hours <= 1 ? 'today' : `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo`
  return `${Math.floor(months / 12)}y`
}

function summarizeCandidateForRerank(record: MemoryRecord): string {
  switch (record.type) {
    case 'command': {
      const parts = [`cmd: ${record.command}`]
      if (record.context?.intent) parts.push(`intent: ${record.context.intent}`)
      if (record.outcome === 'failure') parts.push('outcome: failure')
      if (record.resolution) parts.push(`fix: ${record.resolution}`)
      return truncateText(parts.join(' | '), MAX_CANDIDATE_CHARS)
    }
    case 'error': {
      const parts = [`err: ${record.errorText}`]
      if (record.cause) parts.push(`cause: ${record.cause}`)
      if (record.resolution) parts.push(`fix: ${record.resolution}`)
      return truncateText(parts.join(' | '), MAX_CANDIDATE_CHARS)
    }
    case 'discovery': {
      const parts = [record.what]
      if (record.where) parts.push(`where: ${record.where}`)
      if (record.evidence) parts.push(record.evidence)
      return truncateText(parts.join(' — '), MAX_CANDIDATE_CHARS)
    }
    case 'procedure': {
      const steps = record.steps.slice(0, 4).join(' -> ')
      return truncateText(`${record.name}: ${steps}`, MAX_CANDIDATE_CHARS)
    }
    case 'warning': {
      const parts = [`[${record.severity}] avoid: ${record.avoid} -> use: ${record.useInstead}`]
      if (record.reason) parts.push(`why: ${record.reason}`)
      return truncateText(parts.join(' | '), MAX_CANDIDATE_CHARS)
    }
  }
}

function formatCandidateProvenance(record: MemoryRecord, currentProject?: string): string {
  const scopeLabel = record.scope === 'global'
    ? 'global'
    : (record.scope as string) === 'environment'
      ? 'env'
      : currentProject && record.project === currentProject
        ? 'this-project'
        : record.project
          ? path.basename(record.project) || record.project
          : 'project'
  const age = formatCompactAge(record.timestamp ?? record.lastUsed)
  return age ? `${scopeLabel} | ${age}` : scopeLabel
}

function buildRerankUserPrompt(
  prompt: string,
  cwd: string,
  project: string | undefined,
  turns: TranscriptTurn[],
  candidates: HybridSearchResult[],
  maxRecords: number
): string {
  const sections: string[] = []
  const projectLabel = project ? `${path.basename(project) || project} (${project})` : (cwd || 'unknown')
  sections.push(`PROJECT: ${projectLabel}`)
  sections.push(`MAX_RECORDS: ${maxRecords}`)

  if (turns.length > 0) {
    const contextLines: string[] = []
    for (const turn of turns) {
      contextLines.push(`User: ${truncateText(turn.user.replace(/\s+/g, ' ').trim(), MAX_TURN_CHARS)}`)
      if (turn.assistant) {
        contextLines.push(`Assistant: ${truncateText(turn.assistant.replace(/\s+/g, ' ').trim(), MAX_TURN_CHARS)}`)
      }
    }
    sections.push(`RECENT_CONTEXT:\n${contextLines.join('\n')}`)
  }

  sections.push(`USER_PROMPT:\n${truncateText(prompt.trim(), 2000)}`)

  const candidateLines = candidates.map((candidate, index) => {
    const { record } = candidate
    const prov = formatCandidateProvenance(record, project)
    const signals: string[] = []
    if (candidate.similarity > 0) signals.push(`sim=${candidate.similarity.toFixed(2)}`)
    if (candidate.keywordMatch) {
      signals.push(candidate.bm25Score !== undefined ? `bm25=${candidate.bm25Score.toFixed(1)}` : 'kw')
    }
    const signalStr = signals.length > 0 ? ` (${signals.join(', ')})` : ''
    const summary = summarizeCandidateForRerank(record)
    return `[${index}] [${record.type} | ${prov}]${signalStr} ${summary}`
  })
  sections.push(`CANDIDATES:\n${candidateLines.join('\n')}`)

  return sections.join('\n\n')
}

export async function rerankRetrievedCandidates(
  request: RerankCandidatesRequest
): Promise<RerankCandidatesResult | null> {
  const {
    prompt,
    cwd,
    project,
    transcriptPath,
    candidates,
    maxRecords,
    timeoutMs = 4000,
    signal,
    model = DEFAULT_RERANK_MODEL
  } = request

  if (!prompt.trim() || candidates.length === 0 || maxRecords <= 0) {
    return null
  }
  if (signal?.aborted) return null

  const startedAt = Date.now()

  try {
    const wrapped = await withTimeout(async (innerSignal) => {
      let turns: TranscriptTurn[] = []
      if (transcriptPath && fs.existsSync(transcriptPath)) {
        try {
          turns = await parseTranscriptTurns(transcriptPath, MAX_CONTEXT_TURNS, innerSignal)
        } catch {
          turns = []
        }
      }
      if (innerSignal.aborted) return null

      const client = await createAnthropicClient()
      if (!client) {
        console.error('[claude-memory] No authentication available for Stage-2 retrieval reranking.')
        return null
      }

      const userPrompt = buildRerankUserPrompt(prompt, cwd, project, turns, candidates, maxRecords)

      const response = await client.messages.create({
        model,
        ...buildToolCallParams(model, TOOL_NAME, RERANK_MAX_TOKENS),
        system: [
          { type: 'text', text: CLAUDE_CODE_SYSTEM_PROMPT },
          { type: 'text', text: SYSTEM_PROMPT, cache_control: buildCacheControl('1h') }
        ],
        messages: [{ role: 'user', content: userPrompt }],
        tools: [buildRerankTool(candidates.length - 1, maxRecords)]
      }, { signal: innerSignal })

      const tokenUsage = extractTokenUsage(response)
      const toolInput = response.content.find((block): block is ToolUseBlock =>
        isToolUseBlock(block) && block.name === TOOL_NAME
      )?.input

      if (!isPlainObject(toolInput) || !Array.isArray(toolInput.selectedIndices)) {
        console.warn('[claude-memory] Stage-2 reranker returned invalid tool output')
        return null
      }

      const seen = new Set<number>()
      const validIndices: number[] = []
      for (const raw of toolInput.selectedIndices) {
        if (typeof raw !== 'number' || !Number.isInteger(raw)) continue
        if (raw < 0 || raw >= candidates.length) continue
        if (seen.has(raw)) continue
        seen.add(raw)
        validIndices.push(raw)
        if (validIndices.length >= maxRecords) break
      }

      const selected = validIndices.map(idx => candidates[idx])
      const abstainReason = asTrimmedString(toolInput.abstainReason)

      return {
        selected,
        selectedIndices: validIndices,
        abstained: selected.length === 0,
        ...(abstainReason ? { abstainReason } : {}),
        tokenUsage,
        model,
        durationMs: Date.now() - startedAt
      }
    }, { timeoutMs, signal })

    if (!wrapped.completed) {
      if (wrapped.timedOut) {
        console.warn(`[claude-memory] Stage-2 retrieval reranker timed out after ${timeoutMs}ms`)
      }
      return null
    }
    return wrapped.value ?? null
  } catch (error) {
    console.error('[claude-memory] Stage-2 retrieval reranker failed:', error)
    return null
  }
}
