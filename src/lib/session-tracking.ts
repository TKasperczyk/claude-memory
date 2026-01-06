import fs from 'fs'
import path from 'path'
import { homedir } from 'os'
import { asBoolean, asInjectionStatus, asInteger, asNumber, asRecordType, asString, isPlainObject } from './parsing.js'
import { type InjectedMemoryEntry, type InjectionSessionRecord, type InjectionStatus, type RecordType } from './types.js'

const SESSIONS_DIR = path.join(homedir(), '.claude-memory', 'sessions')
const SNIPPET_TYPE_REGEX = /^(command|error|discovery|procedure):/i

export function getSessionTrackingPath(sessionId: string): string {
  const safeId = sanitizeSessionId(sessionId)
  return path.join(SESSIONS_DIR, `${safeId}.json`)
}

export function loadSessionTracking(sessionId: string): InjectionSessionRecord | null {
  const filePath = getSessionTrackingPath(sessionId)
  if (!fs.existsSync(filePath)) return null

  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    return coerceSessionRecord(parsed, sessionId)
  } catch (error) {
    console.error('[claude-memory] Failed to read session tracking file:', error)
    return null
  }
}

export function saveSessionTracking(record: InjectionSessionRecord): void {
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true })
    const filePath = getSessionTrackingPath(record.sessionId)
    fs.writeFileSync(filePath, JSON.stringify(record, null, 2))
  } catch (error) {
    console.error('[claude-memory] Failed to write session tracking file:', error)
  }
}

export function appendSessionTracking(
  sessionId: string,
  entries: InjectedMemoryEntry[],
  cwd?: string,
  prompt?: string,
  status: InjectionStatus = 'injected'
): InjectionSessionRecord {
  // Add prompt to all entries if provided
  if (prompt) {
    entries = entries.map(e => ({ ...e, prompt }))
  }
  const existing = loadSessionTracking(sessionId)
  const now = Date.now()

  const prevPromptCount = existing?.promptCount ?? 0
  const prevInjectionCount = existing?.injectionCount ?? 0
  const didInject = status === 'injected' && entries.length > 0

  const record: InjectionSessionRecord = {
    sessionId,
    createdAt: existing?.createdAt ?? now,
    lastActivity: now,
    cwd: cwd ?? existing?.cwd,
    memories: [...(existing?.memories ?? []), ...entries],
    promptCount: prevPromptCount + 1,
    injectionCount: prevInjectionCount + (didInject ? 1 : 0),
    lastStatus: status
  }
  saveSessionTracking(record)
  return record
}

export function listAllSessions(): InjectionSessionRecord[] {
  if (!fs.existsSync(SESSIONS_DIR)) return []

  try {
    const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'))
    const sessions: InjectionSessionRecord[] = []

    for (const file of files) {
      const sessionId = file.replace(/\.json$/, '')
      const record = loadSessionTracking(sessionId)
      if (record) sessions.push(record)
    }

    // Sort by lastActivity descending (most recent first)
    sessions.sort((a, b) => b.lastActivity - a.lastActivity)
    return sessions
  } catch (error) {
    console.error('[claude-memory] Failed to list sessions:', error)
    return []
  }
}

export function dedupeInjectedMemories(memories: InjectedMemoryEntry[]): InjectedMemoryEntry[] {
  const byId = new Map<string, InjectedMemoryEntry>()

  for (const entry of memories) {
    if (!entry.id) continue
    const existing = byId.get(entry.id)
    if (!existing || entry.injectedAt >= existing.injectedAt) {
      byId.set(entry.id, entry)
    }
  }

  return Array.from(byId.values())
}

export function removeSessionTracking(sessionId: string): void {
  const filePath = getSessionTrackingPath(sessionId)
  if (!fs.existsSync(filePath)) return

  try {
    fs.unlinkSync(filePath)
  } catch (error) {
    console.error('[claude-memory] Failed to remove session tracking file:', error)
  }
}

function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[\\/]/g, '_')
}

function coerceSessionRecord(value: unknown, sessionId: string): InjectionSessionRecord | null {
  if (!isPlainObject(value)) return null

  const record = value
  const memories = coerceMemoryEntries(record.memories)
  const now = Date.now()
  const createdAt = asInteger(record.createdAt) ?? now

  return {
    sessionId: asString(record.sessionId) ?? sessionId,
    createdAt,
    lastActivity: asInteger(record.lastActivity) ?? createdAt,
    cwd: asString(record.cwd),
    memories,
    promptCount: asInteger(record.promptCount) ?? undefined,
    injectionCount: asInteger(record.injectionCount) ?? undefined,
    lastStatus: asInjectionStatus(record.lastStatus)
  }
}

function coerceMemoryEntries(value: unknown): InjectedMemoryEntry[] {
  if (!Array.isArray(value)) return []

  const entries: InjectedMemoryEntry[] = []
  for (const item of value) {
    if (!isPlainObject(item)) continue
    const record = item
    const id = asString(record.id)
    const snippet = asString(record.snippet)
    const injectedAt = asInteger(record.injectedAt)
    if (!id || !snippet || injectedAt === null) continue
    const prompt = asString(record.prompt)
    const type = asRecordType(record.type) ?? parseSnippetType(snippet)

    const entry: InjectedMemoryEntry = { id, snippet, injectedAt }
    if (prompt) entry.prompt = prompt
    if (type) entry.type = type

    // Parse retrieval trigger metadata
    const similarity = asNumber(record.similarity)
    const keywordMatch = asBoolean(record.keywordMatch)
    const score = asNumber(record.score)
    if (similarity !== null) entry.similarity = similarity
    if (keywordMatch !== null) entry.keywordMatch = keywordMatch
    if (score !== null) entry.score = score

    entries.push(entry)
  }

  return entries
}

function parseSnippetType(snippet: string): RecordType | null {
  const match = snippet.match(SNIPPET_TYPE_REGEX)
  if (!match) return null
  const type = match[1].toLowerCase()
  return asRecordType(type) ?? null
}
