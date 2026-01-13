import Anthropic from '@anthropic-ai/sdk'
import fs from 'fs'
import readline from 'readline'
import { CLAUDE_CODE_SYSTEM_PROMPT, createAnthropicClient } from './anthropic.js'
import { asStringArray, asTrimmedString, isPlainObject, isToolUseBlock, type ToolUseBlock } from './parsing.js'
import { DEFAULT_CONFIG, type Config } from './types.js'

export interface RetrievalQueryPlan {
  resolvedQuery: string
  keywordQueries: string[]
  semanticQuery: string
  domain?: string
}

type CCContentBlock =
  | { type: 'text'; text?: string }
  | { type: 'tool_use'; id?: string; name?: string; input?: unknown }
  | { type: 'tool_result'; tool_use_id?: string; content?: unknown; is_error?: boolean }
  | { type: string; [key: string]: unknown }

type TranscriptEntry = {
  type?: string
  isSidechain?: boolean
  isMeta?: boolean
  message?: {
    role?: string
    content?: CCContentBlock[] | string
  }
  name?: string
  id?: string
  input?: unknown
  content?: unknown
  tool_use_id?: string
  toolUseId?: string
  toolUseResult?: unknown
  is_error?: boolean
  isError?: boolean
}

type TranscriptTurn = {
  user: string
  assistant?: string
}

const TOOL_NAME = 'emit_query_plan'
const QUERY_MAX_TOKENS = 500
const MAX_CONTEXT_TURNS = 5
const MAX_TURN_CHARS = 1200
const MAX_TOOL_SNIPPET_CHARS = 400

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

    const turns = await readTranscriptTurns(
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

async function readTranscriptTurns(
  transcriptPath: string,
  maxTurns: number,
  signal?: AbortSignal
): Promise<TranscriptTurn[]> {
  const turns: TranscriptTurn[] = []
  let currentTurn: TranscriptTurn | null = null

  const pushTurn = (turn: TranscriptTurn): void => {
    if (!turn.user || !turn.assistant) return
    turns.push(turn)
    if (turns.length > maxTurns) turns.shift()
  }

  const input = fs.createReadStream(transcriptPath, { encoding: 'utf-8' })
  const rl = readline.createInterface({ input, crlfDelay: Infinity })

  try {
    for await (const line of rl) {
      if (signal?.aborted) break
      const trimmed = line.trim()
      if (!trimmed) continue

      let entry: TranscriptEntry | null = null
      try {
        entry = JSON.parse(trimmed) as TranscriptEntry
      } catch {
        continue
      }

      if (!entry || typeof entry !== 'object') continue
      if (entry.isSidechain || entry.isMeta) continue

      const role = resolveMessageRole(entry)
      if (role) {
        const content = coerceContent(entry.message?.content ?? entry.content)
        if (!content) continue

        if (role === 'user') {
          if (currentTurn) pushTurn(currentTurn)
          currentTurn = { user: content }
          continue
        }

        if (role === 'assistant') {
          if (!currentTurn) continue
          appendAssistantContent(currentTurn, content)
          continue
        }
      }

      if (entry.type === 'tool_use') {
        const toolText = formatToolUseEntry(entry)
        if (toolText && currentTurn) appendAssistantContent(currentTurn, toolText)
        continue
      }

      if (entry.type === 'tool_result') {
        const toolText = formatToolResultEntry(entry)
        if (toolText && currentTurn) appendAssistantContent(currentTurn, toolText)
      }
    }
  } finally {
    rl.close()
    input.destroy()
  }

  if (currentTurn) pushTurn(currentTurn)
  return turns
}

function resolveMessageRole(entry: TranscriptEntry): 'user' | 'assistant' | null {
  const direct = normalizeRole(entry.type)
  if (direct) return direct
  return normalizeRole(entry.message?.role)
}

function normalizeRole(role: unknown): 'user' | 'assistant' | null {
  if (role === 'user' || role === 'assistant') return role
  if (role === 'human') return 'user'
  return null
}

function coerceContent(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed ? trimmed : null
  }

  if (Array.isArray(value)) {
    const parts = value
      .map(entry => {
        if (!isPlainObject(entry)) return null
        const type = entry.type
        if (type === 'text' && typeof entry.text === 'string') return entry.text
        if (type === 'tool_use') return formatToolUseBlock(entry)
        if (type === 'tool_result') return formatToolResultBlock(entry)
        if (typeof entry.text === 'string') return entry.text
        return null
      })
      .filter((entry): entry is string => typeof entry === 'string')
    const joined = parts.join('\n')
    const trimmed = joined.trim()
    return trimmed ? trimmed : null
  }

  if (isPlainObject(value) && typeof value.text === 'string') {
    const trimmed = value.text.trim()
    return trimmed ? trimmed : null
  }

  return null
}

function appendAssistantContent(turn: TranscriptTurn, content: string): void {
  const trimmed = content.trim()
  if (!trimmed) return
  turn.assistant = turn.assistant
    ? `${turn.assistant}\n\n${trimmed}`
    : trimmed
}

function formatToolUseBlock(block: Record<string, unknown>): string | null {
  return formatToolCall(block.name, block.input)
}

function formatToolResultBlock(block: Record<string, unknown>): string | null {
  const outputText = coerceToolContentText(block.content)
  const isError = block.is_error === true
  return formatToolResult(outputText, isError, undefined)
}

function formatToolUseEntry(entry: TranscriptEntry): string | null {
  return formatToolCall(entry.name, entry.input)
}

function formatToolResultEntry(entry: TranscriptEntry): string | null {
  const outputText = coerceToolContentText(entry.content ?? entry.toolUseResult)
  const isError = entry.is_error === true || entry.isError === true
  return formatToolResult(outputText, isError, entry.name)
}

function formatToolCall(name: unknown, input: unknown): string | null {
  const toolName = asTrimmedString(name) ?? 'unknown'
  const inputText = formatToolInput(input)
  return inputText ? `[Tool Call] ${toolName} ${inputText}` : `[Tool Call] ${toolName}`
}

function formatToolResult(outputText: string | undefined, isError: boolean, name?: unknown): string | null {
  const nameLabel = asTrimmedString(name)
  const headerParts = ['[Tool Result]']
  if (nameLabel) headerParts.push(nameLabel)
  if (isError) headerParts.push('error')
  const header = headerParts.join(' ')
  if (!outputText) return header
  return `${header}\n${truncateToolText(outputText)}`
}

function formatToolInput(input: unknown): string | undefined {
  if (isPlainObject(input) && typeof input.command === 'string') {
    return `command=${input.command}`
  }
  const serialized = safeJsonStringify(input)
  if (!serialized) return undefined
  return `input=${truncateToolText(serialized)}`
}

function coerceToolContentText(content: unknown): string | undefined {
  if (typeof content === 'string') return content.trim() ? content : undefined
  if (!Array.isArray(content)) return formatToolUseResult(content)

  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const type = (block as { type?: unknown }).type
    if (type === 'text') {
      const text = (block as { text?: unknown }).text
      if (typeof text === 'string' && text.trim()) parts.push(text)
    }
  }

  if (parts.length > 0) return parts.join('\n')
  return formatToolUseResult(content)
}

function formatToolUseResult(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined
  const record = result as Record<string, unknown>
  const outputs: string[] = []

  const stdout = record.stdout
  if (typeof stdout === 'string' && stdout.trim()) outputs.push(stdout)

  const stderr = record.stderr
  if (typeof stderr === 'string' && stderr.trim()) outputs.push(stderr)

  const content = record.content
  if (typeof content === 'string' && content.trim()) outputs.push(content)

  const file = record.file
  if (file && typeof file === 'object') {
    const fileContent = (file as { content?: unknown }).content
    if (typeof fileContent === 'string' && fileContent.trim()) outputs.push(fileContent)
  }

  if (outputs.length > 0) return outputs.join('\n')

  const serialized = safeJsonStringify(result)
  return serialized === '{}' ? undefined : serialized
}

function truncateToolText(value: string): string {
  if (value.length <= MAX_TOOL_SNIPPET_CHARS) return value
  return value.slice(0, MAX_TOOL_SNIPPET_CHARS - 3) + '...'
}

function safeJsonStringify(value: unknown): string | undefined {
  if (value === undefined) return undefined
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
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

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return value.slice(0, maxLength - 3) + '...'
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
