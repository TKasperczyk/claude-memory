import fs from 'fs'
import { asBoolean, asInjectionStatus, asInteger, asNumber, asRecordType, asString, asStringArray, isPlainObject } from './parsing.js'
import { JsonStore, isDefaultCollection } from './file-store.js'
import { acquireFileLock } from './lock.js'
import { sanitizeSessionId } from './shared.js'
import {
  EMBEDDING_DIM,
  type InjectedMemoryEntry,
  type InjectionPromptEntry,
  type InjectionSessionRecord,
  type InjectionStatus,
  type RecordType
} from './types.js'

const sessionStore = new JsonStore('sessions', { sanitizeKey: sanitizeSessionId })
const SNIPPET_TYPE_REGEX = /^(command|error|discovery|procedure|warning):/i
const LOCK_RETRY_DELAY_MS = 25
const LOCK_MAX_WAIT_MS = 1000
const LOCK_STALE_MS = 30_000

type SessionRetrievalStateUpdate = {
  recentlyInjectedIds?: string[]
  previousPromptEmbedding?: number[] | null
  lastPromptAt?: string
}

type SessionRetrievalStateAtomicUpdate = {
  sessionId: string
  newInjectedIds: string[]
  windowSize: number
  expectedRetrievalStateVersion?: number
}

function getLegacySessionTrackingPath(sessionId: string): string {
  return sessionStore.buildPath(sessionId, { legacy: true })
}

function getSessionTrackingPath(sessionId: string, collection?: string): string {
  return sessionStore.buildPath(sessionId, { collection })
}

function getSessionLockPath(sessionId: string, collection?: string): string {
  return `${getSessionTrackingPath(sessionId, collection)}.lock`
}

function withSessionLock<T>(sessionId: string, action: () => T, collection?: string): T | null {
  const lockPath = getSessionLockPath(sessionId, collection)
  const handle = acquireFileLock(lockPath, {
    staleAfterMs: LOCK_STALE_MS,
    staleStrategy: 'pid',
    ensureDir: true,
    wait: { maxWaitMs: LOCK_MAX_WAIT_MS, retryDelayMs: LOCK_RETRY_DELAY_MS },
    write: { data: () => `${process.pid}\n`, ignoreErrors: true },
    onTimeout: path => {
      console.warn('[claude-memory] Timed out waiting for session lock; skipping session tracking write:', path)
    },
    onStaleRemoved: path => {
      console.warn('[claude-memory] Removed stale session lock:', path)
    },
    onStaleRemoveError: error => {
      console.warn('[claude-memory] Failed to remove stale session lock:', error)
    }
  })

  if (!handle || !handle.locked) {
    console.warn('[claude-memory] Failed to acquire session lock for:', sessionId)
    return null
  }

  try {
    return action()
  } finally {
    handle.release()
  }
}

function readSessionTrackingFile(sessionId: string, collection?: string): InjectionSessionRecord | null {
  return sessionStore.read(sessionId, {
    collection,
    includeLegacyForDefault: isDefaultCollection(collection),
    errorMessage: '[claude-memory] Failed to read session tracking file:',
    coerce: data => coerceSessionRecord(data, sessionId),
    fallback: null
  })
}

export function loadSessionTracking(sessionId: string, collection?: string): InjectionSessionRecord | null {
  return readSessionTrackingFile(sessionId, collection)
}

export function saveSessionTracking(record: InjectionSessionRecord, collection?: string): void {
  try {
    sessionStore.write(record.sessionId, record, {
      collection,
      ensureDir: true,
      pretty: 2
    })
  } catch (error) {
    console.error('[claude-memory] Failed to write session tracking file:', error)
  }
}

export function appendRecentlyInjectedIds(
  existingIds: string[],
  injectedIds: string[],
  maxIds: number
): string[] {
  const limit = Math.max(0, Math.trunc(maxIds))
  if (limit <= 0) return []

  const nextIds = injectedIds
    .map(id => id.trim())
    .filter(id => id.length > 0)
  if (nextIds.length === 0) {
    return existingIds
      .map(id => id.trim())
      .filter(id => id.length > 0)
      .slice(-limit)
  }

  const refreshed = new Set(nextIds)
  const retained = existingIds
    .map(id => id.trim())
    .filter(id => id.length > 0 && !refreshed.has(id))

  return [...retained, ...Array.from(refreshed)].slice(-limit)
}

export function updateSessionRetrievalState(
  sessionId: string,
  update: SessionRetrievalStateUpdate,
  collection?: string
): InjectionSessionRecord | null {
  if (!sessionId) return null

  return withSessionLock(sessionId, () => {
    const existing = loadSessionTracking(sessionId, collection)
    const now = Date.now()
    const currentVersion = existing?.retrievalStateVersion ?? 0
    const record: InjectionSessionRecord = {
      sessionId,
      createdAt: existing?.createdAt ?? now,
      lastActivity: now,
      cwd: existing?.cwd,
      memories: existing?.memories ?? [],
      prompts: existing?.prompts,
      promptCount: existing?.promptCount,
      injectionCount: existing?.injectionCount,
      lastStatus: existing?.lastStatus,
      hasReview: existing?.hasReview,
      recentlyInjectedIds: update.recentlyInjectedIds ?? existing?.recentlyInjectedIds ?? [],
      previousPromptEmbedding: 'previousPromptEmbedding' in update
        ? update.previousPromptEmbedding ?? null
        : existing?.previousPromptEmbedding ?? null,
      lastPromptAt: update.lastPromptAt ?? existing?.lastPromptAt,
      retrievalStateVersion: currentVersion + 1
    }
    saveSessionTracking(record, collection)
    return record
  }, collection)
}

export function updateSessionPromptStateIfVersion(
  sessionId: string,
  update: { previousPromptEmbedding: number[]; lastPromptAt: string; expectedRetrievalStateVersion: number },
  collection?: string
): InjectionSessionRecord | null {
  if (!sessionId) return null

  return withSessionLock(sessionId, () => {
    const existing = loadSessionTracking(sessionId, collection)
    const currentVersion = existing?.retrievalStateVersion ?? 0
    if (currentVersion !== update.expectedRetrievalStateVersion) {
      console.warn(
        `[claude-memory] Skipping prompt embedding write for stale retrieval state: expected version ${update.expectedRetrievalStateVersion}, found ${currentVersion}`
      )
      return null
    }

    const now = Date.now()
    const record: InjectionSessionRecord = {
      sessionId,
      createdAt: existing?.createdAt ?? now,
      lastActivity: now,
      cwd: existing?.cwd,
      memories: existing?.memories ?? [],
      prompts: existing?.prompts,
      promptCount: existing?.promptCount,
      injectionCount: existing?.injectionCount,
      lastStatus: existing?.lastStatus,
      hasReview: existing?.hasReview,
      recentlyInjectedIds: existing?.recentlyInjectedIds ?? [],
      previousPromptEmbedding: update.previousPromptEmbedding,
      lastPromptAt: update.lastPromptAt,
      retrievalStateVersion: currentVersion + 1
    }
    saveSessionTracking(record, collection)
    return record
  }, collection)
}

export function updateSessionRetrievalStateAtomic(
  update: SessionRetrievalStateAtomicUpdate,
  collection?: string
): InjectionSessionRecord | null {
  if (!update.sessionId) return null

  return withSessionLock(update.sessionId, () => {
    const existing = loadSessionTracking(update.sessionId, collection)
    const currentVersion = existing?.retrievalStateVersion ?? 0
    if (
      update.expectedRetrievalStateVersion !== undefined &&
      currentVersion !== update.expectedRetrievalStateVersion
    ) {
      console.warn(
        `[claude-memory] Skipping recently injected write for stale retrieval state: expected version ${update.expectedRetrievalStateVersion}, found ${currentVersion}`
      )
      return null
    }
    const now = Date.now()
    const recentlyInjectedIds = appendRecentlyInjectedIds(
      existing?.recentlyInjectedIds ?? [],
      update.newInjectedIds,
      update.windowSize
    )
    const record: InjectionSessionRecord = {
      sessionId: update.sessionId,
      createdAt: existing?.createdAt ?? now,
      lastActivity: now,
      cwd: existing?.cwd,
      memories: existing?.memories ?? [],
      prompts: existing?.prompts,
      promptCount: existing?.promptCount,
      injectionCount: existing?.injectionCount,
      lastStatus: existing?.lastStatus,
      hasReview: existing?.hasReview,
      recentlyInjectedIds,
      previousPromptEmbedding: existing?.previousPromptEmbedding ?? null,
      lastPromptAt: existing?.lastPromptAt,
      retrievalStateVersion: currentVersion + 1
    }
    saveSessionTracking(record, collection)
    return record
  }, collection)
}

export function markInjectedForSuppression(
  sessionId: string,
  injectedIds: string[],
  windowSize: number,
  collection?: string,
  options: { expectedRetrievalStateVersion?: number } = {}
): InjectionSessionRecord | null {
  return updateSessionRetrievalStateAtomic({
    sessionId,
    newInjectedIds: injectedIds,
    windowSize,
    expectedRetrievalStateVersion: options.expectedRetrievalStateVersion
  }, collection)
}

export function appendSessionTracking(
  sessionId: string,
  entries: InjectedMemoryEntry[],
  cwd?: string,
  prompt?: string,
  status: InjectionStatus = 'injected',
  collection?: string
): InjectionSessionRecord | null {
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
      hasReview: existing?.hasReview,
      recentlyInjectedIds: existing?.recentlyInjectedIds ?? [],
      previousPromptEmbedding: existing?.previousPromptEmbedding ?? null,
      lastPromptAt: existing?.lastPromptAt,
      retrievalStateVersion: existing?.retrievalStateVersion ?? 0
    }
    saveSessionTracking(record, collection)
    return record
  }, collection)
}

export function listAllSessions(collection?: string): InjectionSessionRecord[] {
  try {
    const ids = sessionStore.list({
      collection,
      includeLegacyForDefault: isDefaultCollection(collection)
    })
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
  sessionStore.delete(sessionId, {
    collection,
    includeLegacyForDefault: isDefaultCollection(collection),
    continueOnError: true,
    onError: error => console.error('[claude-memory] Failed to remove session tracking file:', error)
  })

  const lockPaths = [getSessionLockPath(sessionId, collection)]

  if (isDefaultCollection(collection)) {
    const legacyPath = getLegacySessionTrackingPath(sessionId)
    lockPaths.push(`${legacyPath}.lock`)
  }

  for (const filePath of lockPaths) {
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
  const recentlyInjectedIds = asStringArray(record.recentlyInjectedIds, {
    trim: true,
    filterEmpty: true,
    unique: true
  })
  const previousPromptEmbedding = coerceEmbedding(record.previousPromptEmbedding)
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
    hasReview: hasReview ?? undefined,
    recentlyInjectedIds,
    previousPromptEmbedding,
    lastPromptAt: asString(record.lastPromptAt),
    retrievalStateVersion: asInteger(record.retrievalStateVersion) ?? 0
  }
}

function coerceEmbedding(value: unknown): number[] | null {
  if (value === null || value === undefined) return null
  if (!Array.isArray(value)) return null

  const embedding: number[] = []
  for (const item of value) {
    const parsed = asNumber(item)
    if (parsed === null) return null
    embedding.push(parsed)
  }
  return embedding.length === EMBEDDING_DIM ? embedding : null
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
