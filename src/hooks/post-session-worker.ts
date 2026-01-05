#!/usr/bin/env node
/**
 * Post-session worker - runs extraction in background.
 * Spawned by post-session.ts launcher as a detached process.
 */

import fs, { appendFileSync } from 'fs'
import { homedir } from 'os'
import { initMilvus, incrementRecordCounters } from '../lib/milvus.js'
import { rateInjectedMemories } from '../lib/extract.js'
import { parseTranscript, type Transcript } from '../lib/transcript.js'
import { loadSessionTracking, removeSessionTracking } from '../lib/session-tracking.js'
import { loadConfig } from '../lib/config.js'
import { type Config, type ExtractionHookInput, type HookInput, type InjectedMemoryEntry } from '../lib/types.js'
import { handlePostSession } from './post-session.js'

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
  const config = loadConfig(payload.cwd)
  await initMilvus(config)
  debugLog('Milvus initialized')

  let result: Awaited<ReturnType<typeof handlePostSession>> | null = null
  try {
    debugLog('Running extraction...')
    result = await handlePostSession(payload, config)
    debugLog(`Extraction done: inserted=${result.inserted}, updated=${result.updated}, skipped=${result.skipped}, failed=${result.failed}`)
  } finally {
    debugLog('Running usefulness rating...')
    await processUsefulnessRating(payload, config, result?.transcript)
    debugLog('Usefulness rating done')
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

async function processUsefulnessRating(
  payload: ExtractionHookInput,
  config: Config,
  transcript?: Transcript
): Promise<void> {
  if (payload.hook_event_name !== 'SessionEnd') return

  const session = loadSessionTracking(payload.session_id)
  if (!session || session.memories.length === 0) {
    removeSessionTracking(payload.session_id)
    return
  }

  const memories = dedupeInjectedMemories(session.memories)
  if (memories.length === 0) {
    removeSessionTracking(payload.session_id)
    return
  }

  let shouldRemove = false

  try {
    let resolvedTranscript = transcript
    if (!resolvedTranscript) {
      if (!payload.transcript_path || !fs.existsSync(payload.transcript_path)) {
        console.error('[claude-memory] Transcript missing for usefulness rating; keeping session tracking file.')
        return
      }
      resolvedTranscript = await parseTranscript(payload.transcript_path)
    }

    const helpfulIds = await rateInjectedMemories(resolvedTranscript, memories, config)

    if (helpfulIds.length > 0) {
      // NOTE: Best-effort counters; concurrent sessions can drop increments.
      await Promise.all(helpfulIds.map(id =>
        incrementRecordCounters(id, { usageCount: 1 }, config)
      ))
    }

    shouldRemove = true
  } catch (error) {
    console.error('[claude-memory] Usefulness rating failed:', error)
  } finally {
    if (shouldRemove) {
      removeSessionTracking(payload.session_id)
    }
  }
}

function dedupeInjectedMemories(memories: InjectedMemoryEntry[]): InjectedMemoryEntry[] {
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

main()
  .then(() => {
    process.exitCode = 0
  })
  .catch(error => {
    console.error('[claude-memory] post-session-worker failed:', error)
    process.exitCode = 2
  })
