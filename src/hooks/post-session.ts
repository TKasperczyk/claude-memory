#!/usr/bin/env node
/**
 * Post-session hook launcher - spawns worker as detached process for fast exit.
 *
 * This file also exports the core logic for testing.
 */

import fs, { appendFileSync } from 'fs'
import { spawn } from 'child_process'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { homedir } from 'os'
import { randomUUID } from 'crypto'
import { extractRecords } from '../lib/extract.js'
import { REMEMBER_MARKER } from '../lib/claude-commands.js'
import { findGitRoot } from '../lib/context.js'
import { embedBatch } from '../lib/embed.js'
import { buildEmbeddingInput, findSimilar, insertRecord, updateRecord, type FlushMode } from '../lib/lancedb.js'
import { loadSettings } from '../lib/settings.js'
import { parseTranscript, computeIncrementalStartIndex, sliceTranscript, type Transcript } from '../lib/transcript.js'
import {
  DEFAULT_CONFIG,
  type Config,
  type MemoryRecord,
  type ExtractionHookInput,
  type InjectedMemoryEntry,
  type TokenUsage
} from '../lib/types.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export interface PostSessionResult {
  inserted: number
  updated: number
  skipped: number
  failed: number
  records: MemoryRecord[]
  insertedIds: string[]
  updatedIds: string[]
  transcript?: Transcript
  reason?: 'clear' | 'no_transcript' | 'no_records' | 'too_short' | 'no_new_events' | 'wrong_event'
  tokenUsage?: TokenUsage
  extractedEventCount?: number
  isIncremental?: boolean
  hasRememberMarker?: boolean
}

/**
 * Core post-session hook logic. Exported for testing.
 *
 * Extracts records from transcript and stores them in LanceDB.
 */
export async function handlePostSession(
  input: ExtractionHookInput,
  config: Config = DEFAULT_CONFIG,
  options: {
    flush?: FlushMode
    recordAugmenter?: (record: MemoryRecord, transcript: Transcript) => MemoryRecord
    /** Memories injected during this session - used for change detection */
    injectedMemories?: InjectedMemoryEntry[]
    /** Event count from a prior extraction of this session -- enables incremental mode */
    previousExtractionEventCount?: number
    /** How many user turns to overlap for context (default: from settings) */
    contextOverlapTurns?: number
  } = {}
): Promise<PostSessionResult> {
  // Accept both SessionEnd and PreCompact events
  if (input.hook_event_name !== 'SessionEnd' && input.hook_event_name !== 'PreCompact') {
    return {
      inserted: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      records: [],
      insertedIds: [],
      updatedIds: [],
      reason: 'wrong_event'
    }
  }

  // Skip extraction if session was cleared (only applies to SessionEnd)
  if (input.hook_event_name === 'SessionEnd' && input.reason === 'clear') {
    return {
      inserted: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      records: [],
      insertedIds: [],
      updatedIds: [],
      reason: 'clear'
    }
  }

  if (!input.transcript_path || !fs.existsSync(input.transcript_path)) {
    return {
      inserted: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      records: [],
      insertedIds: [],
      updatedIds: [],
      reason: 'no_transcript'
    }
  }

  const fullTranscript = await parseTranscript(input.transcript_path)
  if (fullTranscript.parseErrors > 0) {
    console.error(`[claude-memory] Transcript parse warnings: ${fullTranscript.parseErrors}`)
  }

  const totalEventCount = fullTranscript.events.length
  const settings = loadSettings()

  // Incremental extraction: skip if no new events since last extraction
  const priorEventCount = options.previousExtractionEventCount
  let isIncremental = false
  let extractionTranscript = fullTranscript

  if (priorEventCount !== undefined && priorEventCount > 0) {
    if (totalEventCount <= priorEventCount) {
      return {
        inserted: 0,
        updated: 0,
        skipped: 0,
        failed: 0,
        records: [],
        insertedIds: [],
        updatedIds: [],
        reason: 'no_new_events',
        transcript: fullTranscript,
        extractedEventCount: totalEventCount
      }
    }

    const overlapTurns = options.contextOverlapTurns ?? settings.extractionContextOverlapTurns
    const startIndex = computeIncrementalStartIndex(fullTranscript.events, priorEventCount, overlapTurns)
    extractionTranscript = sliceTranscript(fullTranscript, startIndex)
    isIncremental = true
    console.error(
      `[claude-memory] Incremental extraction: ${totalEventCount - priorEventCount} new events, ` +
      `starting from event ${startIndex} (${overlapTurns}-turn overlap)`
    )
  }

  // Use extraction transcript for min-length check so we skip if only overlap, no real new content
  const transcript = extractionTranscript

  // Check for remember marker in the raw file -- the parsed transcript strips isMeta entries
  const rawTranscript = fs.readFileSync(input.transcript_path, 'utf-8')
  const hasRememberMarker = rawTranscript.includes(REMEMBER_MARKER)

  // Skip extraction for very short conversations (~4 chars per token)
  // unless user explicitly flagged content with /remember
  if (!hasRememberMarker) {
    const minChars = settings.extractionMinTokens * 4
    if (minChars > 0) {
      const conversationChars = transcript.messages.reduce((sum, m) => sum + m.text.length, 0)
      if (conversationChars < minChars) {
        return {
          inserted: 0,
          updated: 0,
          skipped: 0,
          failed: 0,
          records: [],
          insertedIds: [],
          updatedIds: [],
          reason: 'too_short',
          transcript: fullTranscript
        }
      }
    }
  }

  const projectRoot = findGitRoot(input.cwd) ?? input.cwd
  const { records: extractedRecords, tokenUsage } = await extractRecords(transcript, {
    sessionId: input.session_id,
    cwd: input.cwd,
    project: projectRoot,
    transcriptPath: input.transcript_path,
    injectedMemories: options.injectedMemories,
    isIncremental,
    maxTranscriptChars: settings.maxTranscriptChars
  }, config)

  // Use fullTranscript for recordAugmenter (e.g. sourceExcerpt matching) -- it has more context
  const records = options.recordAugmenter
    ? extractedRecords.map(record => options.recordAugmenter!(record, fullTranscript))
    : extractedRecords

  if (records.length === 0) {
    return {
      inserted: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      records: [],
      insertedIds: [],
      updatedIds: [],
      reason: 'no_records',
      transcript: fullTranscript,
      extractedEventCount: totalEventCount,
      isIncremental: isIncremental || undefined,
      hasRememberMarker: hasRememberMarker || undefined,
      tokenUsage
    }
  }

  await precomputeEmbeddings(records, config)

  let inserted = 0
  let updated = 0
  let skipped = 0
  let failed = 0
  const insertedIds: string[] = []
  const updatedIds: string[] = []

  const flushMode = options.flush ?? 'always'

  for (const record of records) {
    try {
      const matches = await findSimilar(record, settings.extractionDedupThreshold, 1, config)
      if (matches.length > 0) {
        const existing = matches[0].record
        const updates = buildUpdates(existing, record)
        if (Object.keys(updates).length > 0) {
          await updateRecord(existing.id, updates, config, { flush: flushMode })
          updated += 1
          updatedIds.push(existing.id)
        } else {
          skipped += 1
        }
        continue
      }

      const prepared = applyUsageCounters(record)
      await insertRecord(prepared, config, { flush: flushMode })
      inserted += 1
      insertedIds.push(prepared.id)
    } catch (error) {
      failed += 1
      console.error(`[claude-memory] Failed to store record ${record.id ?? record.type}:`, error)
    }
  }

  return {
    inserted, updated, skipped, failed, records, insertedIds, updatedIds,
    transcript: fullTranscript, tokenUsage,
    extractedEventCount: totalEventCount,
    isIncremental: isIncremental || undefined,
    hasRememberMarker: hasRememberMarker || undefined
  }
}

async function precomputeEmbeddings(records: MemoryRecord[], config: Config): Promise<void> {
  const inputs: string[] = []
  const targets: MemoryRecord[] = []

  for (const record of records) {
    if (record.embedding && record.embedding.length > 0) continue
    inputs.push(buildEmbeddingInput(record))
    targets.push(record)
  }

  if (inputs.length === 0) return

  try {
    const embeddings = await embedBatch(inputs, config)
    if (embeddings.length !== targets.length) {
      throw new Error(`Embedding batch size mismatch: expected ${targets.length}, got ${embeddings.length}`)
    }
    embeddings.forEach((embedding, index) => {
      targets[index].embedding = embedding
    })
  } catch (error) {
    console.error('[claude-memory] Failed to precompute embeddings:', error)
  }
}

export function buildUpdates(existing: MemoryRecord, incoming: MemoryRecord): Partial<MemoryRecord> {
  const updates: Partial<MemoryRecord> = {}

  const { successDelta, failureDelta } = deriveUsageDelta(incoming)
  if (successDelta !== 0) {
    updates.successCount = (existing.successCount ?? 0) + successDelta
  }
  if (failureDelta !== 0) {
    updates.failureCount = (existing.failureCount ?? 0) + failureDelta
  }

  if (incoming.scope === 'global' && existing.scope !== 'global') {
    updates.scope = 'global'
  }

  if (!existing.project && incoming.project) updates.project = incoming.project
  if (!existing.sourceSessionId && incoming.sourceSessionId) updates.sourceSessionId = incoming.sourceSessionId
  if (!existing.sourceExcerpt && incoming.sourceExcerpt) updates.sourceExcerpt = incoming.sourceExcerpt

  if (existing.type === 'command' && incoming.type === 'command') {
    const commandUpdates = updates as Partial<typeof existing>
    const contextUpdates: Partial<typeof existing.context> = {}
    if (incoming.context.project) contextUpdates.project = incoming.context.project
    if (incoming.context.cwd) contextUpdates.cwd = incoming.context.cwd
    if (incoming.context.intent) contextUpdates.intent = incoming.context.intent
    if (Object.keys(contextUpdates).length > 0) {
      commandUpdates.context = { ...existing.context, ...contextUpdates }
    }
    if (!existing.truncatedOutput && incoming.truncatedOutput) commandUpdates.truncatedOutput = incoming.truncatedOutput
    if (!existing.resolution && incoming.resolution) commandUpdates.resolution = incoming.resolution
  }

  if (existing.type === 'error' && incoming.type === 'error') {
    const errorUpdates = updates as Partial<typeof existing>
    const contextUpdates: Partial<typeof existing.context> = {}
    if (incoming.context.file) contextUpdates.file = incoming.context.file
    if (incoming.context.tool) contextUpdates.tool = incoming.context.tool
    if (Object.keys(contextUpdates).length > 0) {
      errorUpdates.context = { ...existing.context, ...contextUpdates }
    }
    if (!existing.cause && incoming.cause) errorUpdates.cause = incoming.cause
  }

  if (existing.type === 'procedure' && incoming.type === 'procedure') {
    const procedureUpdates = updates as Partial<typeof existing>
    const contextUpdates: Partial<typeof existing.context> = {}
    if (incoming.context.project) contextUpdates.project = incoming.context.project
    if (Object.keys(contextUpdates).length > 0) {
      procedureUpdates.context = { ...existing.context, ...contextUpdates }
    }
    if (!existing.verification && incoming.verification) procedureUpdates.verification = incoming.verification
    if (!existing.prerequisites && incoming.prerequisites) procedureUpdates.prerequisites = incoming.prerequisites
  }

  if (existing.type === 'discovery' && incoming.type === 'discovery') {
    const discoveryUpdates = updates as Partial<typeof existing>
    if (!existing.where && incoming.where) discoveryUpdates.where = incoming.where
    if (!existing.evidence && incoming.evidence) discoveryUpdates.evidence = incoming.evidence
  }

  if (Object.keys(updates).length > 0) {
    updates.lastUsed = Date.now()
  }

  return updates
}

export function applyUsageCounters(record: MemoryRecord): MemoryRecord {
  const { successDelta, failureDelta } = deriveUsageDelta(record)
  return {
    ...record,
    successCount: (record.successCount ?? 0) + successDelta,
    failureCount: (record.failureCount ?? 0) + failureDelta,
    lastUsed: Date.now()
  }
}

export function deriveUsageDelta(record: MemoryRecord): { successDelta: number; failureDelta: number } {
  if (record.type === 'command') {
    if (record.outcome === 'success') return { successDelta: 1, failureDelta: 0 }
    if (record.outcome === 'failure') return { successDelta: 0, failureDelta: 1 }
    return { successDelta: 0, failureDelta: 1 }
  }

  if (record.type === 'error') {
    return { successDelta: 0, failureDelta: 1 }
  }

  return { successDelta: 0, failureDelta: 0 }
}

const DEBUG = process.env.CLAUDE_MEMORY_DEBUG === '1'
const DEBUG_LOG_FILE = `${homedir()}/.claude-memory/debug.log`

function debugLog(msg: string): void {
  if (!DEBUG) return
  const ts = new Date().toISOString()
  const line = `[launcher] ${ts} ${msg}\n`
  console.error(line.trim())
  try {
    appendFileSync(DEBUG_LOG_FILE, line)
  } catch {
    // ignore
  }
}

/**
 * Launcher main - spawns worker as detached process and exits immediately.
 *
 * Writes stdin to a temp file and passes the path to the worker.
 * This completely decouples the launcher from data transfer so Claude Code
 * doesn't wait for the stdin fd to close.
 */
function launcherMain(): void {
  const startTime = Date.now()
  debugLog(`START pid=${process.pid}`)

  // Read stdin synchronously (it's small, ~300 bytes)
  let input = ''
  const BUFSIZE = 1024
  const buf = Buffer.alloc(BUFSIZE)
  let bytesRead: number

  try {
    while ((bytesRead = fs.readSync(0, buf, 0, BUFSIZE, null)) > 0) {
      input += buf.toString('utf8', 0, bytesRead)
    }
  } catch (e: unknown) {
    // EOF or error - that's fine
    if ((e as NodeJS.ErrnoException).code !== 'EOF' && (e as NodeJS.ErrnoException).code !== 'EAGAIN') {
      debugLog(`stdin read error: ${e}`)
    }
  }

  debugLog(`Read stdin: ${input.length} bytes in ${Date.now() - startTime}ms`)

  if (!input.trim()) {
    debugLog('Empty input, exiting')
    return
  }

  // Write to temp file
  const tempFile = join(homedir(), '.claude-memory', `hook-input-${process.pid}-${Date.now()}-${randomUUID()}.json`)
  try {
    fs.mkdirSync(dirname(tempFile), { recursive: true })
    fs.writeFileSync(tempFile, input, { flag: 'wx' })
    debugLog(`Wrote temp file: ${tempFile}`)
  } catch (e) {
    debugLog(`Failed to write temp file: ${e}`)
    return
  }

  const cleanupTempFile = (): void => {
    try {
      fs.unlinkSync(tempFile)
      debugLog(`Cleaned up temp file after spawn failure: ${tempFile}`)
    } catch {
      // ignore
    }
  }

  // Determine worker path
  const workerPath = __filename.endsWith('.ts')
    ? join(__dirname, 'post-session-worker.ts')
    : join(__dirname, 'post-session-worker.js')
  const usesTsWorker = workerPath.endsWith('.ts')

  debugLog(`Spawning worker: ${workerPath}`)

  // Spawn worker with temp file path as argument
  // ALL stdio must be 'ignore' - any inherited fd keeps Claude Code waiting
  const command = usesTsWorker ? 'npx' : 'node'
  const args = usesTsWorker ? ['tsx', workerPath, tempFile] : [workerPath, tempFile]
  const child = spawn(command, args, {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore']
  })

  child.on('error', error => {
    debugLog(`Worker spawn failed: ${error}`)
    console.error('[claude-memory] Failed to spawn post-session worker:', error)
    cleanupTempFile()
    process.exitCode = 2
  })

  debugLog(`Worker spawned pid=${child.pid}, took ${Date.now() - startTime}ms`)

  child.unref()

  debugLog(`EXIT after ${Date.now() - startTime}ms`)
}

// Only run launcher when executed directly (not imported)
const entryPath = process.argv[1] ? resolve(process.argv[1]) : ''
const isMainModule = fileURLToPath(import.meta.url) === entryPath
if (isMainModule) {
  try {
    launcherMain()
    process.exitCode = 0
  } catch (error) {
    console.error('[claude-memory] post-session launcher failed:', error)
    process.exitCode = 2
  }
}
