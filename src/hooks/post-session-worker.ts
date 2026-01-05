#!/usr/bin/env node
/**
 * Post-session worker - runs extraction in background.
 * Spawned by post-session.ts launcher as a detached process.
 */

import fs, { appendFileSync } from 'fs'
import { homedir } from 'os'
import { randomUUID } from 'crypto'
import { flushCollection, initMilvus, incrementRecordCounters } from '../lib/milvus.js'
import { rateInjectedMemories } from '../lib/extract.js'
import { parseTranscript, type Transcript, type TranscriptEvent } from '../lib/transcript.js'
import { dedupeInjectedMemories, loadSessionTracking, removeSessionTracking } from '../lib/session-tracking.js'
import { loadConfig } from '../lib/config.js'
import { saveExtractionRun } from '../lib/extraction-log.js'
import { type Config, type ExtractionHookInput, type HookInput, type InjectedMemoryEntry, type MemoryRecord } from '../lib/types.js'
import { handlePostSession } from './post-session.js'
import { findGitRoot } from '../lib/context.js'

const DEBUG = process.env.CLAUDE_MEMORY_DEBUG === '1'
const DEBUG_LOG_FILE = `${homedir()}/.claude-memory/debug.log`
const workerStartTime = Date.now()

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

  // Skip extraction if session was cleared
  if (payload.hook_event_name === 'SessionEnd' && payload.reason === 'clear') {
    debugLog('Skipping: reason=clear')
    console.error('[claude-memory] SessionEnd reason=clear; skipping extraction.')
    removeSessionTracking(payload.session_id)
    return
  }

  if (!payload.transcript_path) {
    debugLog('Skipping: no transcript_path')
    console.warn('[claude-memory] Transcript not found; skipping extraction. path=missing')
    if (payload.hook_event_name === 'SessionEnd') {
      removeSessionTracking(payload.session_id)
    }
    return
  }

  debugLog('Initializing Milvus...')
  const configRoot = findGitRoot(payload.cwd) ?? payload.cwd
  const config = loadConfig(configRoot)
  await initMilvus(config)
  debugLog('Milvus initialized')

  let result: Awaited<ReturnType<typeof handlePostSession>> | null = null
  let shouldFlush = false
  const extractionStart = Date.now()
  let extractionDuration = 0
  try {
    debugLog('Running extraction...')
    result = await handlePostSession(payload, config, {
      flush: 'end-of-batch',
      recordAugmenter: (record, transcript) => ({
        ...record,
        sourceSessionId: payload.session_id,
        sourceExcerpt: buildSourceExcerpt(record, transcript)
      })
    })
    debugLog(`Extraction done: inserted=${result.inserted}, updated=${result.updated}, skipped=${result.skipped}, failed=${result.failed}`)
    shouldFlush = (result.inserted + result.updated) > 0
    extractionDuration = Date.now() - extractionStart
    saveRunLog(payload, result, extractionDuration)
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
}

function saveRunLog(
  payload: ExtractionHookInput,
  result: Awaited<ReturnType<typeof handlePostSession>>,
  duration: number
): void {
  if (result.reason === 'no_transcript' || result.reason === 'clear' || result.reason === 'wrong_event') return

  const extractedIds = [...(result.insertedIds ?? []), ...(result.updatedIds ?? [])]
  const uniqueIds = Array.from(new Set(extractedIds))
  const runId = randomUUID()

  saveExtractionRun({
    runId,
    sessionId: payload.session_id,
    transcriptPath: payload.transcript_path,
    timestamp: Date.now(),
    recordCount: uniqueIds.length,
    parseErrorCount: result.transcript?.parseErrors ?? 0,
    extractedRecordIds: uniqueIds,
    duration
  })
}

async function processUsefulnessRating(
  payload: ExtractionHookInput,
  config: Config,
  transcript?: Transcript
): Promise<boolean> {
  if (payload.hook_event_name !== 'SessionEnd') return false

  const session = loadSessionTracking(payload.session_id)
  if (!session || session.memories.length === 0) {
    removeSessionTracking(payload.session_id)
    return false
  }

  const memories = session.memories
  if (memories.length === 0) {
    removeSessionTracking(payload.session_id)
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
    removeSessionTracking(payload.session_id)
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
      removeSessionTracking(payload.session_id)
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

const EXCERPT_MAX_CHARS = 240

function buildSourceExcerpt(record: MemoryRecord, transcript: Transcript): string | undefined {
  const candidates = buildExcerptCandidates(record)
  if (candidates.length === 0) return undefined

  const events = buildSearchableEvents(transcript.events)
  if (events.length === 0) return undefined

  for (const candidate of candidates) {
    const normalizedCandidate = normalizeExcerptText(candidate)
    if (!normalizedCandidate) continue
    const lowerCandidate = normalizedCandidate.toLowerCase()

    for (const event of events) {
      const directIndex = event.text.indexOf(normalizedCandidate)
      const index = directIndex >= 0 ? directIndex : event.lower.indexOf(lowerCandidate)
      if (index < 0) continue
      return formatExcerpt(event.label, event.text, index, normalizedCandidate.length)
    }
  }

  return undefined
}

function buildExcerptCandidates(record: MemoryRecord): string[] {
  switch (record.type) {
    case 'command':
      return compactStrings([record.command, record.truncatedOutput, record.resolution])
    case 'error':
      return compactStrings([record.errorText, record.resolution, record.cause])
    case 'discovery':
      return compactStrings([record.what, record.evidence, record.where])
    case 'procedure':
      return compactStrings([record.name, ...record.steps, record.verification, ...(record.prerequisites ?? [])])
    default:
      return []
  }
}

function buildSearchableEvents(events: TranscriptEvent[]): Array<{ label: string; text: string; lower: string }> {
  const searchable: Array<{ label: string; text: string; lower: string }> = []

  for (const event of events) {
    const rawText = extractEventText(event)
    if (!rawText) continue
    const normalized = normalizeExcerptText(rawText)
    if (!normalized) continue
    const label = buildEventLabel(event)
    searchable.push({ label, text: normalized, lower: normalized.toLowerCase() })
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

  return safeJsonStringify(record)
}

function safeJsonStringify(value: unknown): string | undefined {
  try {
    const serialized = JSON.stringify(value)
    return serialized && serialized !== '{}' ? serialized : undefined
  } catch {
    return undefined
  }
}

function normalizeExcerptText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function formatExcerpt(label: string, text: string, matchIndex: number, matchLength: number): string {
  const maxContext = Math.max(EXCERPT_MAX_CHARS - label.length - 2, matchLength)
  const start = Math.max(0, Math.min(matchIndex - Math.floor((maxContext - matchLength) / 2), text.length))
  const end = Math.min(text.length, start + maxContext)
  let excerpt = text.slice(start, end).trim()
  if (start > 0) excerpt = `...${excerpt}`
  if (end < text.length) excerpt = `${excerpt}...`
  return `${label}: ${excerpt}`
}

function compactStrings(values: Array<string | undefined>): string[] {
  return values
    .map(value => (typeof value === 'string' ? value.trim() : ''))
    .filter(value => value.length > 0)
}

main()
  .then(() => {
    process.exitCode = 0
  })
  .catch(error => {
    console.error('[claude-memory] post-session-worker failed:', error)
    process.exitCode = 2
  })
