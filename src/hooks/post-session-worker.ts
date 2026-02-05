#!/usr/bin/env node
/**
 * Post-session worker - runs extraction in background.
 * Spawned by post-session.ts launcher as a detached process.
 */

import fs, { appendFileSync } from 'fs'
import { homedir } from 'os'
import { randomUUID } from 'crypto'
import { closeMilvus, flushCollection, initMilvus, incrementRecordCounters } from '../lib/milvus.js'
import { rateInjectedMemories } from '../lib/extract.js'
import { parseTranscript, type Transcript, type TranscriptEvent, getFirstUserPrompt } from '../lib/transcript.js'
import { dedupeInjectedMemories, loadSessionTracking, removeSessionTracking } from '../lib/session-tracking.js'
import { loadConfig } from '../lib/config.js'
import { saveExtractionRun, type ExtractionRecordSummary } from '../lib/extraction-log.js'
import { type Config, type ExtractionHookInput, type HookInput, type InjectedMemoryEntry, type MemoryRecord } from '../lib/types.js'
import { safeJsonStringifyCompact } from '../lib/json.js'
import { getRecordSearchableTextParts } from '../lib/record-fields.js'
import { getRecordSummary } from '../lib/record-summary.js'
import { acquireFileLock } from '../lib/lock.js'
import { handlePostSession } from './post-session.js'
import { findGitRoot } from '../lib/context.js'

const DEBUG = process.env.CLAUDE_MEMORY_DEBUG === '1'
const DEBUG_LOG_FILE = `${homedir()}/.claude-memory/debug.log`
const AUDIT_LOG_FILE = `${homedir()}/.claude-memory/extraction-audit.log`
const LOCKS_DIR = `${homedir()}/.claude-memory/locks`
const LOCK_STALE_MS = 5 * 60 * 1000
const workerStartTime = Date.now()

function acquireWorkerLock(sessionId: string): ReturnType<typeof acquireFileLock> {
  const lockFile = `${LOCKS_DIR}/${sessionId}.lock`
  return acquireFileLock(lockFile, {
    staleAfterMs: LOCK_STALE_MS,
    staleStrategy: 'mtime',
    ensureDir: true,
    proceedOnError: true,
    write: { data: () => `${process.pid}\n${Date.now()}` },
    onLockError: error => {
      console.error('[claude-memory] Lock acquisition error:', error)
    }
  })
}

function debugLog(msg: string): void {
  if (!DEBUG) return
  const ts = new Date().toISOString()
  const elapsed = Date.now() - workerStartTime
  const line = `[worker] ${ts} +${elapsed}ms ${msg}\n`
  console.error(line.trim())
  try {
    appendFileSync(DEBUG_LOG_FILE, line)
  } catch {
    // ignore
  }
}

/** Always-on audit log for debugging extraction issues */
function auditLog(msg: string): void {
  const ts = new Date().toISOString()
  const line = `${ts} [pid=${process.pid}] ${msg}\n`
  try {
    appendFileSync(AUDIT_LOG_FILE, line)
  } catch {
    // ignore
  }
}

function readInputFile(filePath: string): string {
  debugLog(`Reading input file: ${filePath}`)
  const content = fs.readFileSync(filePath, 'utf-8')
  debugLog(`Read ${content.length} bytes from input file`)
  // Clean up temp file after reading
  try {
    fs.unlinkSync(filePath)
    debugLog('Deleted temp file')
  } catch {
    // ignore
  }
  return content
}

async function main(): Promise<void> {
  debugLog(`START pid=${process.pid}`)
  try {
    const inputFile = process.argv[2]
    if (!inputFile) {
      debugLog('No input file argument provided')
      console.error('[claude-memory] No input file argument.')
      return
    }

    if (!fs.existsSync(inputFile)) {
      debugLog(`Input file not found: ${inputFile}`)
      console.error(`[claude-memory] Input file not found: ${inputFile}`)
      return
    }

    const raw = readInputFile(inputFile)
    if (!raw.trim()) {
      console.error('[claude-memory] Empty hook input.')
      return
    }

    let basePayload: HookInput
    try {
      basePayload = JSON.parse(raw) as HookInput
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[claude-memory] Failed to parse hook input: ${message}`)
      return
    }

    // Accept both SessionEnd and PreCompact events
    if (basePayload.hook_event_name !== 'SessionEnd' && basePayload.hook_event_name !== 'PreCompact') {
      console.error('[claude-memory] Unexpected hook event:', basePayload.hook_event_name)
      return
    }

    const payload = basePayload as ExtractionHookInput
    debugLog(`Parsed payload: event=${payload.hook_event_name}, session=${payload.session_id}`)
    auditLog(`START event=${payload.hook_event_name} session=${payload.session_id} transcript=${payload.transcript_path}`)
    const configRoot = findGitRoot(payload.cwd) ?? payload.cwd
    const config = loadConfig(configRoot)
    const collection = config.milvus.collection

    // Try to acquire lock - prevents duplicate extractions when hook fires multiple times
    const lockHandle = acquireWorkerLock(payload.session_id)
    if (!lockHandle) {
      debugLog('Skipping: lock already held by another process')
      auditLog(`SKIP reason=locked session=${payload.session_id}`)
      return
    }

    try {
      // Skip extraction if session was cleared
      if (payload.hook_event_name === 'SessionEnd' && payload.reason === 'clear') {
        debugLog('Skipping: reason=clear')
        auditLog(`SKIP reason=clear session=${payload.session_id}`)
        console.error('[claude-memory] SessionEnd reason=clear; skipping extraction.')
        removeSessionTracking(payload.session_id, collection)
        return
      }

      if (!payload.transcript_path) {
        debugLog('Skipping: no transcript_path')
        auditLog(`SKIP reason=no_transcript session=${payload.session_id}`)
        console.warn('[claude-memory] Transcript not found; skipping extraction. path=missing')
        if (payload.hook_event_name === 'SessionEnd') {
          removeSessionTracking(payload.session_id, collection)
        }
        return
      }

      debugLog('Initializing Milvus...')
      await initMilvus(config)
      debugLog('Milvus initialized')

      // Load session tracking to get injected memories for change detection
      const session = loadSessionTracking(payload.session_id, collection)
      const injectedMemories = session ? dedupeInjectedMemories(session.memories) : []
      debugLog(`Loaded ${injectedMemories.length} injected memories for change detection`)

      let result: Awaited<ReturnType<typeof handlePostSession>> | null = null
      let shouldFlush = false
      const extractionStart = Date.now()
      let extractionDuration = 0
      try {
        debugLog('Running extraction...')
        result = await handlePostSession(payload, config, {
          flush: 'end-of-batch',
          injectedMemories,
          recordAugmenter: (record, transcript) => ({
            ...record,
            sourceSessionId: payload.session_id,
            // Prefer LLM-provided sourceExcerpt, fall back to heuristic search
            sourceExcerpt: record.sourceExcerpt ?? buildSourceExcerpt(record, transcript)
          })
        })
        debugLog(`Extraction done: inserted=${result.inserted}, updated=${result.updated}, skipped=${result.skipped}, failed=${result.failed}`)
        shouldFlush = (result.inserted + result.updated) > 0
        extractionDuration = Date.now() - extractionStart
        saveRunLog(payload, result, extractionDuration, collection)
      } finally {
        debugLog('Running usefulness rating...')
        shouldFlush = (await processUsefulnessRating(payload, config, result?.transcript)) || shouldFlush
        debugLog('Usefulness rating done')
      }

      if (shouldFlush) {
        debugLog('Flushing Milvus writes...')
        await flushCollection(config)
      }

      if (!result) return

      if (result.reason === 'no_transcript') {
        console.warn(`[claude-memory] Transcript not found; skipping extraction. path=${payload.transcript_path}`)
        return
      }

      if (result.reason === 'no_records') {
        console.error('[claude-memory] No records extracted.')
        return
      }

      console.error(
        `[claude-memory] Extraction complete: inserted=${result.inserted}, updated=${result.updated}, skipped=${result.skipped}, failed=${result.failed}`
      )
      debugLog('COMPLETE')
    } finally {
      lockHandle.release()
    }
  } finally {
    try {
      await closeMilvus()
    } catch (error) {
      console.error('[claude-memory] Failed to close Milvus connection:', error)
    }
  }
}

function saveRunLog(
  payload: ExtractionHookInput,
  result: Awaited<ReturnType<typeof handlePostSession>>,
  duration: number,
  collection?: string
): void {
  if (result.reason === 'no_transcript' || result.reason === 'clear' || result.reason === 'wrong_event') {
    auditLog(`DONE session=${payload.session_id} reason=${result.reason} (no run saved)`)
    return
  }

  const insertedIds = Array.from(new Set(result.insertedIds ?? []))
  const updatedIds = Array.from(new Set(result.updatedIds ?? []))
  const uniqueIds = Array.from(new Set([...insertedIds, ...updatedIds]))
  const runId = randomUUID()
  const extractedRecords = result.records
    .map(record => buildRecordSummary(record))
    .filter((record): record is ExtractionRecordSummary => Boolean(record))
  const firstPrompt = result.transcript ? getFirstUserPrompt(result.transcript) : undefined

  saveExtractionRun({
    runId,
    sessionId: payload.session_id,
    transcriptPath: payload.transcript_path,
    timestamp: Date.now(),
    recordCount: uniqueIds.length,
    parseErrorCount: result.transcript?.parseErrors ?? 0,
    extractedRecordIds: insertedIds,
    updatedRecordIds: updatedIds.length > 0 ? updatedIds : undefined,
    extractedRecords,
    duration,
    firstPrompt
  }, collection)

  auditLog(`DONE session=${payload.session_id} runId=${runId} inserted=${result.inserted} updated=${result.updated} skipped=${result.skipped} failed=${result.failed} duration=${duration}ms`)
}

function buildRecordSummary(record: MemoryRecord): ExtractionRecordSummary | null {
  const summary = getRecordSummary(record)
  if (!record.id || !summary) return null
  return {
    id: record.id,
    type: record.type,
    summary,
    timestamp: record.timestamp
  }
}

async function processUsefulnessRating(
  payload: ExtractionHookInput,
  config: Config,
  transcript?: Transcript
): Promise<boolean> {
  if (payload.hook_event_name !== 'SessionEnd') return false

  const collection = config.milvus.collection
  const session = loadSessionTracking(payload.session_id, collection)
  if (!session || session.memories.length === 0) {
    removeSessionTracking(payload.session_id, collection)
    return false
  }

  const memories = session.memories
  if (memories.length === 0) {
    removeSessionTracking(payload.session_id, collection)
    return false
  }

  let updated = false
  try {
    const retrievalDeltas = countRetrievalDeltas(memories)
    if (retrievalDeltas.size > 0) {
      await Promise.all(
        Array.from(retrievalDeltas.entries()).map(([id, count]) =>
          incrementRecordCounters(id, { retrievalCount: count }, config)
        )
      )
      updated = true
    }
  } catch (error) {
    console.error('[claude-memory] Failed to update retrieval counts:', error)
  }

  const deduped = dedupeInjectedMemories(memories)
  if (deduped.length === 0) {
    removeSessionTracking(payload.session_id, collection)
    return updated
  }

  let shouldRemove = false

  try {
    let resolvedTranscript = transcript
    if (!resolvedTranscript) {
      if (!payload.transcript_path || !fs.existsSync(payload.transcript_path)) {
        console.error('[claude-memory] Transcript missing for usefulness rating; keeping session tracking file.')
        return updated
      }
      resolvedTranscript = await parseTranscript(payload.transcript_path)
    }

    const helpfulIds = await rateInjectedMemories(resolvedTranscript, deduped, config)

    if (helpfulIds.length > 0) {
      // NOTE: Best-effort counters; concurrent sessions can drop increments.
      await Promise.all(helpfulIds.map(id =>
        incrementRecordCounters(id, { usageCount: 1 }, config)
      ))
      updated = true
    }

    shouldRemove = true
  } catch (error) {
    console.error('[claude-memory] Usefulness rating failed:', error)
  } finally {
    if (shouldRemove) {
      removeSessionTracking(payload.session_id, collection)
    }
  }

  return updated
}

function countRetrievalDeltas(memories: InjectedMemoryEntry[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const entry of memories) {
    if (!entry.id) continue
    counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1)
  }
  return counts
}

const SEGMENT_MAX_CHARS = 8000
const SEGMENT_EVENT_WINDOW = 3

function buildSourceExcerpt(record: MemoryRecord, transcript: Transcript): string | undefined {
  const candidates = buildExcerptCandidates(record)
  if (candidates.length === 0) return undefined

  const events = buildSearchableEvents(transcript.events)
  if (events.length === 0) return undefined

  for (const candidate of candidates) {
    const normalizedCandidate = normalizeSearchText(candidate)
    if (!normalizedCandidate) continue
    const lowerCandidate = normalizedCandidate.toLowerCase()

    for (let index = 0; index < events.length; index += 1) {
      const event = events[index]
      if (event.searchText.includes(normalizedCandidate) || event.lowerSearch.includes(lowerCandidate)) {
        return buildTranscriptSegment(events, index)
      }
    }
  }

  return undefined
}

function buildExcerptCandidates(record: MemoryRecord): string[] {
  const base = compactStrings(getRecordSearchableTextParts(record))

  return expandSearchCandidates(base)
}

type SearchableEvent = {
  index: number
  event: TranscriptEvent
  rawText: string
  searchText: string
  lowerSearch: string
}

function buildSearchableEvents(events: TranscriptEvent[]): SearchableEvent[] {
  const searchable: SearchableEvent[] = []

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    const rawText = extractEventText(event)
    if (!rawText) continue
    const trimmed = rawText.trim()
    if (!trimmed) continue
    const normalized = normalizeSearchText(trimmed)
    if (!normalized) continue
    searchable.push({
      index,
      event,
      rawText: trimmed,
      searchText: normalized,
      lowerSearch: normalized.toLowerCase()
    })
  }

  return searchable
}

function extractEventText(event: TranscriptEvent): string | undefined {
  switch (event.type) {
    case 'user':
    case 'assistant':
      return event.text
    case 'tool_call':
      return extractToolInputText(event.input)
    case 'tool_result':
      return event.outputText ?? extractToolInputText(event.metadata ?? event.input)
    default:
      return undefined
  }
}

function buildEventLabel(event: TranscriptEvent): string {
  switch (event.type) {
    case 'user':
      return 'User'
    case 'assistant':
      return 'Assistant'
    case 'tool_call':
      return event.name ? `Tool Call (${event.name})` : 'Tool Call'
    case 'tool_result':
      return event.name ? `Tool Result (${event.name})` : 'Tool Result'
    default:
      return 'Transcript'
  }
}

function extractToolInputText(input: unknown): string | undefined {
  if (!input) return undefined
  if (typeof input === 'string') return input
  if (typeof input !== 'object') return String(input)

  const record = input as Record<string, unknown>
  if (typeof record.command === 'string' && record.command.trim()) return record.command

  return safeJsonStringifyCompact(record)
}

function normalizeSearchText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function buildTranscriptSegment(events: SearchableEvent[], matchIndex: number): string {
  const indices = new Set<number>()
  indices.add(matchIndex)

  const windowStart = Math.max(0, matchIndex - SEGMENT_EVENT_WINDOW)
  const windowEnd = Math.min(events.length - 1, matchIndex + SEGMENT_EVENT_WINDOW)
  for (let i = windowStart; i <= windowEnd; i += 1) {
    indices.add(i)
  }

  const anchor = events[matchIndex]
  const pairedIndex = findPairedEventIndex(events, anchor.event)
  if (pairedIndex !== null) indices.add(pairedIndex)

  const sorted = Array.from(indices).sort((a, b) => a - b)
  const blocks = sorted.map(index => formatSegmentEvent(events[index].event))

  let start = 0
  let end = blocks.length - 1
  let segment = joinBlocks(blocks, start, end)

  while (segment.length > SEGMENT_MAX_CHARS && start < end) {
    const leftDistance = Math.abs(sorted[start] - matchIndex)
    const rightDistance = Math.abs(sorted[end] - matchIndex)
    if (leftDistance >= rightDistance) {
      start += 1
    } else {
      end -= 1
    }
    segment = joinBlocks(blocks, start, end)
  }

  return trimToMax(segment, SEGMENT_MAX_CHARS)
}

function compactStrings(values: Array<string | undefined>): string[] {
  return values
    .map(value => (typeof value === 'string' ? value.trim() : ''))
    .filter(value => value.length > 0)
}

function expandSearchCandidates(values: string[]): string[] {
  const expanded: string[] = []

  for (const value of values) {
    expanded.push(value)

    const firstLine = value.split('\n')[0]?.trim()
    if (firstLine && firstLine !== value) expanded.push(firstLine)

    if (value.length > 160) {
      expanded.push(value.slice(0, 160))
    }
  }

  return Array.from(new Set(expanded))
}

function findPairedEventIndex(events: SearchableEvent[], anchor: TranscriptEvent): number | null {
  if (anchor.type === 'tool_call' && anchor.id) {
    const match = events.findIndex(event =>
      event.event.type === 'tool_result' && event.event.toolUseId === anchor.id
    )
    return match >= 0 ? match : null
  }

  if (anchor.type === 'tool_result' && anchor.toolUseId) {
    const match = events.findIndex(event =>
      event.event.type === 'tool_call' && event.event.id === anchor.toolUseId
    )
    return match >= 0 ? match : null
  }

  return null
}

function formatSegmentEvent(event: TranscriptEvent): string {
  const label = buildEventLabel(event)
  const text = extractEventText(event)
  if (!text) return `[${label}]`
  return `[${label}]\n${text.trim()}`
}

function joinBlocks(blocks: string[], start: number, end: number): string {
  return blocks.slice(start, end + 1).join('\n\n').trim()
}

function trimToMax(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  if (maxLength <= 3) return value.slice(0, maxLength)
  return `${value.slice(0, maxLength - 3)}...`
}

main()
  .then(() => {
    process.exitCode = 0
  })
  .catch(error => {
    console.error('[claude-memory] post-session-worker failed:', error)
    process.exitCode = 2
  })
