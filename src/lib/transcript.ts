import fs from 'fs'
import readline from 'readline'
import { safeJsonStringify } from './json.js'
import { truncateTextWithMarker } from './shared.js'

export interface ToolCall {
  id?: string
  name: string
  input?: unknown
  timestampMs?: number
  rawTimestamp?: string
  cwd?: string
}

export interface ToolResult {
  toolUseId?: string
  name?: string
  input?: unknown
  outputText?: string
  isError?: boolean
  metadata?: unknown
  timestampMs?: number
  rawTimestamp?: string
  cwd?: string
}

export interface TranscriptMessage {
  role: 'user' | 'assistant'
  text: string
  timestampMs?: number
  rawTimestamp?: string
  cwd?: string
  toolCalls?: ToolCall[]
  toolResults?: ToolResult[]
  rawContent?: unknown
}

export type TranscriptEvent =
  | {
      type: 'user' | 'assistant'
      text: string
      timestampMs?: number
      rawTimestamp?: string
      cwd?: string
    }
  | {
      type: 'tool_call'
      name: string
      id?: string
      input?: unknown
      timestampMs?: number
      rawTimestamp?: string
      cwd?: string
    }
  | {
      type: 'tool_result'
      name?: string
      toolUseId?: string
      input?: unknown
      outputText?: string
      isError?: boolean
      metadata?: unknown
      timestampMs?: number
      rawTimestamp?: string
      cwd?: string
    }

export interface Transcript {
  messages: TranscriptMessage[]
  events: TranscriptEvent[]
  toolCalls: ToolCall[]
  toolResults: ToolResult[]
  parseErrors: number
}

export type CCContentBlock =
  | { type: 'text'; text?: string }
  | { type: 'thinking'; thinking?: string }
  | { type: 'tool_use'; id?: string; name?: string; input?: unknown }
  | { type: 'tool_result'; tool_use_id?: string; content?: unknown; is_error?: boolean }
  | { type: string; [key: string]: unknown }

type CCJsonlEntry = {
  type?: string
  timestamp?: string
  isSidechain?: boolean
  isMeta?: boolean
  uuid?: string
  cwd?: string
  message?: {
    role?: string
    content?: CCContentBlock[] | string
  }
  toolUseResult?: unknown
  name?: string
  id?: string
  input?: unknown
  content?: unknown
  tool_use_id?: string
  toolUseId?: string
  is_error?: boolean
  isError?: boolean
}

const TOOL_OUTPUT_MAX_CHARS = 30000
const TOOL_SNIPPET_MAX_CHARS = 1000
const MESSAGE_TEXT_MAX_CHARS = 60000
const PARSE_WARN_LIMIT = 5

export type TranscriptTurn = {
  user: string
  assistant?: string
}

export async function parseTranscript(path: string): Promise<Transcript> {
  const messages: TranscriptMessage[] = []
  const events: TranscriptEvent[] = []
  const toolCalls: ToolCall[] = []
  const toolResults: ToolResult[] = []
  const toolCallsById = new Map<string, ToolCall>()
  let parseErrors = 0
  let parseWarned = 0
  const hasTrailingNewline = fileEndsWithNewline(path)
  let pendingParseError: { line: number; message: string } | null = null

  const commitParseError = (pending: { line: number; message: string }): void => {
    parseErrors += 1
    if (parseWarned < PARSE_WARN_LIMIT) {
      console.error(`[claude-memory] transcript parse error at line ${pending.line}: ${pending.message}`)
      parseWarned += 1
    }
  }

  const input = fs.createReadStream(path, { encoding: 'utf-8' })
  const rl = readline.createInterface({ input, crlfDelay: Infinity })
  let lineNumber = 0

  try {
    for await (const line of rl) {
      lineNumber += 1
      const trimmed = line.trim()
      if (!trimmed) {
        if (pendingParseError) {
          commitParseError(pendingParseError)
          pendingParseError = null
        }
        continue
      }

      let entry: CCJsonlEntry | null = null
      try {
        entry = JSON.parse(trimmed) as CCJsonlEntry
        if (pendingParseError) {
          commitParseError(pendingParseError)
          pendingParseError = null
        }
      } catch (error: unknown) {
        if (pendingParseError) {
          commitParseError(pendingParseError)
        }
        const message = error instanceof Error ? error.message : String(error)
        pendingParseError = { line: lineNumber, message }
        continue
      }

      if (!entry || typeof entry !== 'object') continue
      if (entry.isSidechain || entry.isMeta) continue

      const { rawTimestamp, timestampMs } = parseTimestamp(entry.timestamp)
      const cwd = typeof entry.cwd === 'string' ? entry.cwd : undefined
      const content = entry.message?.content

      const extracted = extractMessageContent(content, {
        timestampMs,
        rawTimestamp,
        cwd
      })

      if (
        (entry.type === 'tool_use' && extracted.toolCalls.length === 0)
        || (entry.type === 'tool_result' && extracted.toolResults.length === 0)
      ) {
        const toolBlocks = buildToolBlocksFromEntry(entry)
        if (toolBlocks) {
          const toolExtracted = extractMessageContent(toolBlocks, {
            timestampMs,
            rawTimestamp,
            cwd
          })
          extracted.toolCalls.push(...toolExtracted.toolCalls)
          extracted.toolResults.push(...toolExtracted.toolResults)
        }
      }

      if (entry.toolUseResult && extracted.toolResults.length > 0) {
        attachToolUseResult(extracted.toolResults, entry.toolUseResult)
      } else if (entry.toolUseResult) {
        const fallback = buildToolResultFromMetadata(entry.toolUseResult, {
          timestampMs,
          rawTimestamp,
          cwd
        })
        if (fallback) extracted.toolResults.push(fallback)
      }

      const role = resolveMessageRole(entry)
      if (role && extracted.text.trim()) {
        const truncatedText = truncateTextWithMarker(extracted.text, MESSAGE_TEXT_MAX_CHARS)
        messages.push({
          role,
          text: truncatedText,
          timestampMs,
          rawTimestamp,
          cwd,
          toolCalls: extracted.toolCalls,
          toolResults: extracted.toolResults,
          rawContent: content
        })
        events.push({
          type: role,
          text: truncatedText,
          timestampMs,
          rawTimestamp,
          cwd
        })
      }

      for (const call of extracted.toolCalls) {
        toolCalls.push(call)
        events.push({
          type: 'tool_call',
          name: call.name,
          id: call.id,
          input: call.input,
          timestampMs: call.timestampMs,
          rawTimestamp: call.rawTimestamp,
          cwd: call.cwd
        })
        if (call.id) toolCallsById.set(call.id, call)
      }

      for (const result of extracted.toolResults) {
        if (result.toolUseId && toolCallsById.has(result.toolUseId)) {
          const call = toolCallsById.get(result.toolUseId)
          if (call) {
            result.name = result.name ?? call.name
            result.input = result.input ?? call.input
          }
        }

        toolResults.push(result)
        events.push({
          type: 'tool_result',
          name: result.name,
          toolUseId: result.toolUseId,
          input: result.input,
          outputText: result.outputText,
          isError: result.isError,
          metadata: result.metadata,
          timestampMs: result.timestampMs,
          rawTimestamp: result.rawTimestamp,
          cwd: result.cwd
        })
      }
    }
  } finally {
    rl.close()
    input.destroy()
  }

  if (pendingParseError && hasTrailingNewline) {
    commitParseError(pendingParseError)
  }

  if (parseErrors > PARSE_WARN_LIMIT) {
    console.error(`[claude-memory] transcript parse errors: ${parseErrors - PARSE_WARN_LIMIT} more lines skipped`)
  }

  return {
    messages,
    events,
    toolCalls,
    toolResults,
    parseErrors
  }
}

export async function parseTranscriptTurns(
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

      let entry: CCJsonlEntry | null = null
      try {
        entry = JSON.parse(trimmed) as CCJsonlEntry
      } catch {
        continue
      }

      if (!entry || typeof entry !== 'object') continue
      if (entry.isSidechain || entry.isMeta) continue

      const role = resolveMessageRole(entry)
      if (role) {
        const content = coerceTurnContent(entry.message?.content ?? entry.content)
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

function extractMessageContent(
  content: CCContentBlock[] | string | undefined,
  context: { timestampMs?: number; rawTimestamp?: string; cwd?: string }
): { text: string; toolCalls: ToolCall[]; toolResults: ToolResult[] } {
  if (typeof content === 'string') {
    return {
      text: content,
      toolCalls: [],
      toolResults: []
    }
  }

  if (!Array.isArray(content) || content.length === 0) {
    return { text: '', toolCalls: [], toolResults: [] }
  }

  const textParts: string[] = []
  const toolCalls: ToolCall[] = []
  const toolResults: ToolResult[] = []

  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const type = (block as { type?: unknown }).type

    if (type === 'text') {
      const text = (block as { text?: unknown }).text
      if (typeof text === 'string' && text.trim()) {
        textParts.push(text)
      }
      continue
    }

    if (type === 'tool_use') {
      const id = asString((block as { id?: unknown }).id)
      const name = asString((block as { name?: unknown }).name) ?? 'unknown'
      const input = (block as { input?: unknown }).input
      toolCalls.push({
        id,
        name,
        input,
        timestampMs: context.timestampMs,
        rawTimestamp: context.rawTimestamp,
        cwd: context.cwd
      })
      continue
    }

    if (type === 'tool_result') {
      const toolUseId = asString((block as { tool_use_id?: unknown }).tool_use_id)
      const outputText = coerceToolContentText((block as { content?: unknown }).content)
      const isError = (block as { is_error?: unknown }).is_error === true
      toolResults.push({
        toolUseId,
        outputText: truncateTextWithMarker(outputText, TOOL_OUTPUT_MAX_CHARS),
        isError,
        timestampMs: context.timestampMs,
        rawTimestamp: context.rawTimestamp,
        cwd: context.cwd
      })
    }
  }

  return {
    text: textParts.join('\n'),
    toolCalls,
    toolResults
  }
}

function resolveMessageRole(entry: CCJsonlEntry): 'user' | 'assistant' | undefined {
  const direct = normalizeRole(entry.type)
  if (direct) return direct
  return normalizeRole(entry.message?.role)
}

function buildToolBlocksFromEntry(entry: CCJsonlEntry): CCContentBlock[] | null {
  if (entry.type === 'tool_use') {
    const name = asString(entry.name)
    if (!name) return null
    return [
      {
        type: 'tool_use',
        id: asString(entry.id),
        name,
        input: entry.input
      }
    ]
  }

  if (entry.type === 'tool_result') {
    const toolUseId = asString(entry.tool_use_id ?? entry.toolUseId ?? entry.id)
    const content = entry.content ?? entry.toolUseResult
    const isError = entry.is_error === true || entry.isError === true
    if (content === undefined && !toolUseId) return null
    return [
      {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content,
        is_error: isError
      }
    ]
  }

  return null
}

function attachToolUseResult(results: ToolResult[], toolUseResult: unknown): void {
  const target = results[results.length - 1]
  if (!target) return
  target.metadata = toolUseResult
  if (!target.outputText) {
    const outputText = formatToolUseResult(toolUseResult)
    if (outputText) {
      target.outputText = truncateTextWithMarker(outputText, TOOL_OUTPUT_MAX_CHARS)
    }
  }
}

function buildToolResultFromMetadata(
  toolUseResult: unknown,
  context: { timestampMs?: number; rawTimestamp?: string; cwd?: string }
): ToolResult | null {
  const outputText = formatToolUseResult(toolUseResult)
  if (!outputText) return null
  return {
    outputText: truncateTextWithMarker(outputText, TOOL_OUTPUT_MAX_CHARS),
    metadata: toolUseResult,
    timestampMs: context.timestampMs,
    rawTimestamp: context.rawTimestamp,
    cwd: context.cwd
  }
}

function coerceToolContentText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
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

function coerceToolContentTextForSnippet(content: unknown): string | undefined {
  const text = coerceToolContentText(content)
  const trimmed = text?.trim()
  return trimmed ? text : undefined
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

function parseTimestamp(raw: unknown): { rawTimestamp?: string; timestampMs?: number } {
  if (typeof raw !== 'string' || !raw) return {}
  const ms = Date.parse(raw)
  if (!Number.isFinite(ms)) return { rawTimestamp: raw }
  return { rawTimestamp: raw, timestampMs: ms }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asTrimmedString(value: unknown): string | undefined {
  const raw = asString(value)
  const trimmed = raw?.trim()
  return trimmed ? trimmed : undefined
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function normalizeRole(role: unknown): 'user' | 'assistant' | undefined {
  if (role === 'user' || role === 'assistant') return role
  if (role === 'human') return 'user'
  return undefined
}

function coerceTurnContent(value: unknown): string | null {
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
  const outputText = coerceToolContentTextForSnippet(block.content)
  const isError = block.is_error === true
  return formatToolResult(outputText, isError, undefined)
}

function formatToolUseEntry(entry: CCJsonlEntry): string | null {
  return formatToolCall(entry.name, entry.input)
}

function formatToolResultEntry(entry: CCJsonlEntry): string | null {
  const outputText = coerceToolContentTextForSnippet(entry.content ?? entry.toolUseResult)
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

function truncateToolText(value: string): string {
  if (value.length <= TOOL_SNIPPET_MAX_CHARS) return value
  return value.slice(0, TOOL_SNIPPET_MAX_CHARS - 3) + '...'
}

function fileEndsWithNewline(path: string): boolean {
  try {
    const stats = fs.statSync(path)
    if (!stats.isFile() || stats.size === 0) return false
    const fd = fs.openSync(path, 'r')
    try {
      const buffer = Buffer.alloc(1)
      fs.readSync(fd, buffer, 0, 1, stats.size - 1)
      return buffer[0] === 10
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return true
  }
}

export function getFirstUserPrompt(transcript: Transcript): string | undefined {
  for (const event of transcript.events) {
    if (event.type === 'user' && event.text?.trim()) {
      return event.text.trim()
    }
  }
  return undefined
}
