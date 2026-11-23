#!/usr/bin/env node
/**
 * Post-session worker - runs extraction in background.
 * Spawned by post-session.ts launcher as a detached process.
 */

import fs, { appendFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { basename, dirname, join } from 'path'
import { isProcessEntrypoint, sanitizeSessionId } from '../lib/shared.js'
import { batchUpdateRecords, closeLanceDB, fetchRecordsByIds, flushCollection, initLanceDB } from '../lib/lancedb.js'
import { rateInjectedMemories, sanitizeExtractionFailure } from '../lib/extract.js'
import { fileContainsMarker, parseTranscript, type Transcript, type TranscriptEvent, getFirstUserPrompt } from '../lib/transcript.js'
import {
  cleanupStaleSessions,
  dedupeInjectedMemories,
  loadSessionTracking,
  markSessionMemoriesRated,
  markSessionRetrievalCounted,
  removeSessionTracking,
  resetSessionInjectionLedger
} from '../lib/session-tracking.js'
import { sweepIdleSessions } from '../lib/idle-session-sweep.js'
import { loadConfig } from '../lib/config.js'
import { buildExtractionRecordSummaries, getLastExtractionRunForSession, saveExtractionRun } from '../lib/extraction-log.js'
import { runAllMaintenance } from '../lib/maintenance-api.js'
import { buildMaintenanceRun, getLastMaintenanceRun, saveMaintenanceRun } from '../lib/maintenance-log.js'
import { buildMemoryStats } from '../lib/memory-stats.js'
import { loadSettings } from '../lib/settings.js'
import { hasStatsSnapshot, saveStatsSnapshotIfNeeded } from '../lib/stats-snapshots.js'
import { type Config, type ExtractionFailure, type ExtractionHookInput, type HookInput, type InjectedMemoryEntry, type MemoryRecord, type MemoryWriteHintEvent, type TokenUsage } from '../lib/types.js'
import { safeJsonStringifyCompact } from '../lib/json.js'
import { getRecordSearchableTextParts } from '../lib/record-fields.js'
import { acquireFileLock } from '../lib/lock.js'
import { handlePostSession } from './post-session.js'
import { findGitRoot } from '../lib/context.js'
import { SKIP_EXTRACTION_MARKER } from '../lib/claude-commands.js'
import { addTokenUsage, emptyTokenUsage, hasTokenUsage } from '../lib/token-usage.js'
import { canonicalizePath, CLAUDE_MEMORY_ROOT, DEBUG_LOG_FILE, LOCKS_DIR } from '../lib/paths.js'
import { formatExtractionFailureSummary, isExtractionRunFailure } from '../lib/extraction-status.js'
import { formatStageTimings } from '../lib/extraction-timings.js'
import { runSelfUpdate } from '../lib/self-update.js'
import { runPendingMigrations } from '../lib/data-migrations.js'
import {
  cleanupMemoryWriteHints,
  deleteMemoryWriteHints,
  loadMemoryWriteHints,
  MEMORY_WRITE_HINT_RETENTION_DAYS
} from '../lib/memory-write-hints.js'

function auditErrorSuffix(failure?: ExtractionFailure): string {
  if (!failure) return ''
  const parts = [`error=${formatExtractionFailureSummary(failure)}`]
  if (failure.kind === 'api_error') {
    if (failure.requestId) parts.push(`request_id=${failure.requestId}`)
  }
  return ` ${parts.join(' ')}`
}

const DEBUG = process.env.CLAUDE_MEMORY_DEBUG === '1'
const AUDIT_LOG_FILE = join(CLAUDE_MEMORY_ROOT, 'extraction-audit.log')
const LOCK_STALE_MS = 5 * 60 * 1000
const LOG_MAX_BYTES = 5 * 1024 * 1024
const LOG_KEEP_BYTES = 2 * 1024 * 1024
const workerStartTime = Date.now()
let logsTrimmed = false
let debugSessionId: string | undefined

type WorkerResult = Awaited<ReturnType<typeof handlePostSession>>
type NoRunSaveReason = Extract<NonNullable<WorkerResult['reason']>, 'clear' | 'no_transcript' | 'wrong_event' | 'no_new_events'>

const NO_RUN_SAVE_REASONS = new Set<NoRunSaveReason>(['clear', 'no_transcript', 'wrong_event', 'no_new_events'])
const WORKER_EXTRA_TIMING_STAGES = ['usefulness'] as const

function sanitizeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.split('\n')[0].slice(0, 200)
}

function quoteLogValue(value: string): string {
  return JSON.stringify(value)
}

function shortSessionId(sessionId: string | undefined): string {
  if (!sessionId) return '?'
  return sessionId.length <= 8 ? sessionId : sessionId.slice(0, 8)
}

export function trimLogFile(filePath: string): void {
  try {
    if (!fs.existsSync(filePath)) return
    const initialStat = fs.statSync(filePath)
    if (initialStat.size <= LOG_MAX_BYTES) return

    const lockHandle = acquireFileLock(join(LOCKS_DIR, 'log-trim.lock'), {
      staleAfterMs: 30_000,
      staleStrategy: 'pid',
      ensureDir: true,
      proceedOnError: false,
      write: { data: () => `${process.pid}\n${Date.now()}` }
    })
    if (!lockHandle) return

    try {
      if (!fs.existsSync(filePath)) return
      const stat = fs.statSync(filePath)
      if (stat.size <= LOG_MAX_BYTES) return

      const bytesToRead = Math.min(LOG_KEEP_BYTES, stat.size)
      const buffer = Buffer.alloc(bytesToRead)
      const fd = fs.openSync(filePath, 'r')
      let bytesRead = 0
      try {
        bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, stat.size - bytesToRead)
      } finally {
        fs.closeSync(fd)
      }
      if (bytesRead <= 0) return

      const readBuffer = buffer.subarray(0, bytesRead)
      const firstNewline = readBuffer.indexOf(0x0a)
      const tail = firstNewline >= 0 ? readBuffer.subarray(firstNewline + 1) : readBuffer

      const tmpPath = join(
        dirname(filePath),
        `.${basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
      )
      try {
        fs.writeFileSync(tmpPath, tail, { flag: 'wx' })
        fs.renameSync(tmpPath, filePath)
      } catch (error) {
        try {
          if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath)
        } catch {
          // ignore cleanup failure
        }
        throw error
      }
    } finally {
      lockHandle.release()
    }
  } catch {
    // ignore retention failures; logging must never block extraction
  }
}

export function trimLogsOnce(): void {
  if (logsTrimmed) return
  logsTrimmed = true
  trimLogFile(DEBUG_LOG_FILE)
  trimLogFile(AUDIT_LOG_FILE)
}

const MAX_PENDING_HANDOFF_ITERATIONS = 5

function getPendingPayloadPath(sessionId: string): string {
  return join(LOCKS_DIR, `${sanitizeSessionId(sessionId)}.pending.json`)
}

/**
 * Queue an incoming extraction hook payload when another worker already holds
 * the session lock (e.g., SessionEnd arriving while PreCompact is still running).
 * SessionEnd always takes precedence over PreCompact so final extraction & cleanup
 * are never lost.
 */
export function enqueuePendingPayload(sessionId: string, payload: ExtractionHookInput): boolean {
  const pendingPath = getPendingPayloadPath(sessionId)
  try {
    fs.mkdirSync(LOCKS_DIR, { recursive: true })
    if (payload.hook_event_name === 'PreCompact' && fs.existsSync(pendingPath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(pendingPath, 'utf-8')) as Partial<ExtractionHookInput>
        if (existing.hook_event_name === 'SessionEnd') {
          return true
        }
      } catch {
        // Overwrite corrupt pending file.
      }
    }
    const tmpPath = `${pendingPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
    fs.writeFileSync(tmpPath, JSON.stringify(payload), { encoding: 'utf-8', flag: 'wx' })
    fs.renameSync(tmpPath, pendingPath)
    return true
  } catch (error) {
    console.error('[claude-memory] Failed to enqueue pending session payload:', error)
    return false
  }
}

export function consumePendingPayload(sessionId: string): ExtractionHookInput | null {
  const pendingPath = getPendingPayloadPath(sessionId)
  if (!fs.existsSync(pendingPath)) return null
  const claimPath = `${pendingPath}.claim.${process.pid}.${Date.now()}`
  try {
    fs.renameSync(pendingPath, claimPath)
  } catch {
    return null
  }
  try {
    const raw = fs.readFileSync(claimPath, 'utf-8')
    const parsed = JSON.parse(raw) as ExtractionHookInput
    if (parsed && (parsed.hook_event_name === 'SessionEnd' || parsed.hook_event_name === 'PreCompact')) {
      return parsed
    }
    return null
  } catch {
    return null
  } finally {
    try {
      fs.unlinkSync(claimPath)
    } catch {
      // ignore
    }
  }
}

function acquireWorkerLock(sessionId: string): ReturnType<typeof acquireFileLock> {
  const lockFile = `${LOCKS_DIR}/${sanitizeSessionId(sessionId)}.lock`
  return acquireFileLock(lockFile, {
    staleAfterMs: LOCK_STALE_MS,
    staleStrategy: 'pid',
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
  const line = `[worker pid=${process.pid} session=${shortSessionId(debugSessionId)}] ${ts} +${elapsed}ms ${msg}\n`
  console.error(line.trim())
}

/** Always-on audit log for debugging extraction issues */
function auditLog(msg: string): void {
  trimLogsOnce()
  const ts = new Date().toISOString()
  const line = `${ts} [pid=${process.pid}] ${msg}\n`
  try {
    appendFileSync(AUDIT_LOG_FILE, line)
  } catch {
    // ignore
  }
}

function shouldPersistRunForResult(result: WorkerResult | null): boolean {
  if (!result) return true
  return !result.reason || !NO_RUN_SAVE_REASONS.has(result.reason as NoRunSaveReason)
}

function deleteMemoryWriteHintsSafely(sessionId: string): void {
  try {
    deleteMemoryWriteHints(sessionId)
  } catch (error) {
    console.error('[claude-memory] Failed to delete memory_write hints:', error)
  }
}

export function shouldDeleteMemoryWriteHints(
  payload: ExtractionHookInput,
  result: WorkerResult,
  runSaved: boolean
): boolean {
  if (payload.hook_event_name !== 'SessionEnd') return false
  if (result.reason === 'no_transcript' || result.reason === 'wrong_event') return false
  if (result.extractionError || result.failed > 0) return false
  if (result.reason === 'no_new_events') return true
  return runSaved
}

function memoryWriteHintIdentity(hint: MemoryWriteHintEvent): string {
  return hint.toolUseId
    ? `tool-use:${hint.toolUseId}`
    : `timestamp-name:${hint.timestamp}:${hint.name}`
}

export function getUsefulnessRunId(result: WorkerResult | null, plannedRunId: string): string | undefined {
  return shouldPersistRunForResult(result) ? plannedRunId : undefined
}

function auditDiagnostics(
  payload: ExtractionHookInput,
  runId: string,
  diagnostics: Awaited<ReturnType<typeof handlePostSession>>['diagnostics']
): void {
  if (!diagnostics || diagnostics.length === 0) return
  for (const diagnostic of diagnostics) {
    if (diagnostic.level !== 'warn') continue
    const records = typeof diagnostic.records === 'number' ? ` records=${diagnostic.records}` : ''
    auditLog(`WARN session=${payload.session_id} runId=${runId} stage=${diagnostic.stage}${records} cause=${quoteLogValue(diagnostic.cause)}`)
  }
}

export function saveCrashRun(
  payload: ExtractionHookInput,
  runId: string,
  duration: number,
  error: unknown,
  collection?: string
): void {
  const extractionError = sanitizeExtractionFailure({
    kind: 'internal_error',
    message: sanitizeErrorMessage(error)
  })
  if (!extractionError) return

  saveExtractionRun({
    runId,
    sessionId: payload.session_id,
    transcriptPath: payload.transcript_path ?? '',
    timestamp: Date.now(),
    recordCount: 0,
    parseErrorCount: 0,
    extractedRecordIds: [],
    duration,
    error: extractionError
  }, collection)

  auditLog(`FAILED session=${payload.session_id} runId=${runId} inserted=0 updated=0 skipped=0 failed=0 supersedesMissing=0 duration=${duration}ms events=?${auditErrorSuffix(extractionError)}`)
}

export function handleWorkerCrash(
  payload: ExtractionHookInput,
  runId: string,
  duration: number,
  error: unknown,
  collection: string | undefined,
  runPersisted: boolean
): void {
  if (runPersisted) {
    auditLog(`WARN session=${payload.session_id} runId=${runId} stage=post_save cause=${quoteLogValue(sanitizeErrorMessage(error))}`)
  } else {
    saveCrashRun(payload, runId, duration, error, collection)
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

async function maybeRunAutoMaintenance(config: Config): Promise<void> {
  const settings = loadSettings()
  const intervalHours = settings.autoMaintenanceIntervalHours
  if (!intervalHours || intervalHours <= 0) return

  // Check timing BEFORE acquiring lock (cheap read, fast path).
  // Ignore dry-run previews and single-operation runs so they never starve auto-maintenance.
  const autoRunFilter = { excludeDryRun: true, fullOnly: true }
  const lastRun = getLastMaintenanceRun(config.lancedb.table, autoRunFilter)
  const intervalMs = intervalHours * 60 * 60 * 1000
  if (Date.now() - (lastRun?.timestamp ?? 0) < intervalMs) return

  // Acquire exclusive lock — if another worker is already running maintenance, skip
  const lockFile = `${LOCKS_DIR}/auto-maintenance.lock`
  const lockHandle = acquireFileLock(lockFile, {
    staleAfterMs: 10 * 60 * 1000, // 10 min stale
    staleStrategy: 'pid',
    ensureDir: true,
    proceedOnError: false,
    write: { data: () => `${process.pid}\n${Date.now()}` }
  })
  if (!lockHandle) return

  try {
    // Re-check after lock (double-check pattern — another worker may have just finished)
    const freshLastRun = getLastMaintenanceRun(config.lancedb.table, autoRunFilter)
    if (Date.now() - (freshLastRun?.timestamp ?? 0) < intervalMs) return

    debugLog('Starting auto-maintenance')
    const results = await runAllMaintenance(false, config)
    const run = buildMaintenanceRun(results, {
      dryRun: false,
      trigger: 'auto',
      operations: results.map(result => result.operation)
    })
    saveMaintenanceRun(run, config.lancedb.table)
    if (settings.idleSessionSweepHours > 0) {
      try {
        const sweep = await sweepIdleSessions(config, {
          idleHours: settings.idleSessionSweepHours,
          onRecoverSession: async (syntheticPayload) => {
            await processSingleSessionPayload(syntheticPayload, config, config.lancedb.table, randomUUID(), Date.now())
          }
        })
        if (sweep.recovered > 0 || sweep.cleanedWithoutTranscript > 0) {
          debugLog(`Idle session sweep: recovered=${sweep.recovered}, cleaned=${sweep.cleanedWithoutTranscript}, errors=${sweep.errors}`)
        }
      } catch (error) {
        console.error('[claude-memory] Idle session sweep failed:', error)
      }
    }
    if (typeof cleanupStaleSessions === 'function') {
      cleanupStaleSessions(config.lancedb.table)
    }
    debugLog(`Auto-maintenance complete: ${run.summary.totalActions} actions`)
  } finally {
    lockHandle.release()
  }
}

async function maybeCaptureStatsSnapshot(config: Config): Promise<void> {
  const collection = config.lancedb.table
  if (hasStatsSnapshot(Date.now(), collection)) return

  const stats = await buildMemoryStats(config)
  const snapshot = saveStatsSnapshotIfNeeded(stats, { collection })
  if (snapshot) {
    debugLog(`Captured stats snapshot ts=${snapshot.timestamp}`)
  }
}

export async function runPostSessionWorker(inputFile: string | undefined): Promise<void> {
  trimLogsOnce()
  debugLog(`START pid=${process.pid}`)
  try {
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
    debugSessionId = payload.session_id
    const plannedRunId = randomUUID()
    const runStart = Date.now()
    let collection: string | undefined
    let config: Config | undefined
    let runSaved = false
    debugLog(`Parsed payload: event=${payload.hook_event_name}, session=${payload.session_id}`)
    auditLog(`START event=${payload.hook_event_name} session=${payload.session_id} transcript=${payload.transcript_path}`)
    try {
      const retentionMs = MEMORY_WRITE_HINT_RETENTION_DAYS * 24 * 60 * 60 * 1000
      cleanupMemoryWriteHints(Date.now() - retentionMs)
    } catch (error) {
      console.error('[claude-memory] Failed to clean up memory_write hints:', error)
    }
    try {
      const configRoot = findGitRoot(payload.cwd) ?? (payload.cwd ? canonicalizePath(payload.cwd) : payload.cwd)
      config = loadConfig(configRoot)
      collection = config.lancedb.table

      // Try to acquire lock - if another worker holds it (e.g. PreCompact running
      // when SessionEnd arrives), queue the payload for the active holder instead
      // of silently dropping SessionEnd.
      let lockHandle = acquireWorkerLock(payload.session_id)
      let initialPayload: ExtractionHookInput = payload
      if (!lockHandle) {
        enqueuePendingPayload(payload.session_id, payload)
        auditLog(`QUEUED reason=locked event=${payload.hook_event_name} session=${payload.session_id}`)
        debugLog('Lock held by another process; queued payload for handoff')
        // Close TOCTOU window: re-check lock once after queuing in case the holder
        // exited right before our pending file landed.
        lockHandle = acquireWorkerLock(payload.session_id)
        if (!lockHandle) {
          return
        }
        const claimed = consumePendingPayload(payload.session_id)
        if (!claimed) {
          lockHandle.release()
          return
        }
        initialPayload = claimed
      }

      try {
        let currentPayload: ExtractionHookInput | null = initialPayload
        let currentRunId = plannedRunId
        let currentStart = runStart
        let iteration = 0
        while (currentPayload && iteration < MAX_PENDING_HANDOFF_ITERATIONS) {
          iteration += 1
          const savedThisPass = await processSingleSessionPayload(
            currentPayload,
            config,
            collection,
            currentRunId,
            currentStart
          )
          runSaved = runSaved || savedThisPass
          const nextPending = consumePendingPayload(payload.session_id)
          if (!nextPending) break
          auditLog(`HANDOFF event=${nextPending.hook_event_name} session=${nextPending.session_id} iteration=${iteration + 1}`)
          currentPayload = nextPending
          currentRunId = randomUUID()
          currentStart = Date.now()
        }
      } finally {
        lockHandle.release()
      }

      try {
        const migrationResult = await runPendingMigrations(config)
        const settingsSummary = migrationResult.settingsMigration
          ? ` settings=${migrationResult.settingsMigration.status}(dropped=${migrationResult.settingsMigration.droppedKeys.length},kept=${migrationResult.settingsMigration.keptKeys.length})`
          : ''
        if (migrationResult.status === 'applied') {
          const totalUpdated = migrationResult.steps.reduce((sum, step) => sum + step.updated, 0)
          debugLog(
            `Data migrations applied: count=${migrationResult.steps.length} updated=${totalUpdated} compacted=${migrationResult.compacted}${settingsSummary}`
          )
        } else if (migrationResult.status === 'failed') {
          console.error('[claude-memory] Data migrations failed:', migrationResult.error ?? 'unknown error')
        } else if (migrationResult.settingsMigration?.status === 'migrated') {
          debugLog(
            `Settings migration applied (data migrations ${migrationResult.status}${migrationResult.skipReason ? `:${migrationResult.skipReason}` : ''}):${settingsSummary}`
          )
        }
        if (migrationResult.settingsMigration?.status === 'skipped' && migrationResult.settingsMigration.error) {
          console.error('[claude-memory] Settings migration skipped:', migrationResult.settingsMigration.error)
        }
      } catch (error) {
        console.error('[claude-memory] Data migrations failed:', error)
      }

      try {
        await maybeRunAutoMaintenance(config)
      } catch (error) {
        console.error('[claude-memory] Auto-maintenance failed:', error)
      }

      try {
        await maybeCaptureStatsSnapshot(config)
      } catch (error) {
        console.error('[claude-memory] Stats snapshot capture failed:', error)
      }
    } catch (error) {
      const duration = Date.now() - runStart
      handleWorkerCrash(payload, plannedRunId, duration, error, collection, runSaved)
    }
  } finally {
    try {
      await closeLanceDB()
    } catch (error) {
      console.error('[claude-memory] Failed to close LanceDB connection:', error)
    }
    try {
      const update = runSelfUpdate({ trigger: 'auto' })
      debugLog(
        `Self-update complete: status=${update.status} pull=${update.pull.status} build=${update.build.status}`
      )
      if (update.status === 'failed') {
        console.error('[claude-memory] Self-update failed:', update.error ?? 'unknown error')
      }
    } catch (error) {
      console.error('[claude-memory] Self-update failed:', error)
    }
  }
}

async function processSingleSessionPayload(
  payload: ExtractionHookInput,
  config: Config,
  collection: string,
  plannedRunId: string,
  _runStart: number
): Promise<boolean> {
  const hintSettings = loadSettings()
  const storedMemoryWriteHints = loadMemoryWriteHints(payload.session_id)

  // Skip extraction if session was cleared
  if (payload.hook_event_name === 'SessionEnd' && payload.reason === 'clear') {
    debugLog('Skipping: reason=clear')
    auditLog(`SKIP reason=clear session=${payload.session_id}`)
    console.error('[claude-memory] SessionEnd reason=clear; skipping extraction.')
    removeSessionTracking(payload.session_id, collection)
    deleteMemoryWriteHintsSafely(payload.session_id)
    return false
  }

  if (!payload.transcript_path) {
    debugLog('Skipping: no transcript_path')
    auditLog(`SKIP reason=no_transcript session=${payload.session_id}`)
    console.warn('[claude-memory] Transcript not found; skipping extraction. path=missing')
    if (payload.hook_event_name === 'SessionEnd') {
      removeSessionTracking(payload.session_id, collection)
    }
    return false
  }

  // Check for skip-extraction marker in transcript via bounded streaming scan
  if (fs.existsSync(payload.transcript_path)) {
    if (await fileContainsMarker(payload.transcript_path, SKIP_EXTRACTION_MARKER)) {
      debugLog('Skipping: skip-extraction marker found in transcript')
      auditLog(`SKIP reason=skip_requested session=${payload.session_id}`)
      console.error('[claude-memory] Skip-extraction marker found; skipping extraction.')
      removeSessionTracking(payload.session_id, collection)
      if (payload.hook_event_name === 'SessionEnd') {
        deleteMemoryWriteHintsSafely(payload.session_id)
      }
      return false
    }
  }

  debugLog('Initializing LanceDB...')
  await initLanceDB(config)
  debugLog('LanceDB initialized')

  // Load session tracking to get injected memories for change detection + merged usefulness rating.
  // Snapshot the current length & version before async extraction so post-compaction prompts arriving
  // during PreCompact extraction are never swallowed or wiped from the new epoch's ledger.
  const session = loadSessionTracking(payload.session_id, collection)
  const snapshotMemoryCount = session?.memories.length ?? 0
  const snapshotRetrievalStateVersion = session?.retrievalStateVersion ?? 0
  const injectedMemories = session ? selectUnratedMemories(session, snapshotMemoryCount) : []
  debugLog(`Loaded ${injectedMemories.length} unrated injected memories for change detection & usefulness rating`)

  // Check for prior extraction of this session (incremental extraction)
  const priorRun = getLastExtractionRunForSession(payload.session_id, collection)
  const previousEventCount = priorRun?.extractedEventCount
  const priorHintIdentities = new Set(
    (priorRun?.memoryWriteHints ?? []).map(memoryWriteHintIdentity)
  )
  const memoryWriteHints = hintSettings.enableMemoryWriteHints
    ? storedMemoryWriteHints.filter(hint => !priorHintIdentities.has(memoryWriteHintIdentity(hint)))
    : []
  debugLog(`Loaded ${memoryWriteHints.length} unprocessed memory_write hints`)
  if (previousEventCount) {
    debugLog(`Found prior extraction run ${priorRun.runId} with ${previousEventCount} events`)
    auditLog(`INCREMENTAL prior_run=${priorRun.runId} prior_events=${previousEventCount} session=${payload.session_id}`)
  }

  let result: Awaited<ReturnType<typeof handlePostSession>> | null = null
  let shouldFlush = false
  const extractionStart = Date.now()
  let extractionDuration = 0
  let runTokenUsage = emptyTokenUsage()
  let usefulnessDuration: number | undefined
  let extractionThrown: unknown
  let extractionDidThrow = false
  let runSaved = false
  try {
    debugLog('Running extraction...')
    result = await handlePostSession(payload, config, {
      flush: 'end-of-batch',
      injectedMemories,
      previousExtractionEventCount: previousEventCount,
      plannedRunId,
      memoryWriteHints,
      recordAugmenter: (record, transcript) => ({
        ...record,
        sourceSessionId: payload.session_id,
        // Prefer LLM-provided sourceExcerpt, fall back to heuristic search
        sourceExcerpt: record.sourceExcerpt ?? buildSourceExcerpt(record, transcript)
      })
    })
    debugLog(`Extraction done: inserted=${result.inserted}, updated=${result.updated}, skipped=${result.skipped}, failed=${result.failed}${result.isIncremental ? ' (incremental)' : ''}`)
    shouldFlush = (result.inserted + result.updated) > 0
    extractionDuration = Date.now() - extractionStart
    if (result.tokenUsage) {
      runTokenUsage = addTokenUsage(runTokenUsage, result.tokenUsage)
    }
  } catch (error) {
    extractionThrown = error
    extractionDidThrow = true
  } finally {
    debugLog('Running usefulness rating...')
    const usefulnessStart = Date.now()
    let usefulness: Awaited<ReturnType<typeof processUsefulnessRating>>
    try {
      usefulness = await processUsefulnessRating(
        payload,
        config,
        result?.transcript,
        getUsefulnessRunId(result, plannedRunId),
        {
          preRatedHelpfulIds: result?.helpfulMemoryIds,
          usefulnessRatedDuringExtraction: result?.usefulnessRatedDuringExtraction,
          snapshotMemoryCount: payload.hook_event_name === 'PreCompact' ? snapshotMemoryCount : undefined,
          snapshotRetrievalStateVersion
        }
      )
    } catch (error) {
      usefulness = {
        updated: false,
        tokenUsage: emptyTokenUsage(),
        ran: true,
        error: sanitizeErrorMessage(error)
      }
    }
    if (usefulness.ran) {
      usefulnessDuration = Date.now() - usefulnessStart
    }
    shouldFlush = usefulness.updated || shouldFlush
    runTokenUsage = addTokenUsage(runTokenUsage, usefulness.tokenUsage)
    if (usefulness.error) {
      auditLog(`WARN session=${payload.session_id} runId=${plannedRunId} stage=usefulness_rating${usefulnessDuration !== undefined ? ` duration=${usefulnessDuration}ms` : ''} cause=${quoteLogValue(usefulness.error)}`)
    }
    debugLog('Usefulness rating done')
  }

  if (extractionDidThrow) throw extractionThrown

  if (result) {
    auditDiagnostics(payload, plannedRunId, result.diagnostics)
    const stageTimings = usefulnessDuration !== undefined
      ? { ...result.timings, usefulness: usefulnessDuration }
      : result.timings
    runSaved = saveRunLog(
      payload,
      result,
      plannedRunId,
      extractionDuration,
      runTokenUsage,
      collection,
      stageTimings,
      memoryWriteHints
    )
  }

  if (shouldFlush) {
    debugLog('Flushing writes (no-op for LanceDB)...')
    await flushCollection(config)
  }

  if (!result) return runSaved

  if (shouldDeleteMemoryWriteHints(payload, result, runSaved)) {
    deleteMemoryWriteHintsSafely(payload.session_id)
  }

  if (result.reason === 'no_transcript') {
    console.warn(`[claude-memory] Transcript not found; skipping extraction. path=${payload.transcript_path}`)
    return runSaved
  }

  if (result.reason === 'no_new_events') {
    debugLog('Skipping: no new events since last extraction')
    auditLog(`SKIP reason=no_new_events session=${payload.session_id} events=${result.extractedEventCount}`)
    console.error('[claude-memory] No new events since last extraction; skipping.')
    return runSaved
  }

  if (result.reason === 'no_records') {
    console.error('[claude-memory] No records extracted.')
    return runSaved
  }

  const incrementalLabel = result.isIncremental ? ' (incremental)' : ''
  const supersedesMissingLabel = result.supersedesMissing ? `, supersedesMissing=${result.supersedesMissing}` : ''
  console.error(
    `[claude-memory] Extraction complete${incrementalLabel}: inserted=${result.inserted}, updated=${result.updated}, skipped=${result.skipped}, failed=${result.failed}${supersedesMissingLabel}`
  )
  debugLog('COMPLETE')
  return runSaved
}

export function saveRunLog(
  payload: ExtractionHookInput,
  result: Awaited<ReturnType<typeof handlePostSession>>,
  runId: string,
  duration: number,
  tokenUsage: TokenUsage,
  collection?: string,
  stageTimings?: Partial<Record<string, number>>,
  memoryWriteHints?: MemoryWriteHintEvent[]
): boolean {
  if (!shouldPersistRunForResult(result)) {
    auditLog(`DONE session=${payload.session_id} reason=${result.reason} (no run saved)`)
    return false
  }

  const recordOutcomes = result.recordOutcomes ?? []
  const insertedIds = Array.from(new Set(result.insertedIds ?? []))
  const updatedIds = Array.from(new Set(result.updatedIds ?? []))
  const uniqueIds = Array.from(new Set([...insertedIds, ...updatedIds]))
  const persistedRecordCount = uniqueIds.length
  const skippedRecordCount = recordOutcomes.filter(outcome => outcome.outcome === 'skipped').length
  const failedRecordCount = recordOutcomes.filter(outcome => outcome.outcome === 'failed').length
  const extractedRecords = buildExtractionRecordSummaries(result.records, recordOutcomes)
  const firstPrompt = result.transcript ? getFirstUserPrompt(result.transcript) : undefined
  const extractionError = sanitizeExtractionFailure(result.extractionError)
  const runFailure = isExtractionRunFailure({
    error: extractionError,
    recordCount: persistedRecordCount,
    failedRecordCount
  })

  const runSaved = saveExtractionRun({
    runId,
    sessionId: payload.session_id,
    transcriptPath: payload.transcript_path,
    timestamp: Date.now(),
    recordCount: persistedRecordCount,
    parseErrorCount: result.transcript?.parseErrors ?? 0,
    skippedRecordCount,
    failedRecordCount,
    extractedRecordIds: insertedIds,
    updatedRecordIds: updatedIds.length > 0 ? updatedIds : undefined,
    extractedRecords,
    duration,
    firstPrompt,
    tokenUsage: hasTokenUsage(tokenUsage) ? tokenUsage : undefined,
    extractedEventCount: runFailure ? undefined : result.extractedEventCount,
    isIncremental: result.isIncremental,
    hasRememberMarker: result.hasRememberMarker,
    memoryWriteHints: memoryWriteHints && memoryWriteHints.length > 0
      ? memoryWriteHints
      : undefined,
    supersedesMissing: result.supersedesMissing || undefined,
    skipReason: extractionError ? undefined
      : result.reason === 'too_short' ? 'too_short'
      : (result.reason === 'no_records' && persistedRecordCount === 0) ? 'no_records'
      : undefined,
    error: extractionError
  }, collection)

  const auditStatus = runFailure ? 'FAILED' : 'DONE'
  auditLog(`${auditStatus} session=${payload.session_id} runId=${runId} inserted=${result.inserted} updated=${result.updated} skipped=${result.skipped} failed=${result.failed} supersedesMissing=${result.supersedesMissing ?? 0} duration=${duration}ms events=${result.extractedEventCount ?? '?'}${result.isIncremental ? ' incremental' : ''}${formatStageTimings(stageTimings ?? result.timings, { extraStages: WORKER_EXTRA_TIMING_STAGES, leadingSpace: true })}${auditErrorSuffix(extractionError)}`)
  return runSaved
}

function selectUnratedMemories(
  session: { memories: InjectedMemoryEntry[]; ratedMemoryCount?: number; ratedMemoryIds?: string[] },
  maxLength?: number
): InjectedMemoryEntry[] {
  const scoped = maxLength !== undefined ? session.memories.slice(0, maxLength) : session.memories
  if (session.ratedMemoryCount !== undefined) {
    return dedupeInjectedMemories(scoped.slice(Math.max(0, session.ratedMemoryCount)))
  }
  const ratedSet = new Set(session.ratedMemoryIds ?? [])
  return dedupeInjectedMemories(scoped).filter(entry => !ratedSet.has(entry.id))
}

export async function processUsefulnessRating(
  payload: ExtractionHookInput,
  config: Config,
  transcript?: Transcript,
  runId?: string,
  options: {
    preRatedHelpfulIds?: string[]
    usefulnessRatedDuringExtraction?: boolean
    snapshotMemoryCount?: number
    snapshotRetrievalStateVersion?: number
  } = {}
): Promise<{ updated: boolean; tokenUsage: TokenUsage; ran: boolean; error?: string }> {
  if (payload.hook_event_name !== 'SessionEnd' && payload.hook_event_name !== 'PreCompact') {
    return { updated: false, tokenUsage: emptyTokenUsage(), ran: false }
  }

  const isPreCompact = payload.hook_event_name === 'PreCompact'
  const collection = config.lancedb.table
  const session = loadSessionTracking(payload.session_id, collection)
  const resetOptions = options.snapshotRetrievalStateVersion !== undefined
    ? { expectedVersion: options.snapshotRetrievalStateVersion }
    : undefined

  if (!session || session.memories.length === 0) {
    if (isPreCompact) {
      if (typeof resetSessionInjectionLedger === 'function') {
        resetSessionInjectionLedger(payload.session_id, collection, resetOptions)
      }
    } else {
      removeSessionTracking(payload.session_id, collection)
    }
    return { updated: false, tokenUsage: emptyTokenUsage(), ran: false }
  }

  // On PreCompact, bound rating/counting to memories already present before extraction started
  // so memories injected by post-compaction prompts arriving mid-extraction are preserved for later rating.
  const maxScopedLength = isPreCompact && options.snapshotMemoryCount !== undefined
    ? Math.min(session.memories.length, options.snapshotMemoryCount)
    : session.memories.length
  const memories = session.memories.slice(0, maxScopedLength)
  if (memories.length === 0) {
    if (isPreCompact) {
      if (typeof resetSessionInjectionLedger === 'function') {
        resetSessionInjectionLedger(payload.session_id, collection, resetOptions)
      }
    } else {
      removeSessionTracking(payload.session_id, collection)
    }
    return { updated: false, tokenUsage: emptyTokenUsage(), ran: false }
  }

  let updated = false
  let tokenUsage = emptyTokenUsage()
  let failure: string | undefined

  const previouslyCounted = session.countedMemoryCount !== undefined
    ? session.countedMemoryCount
    : (session.retrievalCounted ? memories.length : 0)
  const uncountedMemories = memories.slice(previouslyCounted)
  if (uncountedMemories.length > 0) {
    try {
      const retrievalDeltas = countRetrievalDeltas(uncountedMemories)
      if (retrievalDeltas.size > 0) {
        const incremented = await batchIncrementRecordCounters(retrievalDeltas, 'retrievalCount', config)
        updated = incremented || updated
        if (incremented && typeof markSessionRetrievalCounted === 'function') {
          markSessionRetrievalCounted(payload.session_id, collection, memories.length)
        }
      }
    } catch (error) {
      console.error('[claude-memory] Failed to update retrieval counts:', error)
    }
  }

  const deduped = selectUnratedMemories(session, maxScopedLength)
  if (deduped.length === 0) {
    if (isPreCompact) {
      if (typeof resetSessionInjectionLedger === 'function') {
        resetSessionInjectionLedger(payload.session_id, collection, resetOptions)
      }
    } else {
      removeSessionTracking(payload.session_id, collection)
    }
    return { updated, tokenUsage, ran: false }
  }

  let shouldFinalize = false

  try {
    let helpfulIds: string[]
    if (options.usefulnessRatedDuringExtraction) {
      const allowedIds = new Set(deduped.map(entry => entry.id))
      helpfulIds = (options.preRatedHelpfulIds ?? []).filter(id => allowedIds.has(id))
    } else {
      let resolvedTranscript = transcript
      if (!resolvedTranscript) {
        if (!payload.transcript_path || !fs.existsSync(payload.transcript_path)) {
          console.error('[claude-memory] Transcript missing for usefulness rating; keeping session tracking file.')
          return { updated, tokenUsage, ran: true, error: 'transcript missing for usefulness rating' }
        }
        resolvedTranscript = await parseTranscript(payload.transcript_path)
      }

      const rating = await rateInjectedMemories(resolvedTranscript, deduped, config, {
        sessionId: payload.session_id,
        runId
      })
      tokenUsage = addTokenUsage(tokenUsage, rating.tokenUsage)
      helpfulIds = rating.helpfulIds
    }

    if (helpfulIds.length > 0) {
      // NOTE: Best-effort counters; concurrent sessions can drop increments.
      const usageDeltas = new Map(Array.from(new Set(helpfulIds)).map(id => [id, 1]))
      updated = await batchIncrementRecordCounters(usageDeltas, 'usageCount', config) || updated
    }

    shouldFinalize = true
  } catch (error) {
    console.error('[claude-memory] Usefulness rating failed:', error)
    failure = sanitizeErrorMessage(error)
  } finally {
    if (isPreCompact) {
      if (shouldFinalize && typeof markSessionMemoriesRated === 'function') {
        markSessionMemoriesRated(
          payload.session_id,
          deduped.map(entry => entry.id),
          collection,
          { countedMemoryCount: memories.length, ratedMemoryCount: memories.length }
        )
      }
      if (typeof resetSessionInjectionLedger === 'function') {
        resetSessionInjectionLedger(payload.session_id, collection, resetOptions)
      }
    } else if (shouldFinalize) {
      removeSessionTracking(payload.session_id, collection)
    }
  }

  return { updated, tokenUsage, ran: true, ...(failure ? { error: failure } : {}) }
}

function countRetrievalDeltas(memories: InjectedMemoryEntry[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const entry of memories) {
    if (!entry.id) continue
    counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1)
  }
  return counts
}

async function batchIncrementRecordCounters(
  deltas: Map<string, number>,
  counter: 'retrievalCount' | 'usageCount',
  config: Config
): Promise<boolean> {
  const records = await fetchRecordsByIds(Array.from(deltas.keys()), config, { includeEmbeddings: true })
  if (records.length === 0) return false

  const now = Date.now()
  const updatedRecords = records.map(record => ({
    ...record,
    [counter]: (record[counter] ?? 0) + (deltas.get(record.id) ?? 0),
    // Separate lastRetrievedAt from lastUsed: only verified usefulness bumps lastUsed.
    ...(counter === 'retrievalCount' ? { lastRetrievedAt: now } : { lastUsed: now })
  }))
  const result = await batchUpdateRecords(updatedRecords, {}, config, { continueOnBatchError: true })
  if (result.failed > 0) {
    const failures = result.failures ?? []
    const details = failures.map(failure => {
      const ids = failure.recordIds.join(',')
      return `${failure.stage} [${ids}]: ${sanitizeErrorMessage(failure.error)}`
    })
    const suffix = details.length > 0 ? `: ${details.join('; ')}` : ''
    throw new AggregateError(
      failures.map(failure => failure.error),
      `Failed ${result.failed} ${counter} counter update(s)${suffix}`
    )
  }
  return result.updated > 0
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

if (isProcessEntrypoint(import.meta.url)) {
  runPostSessionWorker(process.argv[2])
    .then(() => {
      process.exitCode = 0
    })
    .catch(error => {
      console.error('[claude-memory] post-session-worker failed:', error)
      process.exitCode = 2
    })
}
