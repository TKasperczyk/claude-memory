import fs from 'fs'
import path from 'path'
import { homedir } from 'os'
import { asBoolean, asInjectionStatus, asInteger, asNumber, asRecordType, asString, isPlainObject } from './parsing.js'
import { readJsonFile, writeJsonFile } from './json.js'
import { sanitizeSessionId } from './shared.js'
import {
  type InjectedMemoryEntry,
  type InjectionPromptEntry,
  type InjectionSessionRecord,
  type InjectionStatus,
  type RecordType
} from './types.js'

const SESSIONS_DIR = path.join(homedir(), '.claude-memory', 'sessions')
const SNIPPET_TYPE_REGEX = /^(command|error|discovery|procedure|warning):/i
const LOCK_RETRY_DELAY_MS = 25
const LOCK_MAX_WAIT_MS = 1000
const LOCK_STALE_MS = 30_000
const LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(4))

function getSessionTrackingPath(sessionId: string): string {
  const safeId = sanitizeSessionId(sessionId)
  return path.join(SESSIONS_DIR, `${safeId}.json`)
}

function getSessionLockPath(sessionId: string): string {
  return `${getSessionTrackingPath(sessionId)}.lock`
}

function sleep(ms: number): void {
  Atomics.wait(LOCK_SLEEP, 0, 0, ms)
}

function readLockPid(lockPath: string): number | null {
  try {
    const content = fs.readFileSync(lockPath, 'utf-8').trim()
    if (!content) return null
    const pid = Number.parseInt(content, 10)
    return Number.isNaN(pid) ? null : pid
  } catch {
    return null
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return false
    return true
  }
}

function isStaleLock(lockPath: string, now: number): boolean {
  try {
    const pid = readLockPid(lockPath)
    if (pid !== null) {
      return !isProcessAlive(pid)
    }
    const stats = fs.statSync(lockPath)
    const ageMs = now - stats.mtimeMs
    return ageMs >= LOCK_STALE_MS
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return false
    return false
  }
}

function withSessionLock<T>(sessionId: string, action: () => T): T {
  const lockPath = getSessionLockPath(sessionId)
  const start = Date.now()
  let fd: number | null = null

  while (fd === null) {
    try {
      fd = fs.openSync(lockPath, 'wx')
      try {
        fs.writeFileSync(fd, `${process.pid}\n`)
      } catch {
        // Ignore lock metadata errors
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') {
        throw error
      }
      const now = Date.now()
      if (isStaleLock(lockPath, now)) {
        let removed = false
        try {
          fs.unlinkSync(lockPath)
          removed = true
          console.warn('[claude-memory] Removed stale session lock:', lockPath)
        } catch (unlinkError) {
          console.warn('[claude-memory] Failed to remove stale session lock:', unlinkError)
        }
        if (removed) continue
      }
      if (now - start >= LOCK_MAX_WAIT_MS) {
        console.warn('[claude-memory] Timed out waiting for session lock; proceeding without lock:', lockPath)
        return action()
      }
      sleep(LOCK_RETRY_DELAY_MS)
    }
  }

  try {
    return action()
  } finally {
    try {
      fs.closeSync(fd)
    } catch {
      // Ignore close errors
    }
    try {
      fs.unlinkSync(lockPath)
    } catch {
      // Ignore unlink errors
    }
  }
}

export function loadSessionTracking(sessionId: string): InjectionSessionRecord | null {
  const filePath = getSessionTrackingPath(sessionId)
  return readJsonFile(filePath, {
    onError: error => console.error('[claude-memory] Failed to read session tracking file:', error),
    coerce: data => coerceSessionRecord(data, sessionId)
  })
}

export function saveSessionTracking(record: InjectionSessionRecord): void {
  try {
    const filePath = getSessionTrackingPath(record.sessionId)
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
  status: InjectionStatus = 'injected'
): InjectionSessionRecord {
  // Add prompt to all entries if provided
  if (typeof prompt === 'string') {
    entries = entries.map(e => ({ ...e, prompt }))
  }
  return withSessionLock(sessionId, () => {
    const existing = loadSessionTracking(sessionId)
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
    saveSessionTracking(record)
    return record
  })
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
