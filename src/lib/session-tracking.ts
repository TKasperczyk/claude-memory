import fs from 'fs'
import path from 'path'
import { homedir } from 'os'
import { asBoolean, asInjectionStatus, asInteger, asNumber, asRecordType, asString, isPlainObject } from './parsing.js'
import { readJsonFileSafe, writeJsonFile } from './json.js'
import { acquireFileLock } from './lock.js'
import { sanitizeSessionId } from './shared.js'
import { getCollectionKey } from './retrieval-events.js'
import { isDefaultCollection } from './storage-paths.js'
import {
  type InjectedMemoryEntry,
  type InjectionPromptEntry,
  type InjectionSessionRecord,
  type InjectionStatus,
  type RecordType
} from './types.js'

const SESSIONS_ROOT = path.join(homedir(), '.claude-memory', 'sessions')
const SNIPPET_TYPE_REGEX = /^(command|error|discovery|procedure|warning):/i
const LOCK_RETRY_DELAY_MS = 25
const LOCK_MAX_WAIT_MS = 1000
const LOCK_STALE_MS = 30_000

function getSessionsDir(collection?: string): string {
  return path.join(SESSIONS_ROOT, getCollectionKey(collection))
}

function getLegacySessionTrackingPath(sessionId: string): string {
  const safeId = sanitizeSessionId(sessionId)
  return path.join(SESSIONS_ROOT, `${safeId}.json`)
}

function getSessionTrackingPath(sessionId: string, collection?: string): string {
  const safeId = sanitizeSessionId(sessionId)
  return path.join(getSessionsDir(collection), `${safeId}.json`)
}

function getSessionLockPath(sessionId: string, collection?: string): string {
  return `${getSessionTrackingPath(sessionId, collection)}.lock`
}

function withSessionLock<T>(sessionId: string, action: () => T, collection?: string): T {
  const lockPath = getSessionLockPath(sessionId, collection)
  const handle = acquireFileLock(lockPath, {
    staleAfterMs: LOCK_STALE_MS,
    staleStrategy: 'pid',
    wait: { maxWaitMs: LOCK_MAX_WAIT_MS, retryDelayMs: LOCK_RETRY_DELAY_MS },
    proceedOnTimeout: true,
    write: { data: () => `${process.pid}\n`, ignoreErrors: true },
    onTimeout: path => {
      console.warn('[claude-memory] Timed out waiting for session lock; proceeding without lock:', path)
    },
    onStaleRemoved: path => {
      console.warn('[claude-memory] Removed stale session lock:', path)
    },
    onStaleRemoveError: error => {
      console.warn('[claude-memory] Failed to remove stale session lock:', error)
    }
  })

  if (!handle) return action()

  try {
    return action()
  } finally {
    handle.release()
  }
}

function readSessionTrackingFile(filePath: string, sessionId: string): InjectionSessionRecord | null {
  return readJsonFileSafe(filePath, {
    errorMessage: '[claude-memory] Failed to read session tracking file:',
    coerce: data => coerceSessionRecord(data, sessionId)
  })
}

export function loadSessionTracking(sessionId: string, collection?: string): InjectionSessionRecord | null {
  const primary = readSessionTrackingFile(getSessionTrackingPath(sessionId, collection), sessionId)
  if (primary) return primary
  if (!isDefaultCollection(collection)) return null
  return readSessionTrackingFile(getLegacySessionTrackingPath(sessionId), sessionId)
}

export function saveSessionTracking(record: InjectionSessionRecord, collection?: string): void {
  try {
    const filePath = getSessionTrackingPath(record.sessionId, collection)
    writeJsonFile(filePath, record, { ensureDir: true, pretty: 2 })
  } catch (error) {
    console.error('[claude-memory] Failed to write session tracking file:', error)
  }
}

export function appendSessionTracking(
  sessionId: string,
  entries: InjectedMemoryEntry[],
  cwd?: string,
  prompt?: string,
  status: InjectionStatus = 'injected',
  collection?: string
): InjectionSessionRecord {
  // Add prompt to all entries if provided
  if (typeof prompt === 'string') {
    entries = entries.map(e => ({ ...e, prompt }))
  }
  return withSessionLock(sessionId, () => {
    const existing = loadSessionTracking(sessionId, collection)
    const now = Date.now()

    const prevPromptCount = existing?.promptCount ?? existing?.prompts?.length ?? 0
    const prevInjectionCount = existing?.injectionCount ?? countPromptInjections(existing?.prompts)
    const didInject = status === 'injected' && entries.length > 0
    const promptEntry: InjectionPromptEntry = {
      text: typeof prompt === 'string' ? prompt : '',
      timestamp: now,
      status,
      memoryCount: entries.length
    }

    const record: InjectionSessionRecord = {
      sessionId,
      createdAt: existing?.createdAt ?? now,
      lastActivity: now,
      cwd: cwd ?? existing?.cwd,
      memories: [...(existing?.memories ?? []), ...entries],
      prompts: [...(existing?.prompts ?? []), promptEntry],
      promptCount: prevPromptCount + 1,
      injectionCount: prevInjectionCount + (didInject ? 1 : 0),
      lastStatus: status,
      hasReview: existing?.hasReview
    }
    saveSessionTracking(record, collection)
    return record
  }, collection)
}

function listSessionIds(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(file => file.replace(/\.json$/, ''))
  } catch (error) {
    console.error('[claude-memory] Failed to list sessions:', error)
    return []
  }
}

export function listAllSessions(collection?: string): InjectionSessionRecord[] {
  const ids = new Set<string>(listSessionIds(getSessionsDir(collection)))
  if (isDefaultCollection(collection)) {
    for (const id of listSessionIds(SESSIONS_ROOT)) {
      ids.add(id)
    }
  }

  try {
    const sessions: InjectionSessionRecord[] = []
    for (const sessionId of ids) {
      const record = loadSessionTracking(sessionId, collection)
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

export function removeSessionTracking(sessionId: string, collection?: string): void {
  const paths = [getSessionTrackingPath(sessionId, collection)]
  const lockPaths = [getSessionLockPath(sessionId, collection)]

  if (isDefaultCollection(collection)) {
    const legacyPath = getLegacySessionTrackingPath(sessionId)
    paths.push(legacyPath)
    lockPaths.push(`${legacyPath}.lock`)
  }

  for (const filePath of [...paths, ...lockPaths]) {
    if (!fs.existsSync(filePath)) continue

    try {
      fs.unlinkSync(filePath)
    } catch (error) {
      console.error('[claude-memory] Failed to remove session tracking file:', error)
    }
  }
}

function coerceSessionRecord(value: unknown, sessionId: string): InjectionSessionRecord | null {
  if (!isPlainObject(value)) return null

  const record = value
  const memories = coerceMemoryEntries(record.memories)
  const prompts = coercePromptEntries(record.prompts)
  const now = Date.now()
  const createdAt = asInteger(record.createdAt) ?? now

  const hasReview = asBoolean(record.hasReview)

  return {
    sessionId: asString(record.sessionId) ?? sessionId,
    createdAt,
    lastActivity: asInteger(record.lastActivity) ?? createdAt,
    cwd: asString(record.cwd),
    memories,
    prompts,
    promptCount: asInteger(record.promptCount) ?? undefined,
    injectionCount: asInteger(record.injectionCount) ?? undefined,
    lastStatus: asInjectionStatus(record.lastStatus),
    hasReview: hasReview ?? undefined
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

function coercePromptEntries(value: unknown): InjectionPromptEntry[] | undefined {
  if (!Array.isArray(value)) return undefined

  const entries: InjectionPromptEntry[] = []
  for (const item of value) {
    if (!isPlainObject(item)) continue
    const record = item
    const text = asString(record.text)
    const timestamp = asInteger(record.timestamp)
    const status = asInjectionStatus(record.status)
    const memoryCount = asInteger(record.memoryCount)
    if (text === undefined || timestamp === null || !status || memoryCount === null) continue

    entries.push({ text, timestamp, status, memoryCount })
  }

  return entries
}

function parseSnippetType(snippet: string): RecordType | null {
  const match = snippet.match(SNIPPET_TYPE_REGEX)
  if (!match) return null
  const type = match[1].toLowerCase()
  return asRecordType(type) ?? null
}

function countPromptInjections(prompts: InjectionPromptEntry[] | undefined): number {
  if (!prompts) return 0
  return prompts.filter(prompt => prompt.status === 'injected' && prompt.memoryCount > 0).length
}
