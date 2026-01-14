import Anthropic from '@anthropic-ai/sdk'
import fs from 'fs'
import { CLAUDE_CODE_SYSTEM_PROMPT, createAnthropicClient } from './anthropic.js'
import { asStringArray, asTrimmedString, isPlainObject, isToolUseBlock, type ToolUseBlock } from './parsing.js'
import { truncateText } from './shared.js'
import { parseTranscriptTurns, type TranscriptTurn } from './transcript.js'
import { DEFAULT_CONFIG, type Config } from './types.js'

export interface RetrievalQueryPlan {
  resolvedQuery: string
  keywordQueries: string[]
  semanticQuery: string
  domain?: string
}

const TOOL_NAME = 'emit_query_plan'
const QUERY_MAX_TOKENS = 500
const MAX_CONTEXT_TURNS = 5
const MAX_TURN_CHARS = 1200

const SYSTEM_PROMPT = `You generate search queries for a technical memory database.

You will receive:
CONTEXT: recent conversation turns (user + assistant).
FOCUS: the current user prompt that needs memory retrieval.

Goal: resolve what the FOCUS refers to using CONTEXT, then produce a retrieval plan.

Definitions:
- resolvedQuery: rewrite FOCUS with pronouns/ellipses resolved. Keep the user's intent.
- keywordQueries: short, literal search terms (commands, error strings, file names, tool names, flags). 1-5 items, no full sentences.
- semanticQuery: 1-3 sentences capturing intent and constraints; good for embeddings.
- domain: optional broad area (e.g. git, docker, node, python, cli, database) if obvious.

Examples:
CONTEXT:
User: "We store embeddings in Milvus under collection cc_memories."
Assistant: "Use the Milvus client."
FOCUS: "How do I query it?"
resolvedQuery: "How do I query the Milvus collection cc_memories?"
keywordQueries: ["Milvus", "cc_memories", "query collection"]
semanticQuery: "How to query the Milvus collection cc_memories for stored embeddings."

CONTEXT:
User: "The \`xclip -selection clipboard\` command overwrote my clipboard."
FOCUS: "Would it pollute my clipboard?"
resolvedQuery: "Would running \`xclip -selection clipboard\` pollute my clipboard?"
keywordQueries: ["xclip", "-selection clipboard", "clipboard"]
semanticQuery: "Does running xclip with -selection clipboard overwrite or pollute the clipboard?"

Rules:
- Do NOT invent details not in CONTEXT or FOCUS.
- If CONTEXT is empty or not helpful, resolvedQuery can equal FOCUS.
- Output ONLY via the tool "${TOOL_NAME}" exactly once.`

const QUERY_TOOL: Anthropic.Tool = {
  name: TOOL_NAME,
  description: 'Emit a retrieval query plan for memory search.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['resolvedQuery', 'keywordQueries', 'semanticQuery'],
    properties: {
      resolvedQuery: { type: 'string' },
      keywordQueries: {
        type: 'array',
        items: { type: 'string' }
      },
      semanticQuery: { type: 'string' },
      domain: { type: 'string' }
    }
  }
}

export async function generateRetrievalQueryPlan(
  prompt: string,
  transcriptPath: string | undefined,
  config: Config = DEFAULT_CONFIG,
  options: { signal?: AbortSignal; timeoutMs?: number; maxTurns?: number } = {}
): Promise<RetrievalQueryPlan | null> {
  if (!prompt || !prompt.trim()) {
    return null
  }
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return null
  }
  if (options.signal?.aborted) return null

  const { signal, cleanup } = createTimeoutSignal(options.timeoutMs, options.signal)

  try {
    if (signal?.aborted) return null

    const turns = await parseTranscriptTurns(
      transcriptPath,
      options.maxTurns ?? MAX_CONTEXT_TURNS,
      signal
    )
    if (signal?.aborted || turns.length === 0) return null

    const client = await createAnthropicClient()
    if (!client) {
      console.error('[claude-memory] No authentication available for retrieval query generation.')
      return null
    }

    const userPrompt = buildUserPrompt(turns, prompt)

    const response = await client.messages.create({
      model: config.extraction.model,
      max_tokens: Math.min(QUERY_MAX_TOKENS, config.extraction.maxTokens),
      temperature: 0,
      system: [
        { type: 'text', text: CLAUDE_CODE_SYSTEM_PROMPT },
        { type: 'text', text: SYSTEM_PROMPT }
      ],
      messages: [{ role: 'user', content: userPrompt }],
      tools: [QUERY_TOOL],
      tool_choice: { type: 'tool', name: TOOL_NAME }
    }, signal ? { signal } : undefined)

    const toolInput = response.content.find((block): block is ToolUseBlock =>
      isToolUseBlock(block) && block.name === TOOL_NAME
    )?.input
    if (!toolInput) return null
    const plan = coerceRetrievalQueryPlan(toolInput)
    return plan
  } catch (error) {
    const aborted = signal?.aborted || options.signal?.aborted
    if (aborted) return null
    console.error('[claude-memory] Retrieval query generation failed:', error)
    return null
  } finally {
    cleanup()
  }
}

function coerceRetrievalQueryPlan(value: unknown): RetrievalQueryPlan | null {
  if (!isPlainObject(value)) return null
  const resolvedQuery = asTrimmedString(value.resolvedQuery)
  const semanticQuery = asTrimmedString(value.semanticQuery)
  const keywordQueries = asStringArray(value.keywordQueries)
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0)
  const domain = asTrimmedString(value.domain)

  if (!resolvedQuery || !semanticQuery) return null

  return {
    resolvedQuery,
    keywordQueries,
    semanticQuery,
    domain: domain ?? undefined
  }
}

function buildUserPrompt(turns: TranscriptTurn[], focus: string): string {
  const context = turns.length > 0
    ? turns.map((turn, index) => formatTurn(turn, index)).join('\n\n')
    : '[no prior turns]'
  const trimmedFocus = focus.trim()
  return `CONTEXT (previous turns, oldest to newest):
${context}

FOCUS (current user prompt):
${trimmedFocus}`
}

function formatTurn(turn: TranscriptTurn, index: number): string {
  const user = truncateText(turn.user, MAX_TURN_CHARS)
  const assistant = turn.assistant ? truncateText(turn.assistant, MAX_TURN_CHARS) : null
  const lines = [`Turn ${index + 1}`, `User: ${user}`]
  if (assistant) lines.push(`Assistant: ${assistant}`)
  return lines.join('\n')
}

function createTimeoutSignal(
  timeoutMs?: number,
  externalSignal?: AbortSignal
): { signal?: AbortSignal; cleanup: () => void } {
  if (!timeoutMs && !externalSignal) {
    return { signal: undefined, cleanup: () => {} }
  }

  const controller = new AbortController()
  let timeoutId: NodeJS.Timeout | null = null
  const onAbort = (): void => controller.abort()

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort()
    } else {
      externalSignal.addEventListener('abort', onAbort, { once: true })
    }
  }

  if (timeoutMs && timeoutMs > 0) {
    timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      if (timeoutId) clearTimeout(timeoutId)
      if (externalSignal) externalSignal.removeEventListener('abort', onAbort)
    }
  }
}
