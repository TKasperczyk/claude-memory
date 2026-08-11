import { JsonLinesStore } from './file-store.js'
import { safeJsonStringify } from './json.js'
import { asInteger, asTrimmedString, isPlainObject } from './parsing.js'
import { sanitizeSessionId, truncateText, truncateTextWithMarker } from './shared.js'
import type { MemoryWriteHintEvent, PostToolUseInput } from './types.js'

const HINTS_NAMESPACE = 'sessions'
const CONTENT_MAX_CHARS = 12_000
const CONTENT_TAIL_CHARS = 2_000
const CONTENT_TRUNCATION_MARKER = '\n...[truncated]...\n'
const SESSION_ID_MAX_CHARS = 1_000
const NAME_MAX_CHARS = 1_000
const DESCRIPTION_MAX_CHARS = 4_000
const NATIVE_TYPE_MAX_CHARS = 500
const TOOL_USE_ID_MAX_CHARS = 1_000
const MAX_DATE_TIMESTAMP = 8_640_000_000_000_000

export const MEMORY_WRITE_HINT_RETENTION_DAYS = 90

const hintsStore = new JsonLinesStore('memory-write-hints', {
  sanitizeKey: sanitizeSessionId
})

type NativeMemoryMetadata = {
  name?: string
  description?: string
  nativeMemoryType?: string
}

function boundedString(value: unknown, maxChars: number): string | undefined {
  const normalized = asTrimmedString(value)
  return normalized ? truncateText(normalized, maxChars) : undefined
}

function boundContent(value: string): { content: string; contentTruncated?: true } {
  if (value.length <= CONTENT_MAX_CHARS) return { content: value }
  const helperLimit = CONTENT_MAX_CHARS - CONTENT_TRUNCATION_MARKER.length
  return {
    content: truncateTextWithMarker(value, helperLimit, {
      tailLength: CONTENT_TAIL_CHARS,
      marker: CONTENT_TRUNCATION_MARKER
    }),
    contentTruncated: true
  }
}

function stripYamlScalarQuotes(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).trim()
    }
  }
  return trimmed
}

function parseFrontmatter(content: string): NativeMemoryMetadata {
  const prefix = content.slice(0, 20_000).replace(/^\uFEFF/, '')
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:[ \t]*\r?\n|[ \t]*$)/.exec(prefix)
  if (!match) return {}

  const result: NativeMemoryMetadata = {}
  let inMetadata = false
  for (const rawLine of match[1].split(/\r?\n/)) {
    const indent = /^\s*/.exec(rawLine)?.[0].length ?? 0
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    const field = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line)
    if (!field) continue
    const key = field[1]
    const scalar = stripYamlScalarQuotes(field[2])

    if (indent === 0) inMetadata = key === 'metadata' && scalar === ''
    if (key === 'name' && indent === 0 && scalar) result.name = scalar
    if (key === 'description' && indent === 0 && scalar) result.description = scalar
    if ((key === 'metadata.type' || (inMetadata && key === 'type')) && scalar) {
      result.nativeMemoryType = scalar
    }
  }
  return result
}

function readNativeMemoryMetadata(toolInput: unknown, content: string | undefined): NativeMemoryMetadata {
  const frontmatter = content ? parseFrontmatter(content) : {}
  if (!isPlainObject(toolInput)) return frontmatter

  const metadata = isPlainObject(toolInput.metadata) ? toolInput.metadata : undefined
  return {
    name: boundedString(toolInput.name, NAME_MAX_CHARS)
      ?? boundedString(frontmatter.name, NAME_MAX_CHARS)
      ?? boundedString(toolInput.path, NAME_MAX_CHARS),
    description: boundedString(toolInput.description, DESCRIPTION_MAX_CHARS)
      ?? boundedString(frontmatter.description, DESCRIPTION_MAX_CHARS),
    nativeMemoryType: boundedString(metadata?.type, NATIVE_TYPE_MAX_CHARS)
      ?? boundedString(toolInput.nativeMemoryType, NATIVE_TYPE_MAX_CHARS)
      ?? boundedString(toolInput.type, NATIVE_TYPE_MAX_CHARS)
      ?? boundedString(frontmatter.nativeMemoryType, NATIVE_TYPE_MAX_CHARS)
  }
}

export function coerceMemoryWriteHintEvent(value: unknown): MemoryWriteHintEvent | null {
  if (!isPlainObject(value)) return null
  const sessionId = boundedString(value.sessionId, SESSION_ID_MAX_CHARS)
  const timestamp = asInteger(value.timestamp)
  const name = boundedString(value.name, NAME_MAX_CHARS)
  if (!sessionId || timestamp === null || timestamp < 0 || timestamp > MAX_DATE_TIMESTAMP || !name) return null

  const description = boundedString(value.description, DESCRIPTION_MAX_CHARS)
  const nativeMemoryType = boundedString(value.nativeMemoryType, NATIVE_TYPE_MAX_CHARS)
  const toolUseId = boundedString(value.toolUseId, TOOL_USE_ID_MAX_CHARS)
  const rawContent = typeof value.content === 'string' ? value.content : undefined
  const boundedContent = rawContent === undefined ? undefined : boundContent(rawContent)

  return {
    sessionId,
    timestamp,
    name,
    ...(description ? { description } : {}),
    ...(nativeMemoryType ? { nativeMemoryType } : {}),
    ...(toolUseId ? { toolUseId } : {}),
    ...(boundedContent ? { content: boundedContent.content } : {}),
    ...((value.contentTruncated === true || boundedContent?.contentTruncated)
      ? { contentTruncated: true }
      : {})
  }
}

export function createMemoryWriteHint(
  payload: PostToolUseInput | Record<string, unknown>,
  timestamp: number = Date.now()
): MemoryWriteHintEvent | null {
  if (!isPlainObject(payload)) return null
  const sessionId = boundedString(payload.session_id, SESSION_ID_MAX_CHARS)
  if (!sessionId) return null

  const toolInput = payload.tool_input
  const content = isPlainObject(toolInput) && typeof toolInput.content === 'string'
    ? toolInput.content
    : undefined
  const metadata = readNativeMemoryMetadata(toolInput, content)
  const rawContent = content ?? safeJsonStringify(toolInput) ?? 'null'
  const boundedContent = boundContent(rawContent)

  return coerceMemoryWriteHintEvent({
    sessionId,
    timestamp,
    name: metadata.name ?? 'memory_write',
    description: metadata.description,
    nativeMemoryType: metadata.nativeMemoryType,
    toolUseId: payload.tool_use_id,
    content: boundedContent.content,
    contentTruncated: boundedContent.contentTruncated
  })
}

export function appendMemoryWriteHint(event: MemoryWriteHintEvent): boolean {
  const normalized = coerceMemoryWriteHintEvent(event)
  if (!normalized) return false

  hintsStore.append(normalized.sessionId, [normalized], { collection: HINTS_NAMESPACE })
  return true
}

export function loadMemoryWriteHints(sessionId: string): MemoryWriteHintEvent[] {
  const normalizedSessionId = boundedString(sessionId, SESSION_ID_MAX_CHARS)
  if (!normalizedSessionId) return []

  const entries = hintsStore.readLines<MemoryWriteHintEvent>(normalizedSessionId, {
    collection: HINTS_NAMESPACE,
    coerce: coerceMemoryWriteHintEvent,
    onError: error => {
      console.error('[claude-memory] Failed to read memory_write hints:', error)
    },
    onLineError: () => {
      // Ignore an isolated malformed delivery and keep the remaining hints usable.
    }
  })

  const seenToolUseIds = new Set<string>()
  return entries.filter(entry => {
    if (!entry.toolUseId) return true
    if (seenToolUseIds.has(entry.toolUseId)) return false
    seenToolUseIds.add(entry.toolUseId)
    return true
  })
}

export function deleteMemoryWriteHints(sessionId: string): boolean {
  const normalizedSessionId = boundedString(sessionId, SESSION_ID_MAX_CHARS)
  if (!normalizedSessionId) return false
  return hintsStore.delete(normalizedSessionId, { collection: HINTS_NAMESPACE })
}

export function cleanupMemoryWriteHints(cutoffMs: number): void {
  if (!Number.isFinite(cutoffMs)) return
  hintsStore.cleanupByAge({
    collection: HINTS_NAMESPACE,
    cutoffMs
  })
}
