import nodeFs from 'fs'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type ExtractionHookInput, type MemoryWriteHintEvent, type TokenUsage } from '../src/lib/types.js'
import { SKIP_EXTRACTION_MARKER } from '../src/lib/claude-commands.js'
import { createMockDiscoveryRecord } from './helpers.js'

let storageRoot = ''
const savedRuns: unknown[] = []
let selfUpdateCallArguments: unknown[][] = []

const tokenUsage: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0
}

const payload: ExtractionHookInput = {
  hook_event_name: 'SessionEnd',
  session_id: 'worker-session',
  transcript_path: '/tmp/transcript.jsonl',
  cwd: '/tmp/project'
}

async function loadWorker(options: {
  usefulnessAttributions?: Array<{ sessionId?: string; runId?: string }>
  lifecycle?: string[]
  workerResult?: unknown
  runPeriodicJobs?: boolean
  onSelfUpdate?: () => void
  memoryWriteHints?: MemoryWriteHintEvent[]
  hintCalls?: { loaded: string[]; deleted: string[]; cleanupCutoffs: number[] }
  hintsEnabled?: boolean
  handleCalls?: unknown[][]
  priorRun?: {
    runId: string
    timestamp: number
    extractedEventCount?: number
    memoryWriteHints?: MemoryWriteHintEvent[]
  }
  saveRunSucceeds?: boolean
} = {}): Promise<typeof import('../src/hooks/post-session-worker.js')> {
  vi.resetModules()
  savedRuns.length = 0
  selfUpdateCallArguments = []
  vi.doMock('../src/lib/paths.js', () => ({
    CLAUDE_MEMORY_ROOT: storageRoot,
    DEBUG_LOG_FILE: path.join(storageRoot, 'debug.log'),
    LOCKS_DIR: path.join(storageRoot, 'locks'),
    SELF_UPDATE_STATE_PATH: path.join(storageRoot, 'self-update-state.json'),
    SELF_UPDATE_LOCK_PATH: path.join(storageRoot, 'locks', 'self-update.lock'),
    CLAUDE_SETTINGS_PATH: path.join(storageRoot, '.claude', 'settings.json'),
    CLAUDE_CONFIG_PATH: path.join(storageRoot, '.claude.json'),
    PROJECT_ROOT: storageRoot,
    canonicalizePath: (targetPath: string) => path.resolve(targetPath)
  }))
  vi.doMock('../src/lib/self-update.js', () => ({
    runSelfUpdate: vi.fn((...args: unknown[]) => {
      selfUpdateCallArguments.push(args)
      options.onSelfUpdate?.()
      options.lifecycle?.push('self-update')
      return {
        status: 'completed',
        pull: { status: 'disabled' },
        build: { status: 'up-to-date' }
      }
    })
  }))
  vi.doMock('../src/lib/memory-write-hints.js', () => ({
    MEMORY_WRITE_HINT_RETENTION_DAYS: 90,
    coerceMemoryWriteHintEvent: vi.fn((value: unknown) => value),
    loadMemoryWriteHints: vi.fn((sessionId: string) => {
      options.hintCalls?.loaded.push(sessionId)
      return options.memoryWriteHints ?? []
    }),
    deleteMemoryWriteHints: vi.fn((sessionId: string) => {
      options.hintCalls?.deleted.push(sessionId)
      return true
    }),
    cleanupMemoryWriteHints: vi.fn((cutoffMs: number) => {
      options.hintCalls?.cleanupCutoffs.push(cutoffMs)
    })
  }))
  if (options.lifecycle) {
    vi.doMock('../src/lib/lancedb.js', async () => {
      const actual = await vi.importActual<typeof import('../src/lib/lancedb.js')>('../src/lib/lancedb.js')
      return {
        ...actual,
        initLanceDB: vi.fn(async () => {}),
        flushCollection: vi.fn(async () => {}),
        closeLanceDB: vi.fn(async () => {
          options.lifecycle!.push('close')
        })
      }
    })
  }
  if (Object.prototype.hasOwnProperty.call(options, 'workerResult')) {
    vi.doMock('../src/hooks/post-session.js', () => ({
      handlePostSession: vi.fn(async (...args: unknown[]) => {
        options.handleCalls?.push(args)
        return options.workerResult
      })
    }))
  }
  if (options.runPeriodicJobs || options.hintsEnabled !== undefined) {
    vi.doMock('../src/lib/settings.js', async () => {
      const actual = await vi.importActual<typeof import('../src/lib/settings.js')>('../src/lib/settings.js')
      return {
        ...actual,
        loadSettings: vi.fn(() => ({
          ...actual.getDefaultSettings(),
          autoMaintenanceIntervalHours: options.runPeriodicJobs ? 1 : 0,
          enableMemoryWriteHints: options.hintsEnabled ?? true
        }))
      }
    })
  }
  if (options.runPeriodicJobs) {
    vi.doMock('../src/lib/maintenance-log.js', () => ({
      getLastMaintenanceRun: vi.fn(() => undefined),
      buildMaintenanceRun: vi.fn(() => ({
        summary: { totalActions: 0 }
      })),
      saveMaintenanceRun: vi.fn()
    }))
    vi.doMock('../src/lib/maintenance-api.js', () => ({
      runAllMaintenance: vi.fn(async () => {
        options.lifecycle?.push('maintenance')
        return []
      })
    }))
    vi.doMock('../src/lib/stats-snapshots.js', () => ({
      hasStatsSnapshot: vi.fn(() => false),
      saveStatsSnapshotIfNeeded: vi.fn(() => null)
    }))
    vi.doMock('../src/lib/memory-stats.js', () => ({
      buildMemoryStats: vi.fn(async () => {
        options.lifecycle?.push('stats')
        return {}
      })
    }))
  }
  vi.doMock('../src/lib/extraction-log.js', async () => {
    const actual = await vi.importActual<typeof import('../src/lib/extraction-log.js')>('../src/lib/extraction-log.js')
    return {
      ...actual,
      getLastExtractionRunForSession: vi.fn(() => options.priorRun),
      listInProgressExtractions: vi.fn(() => []),
      saveExtractionRun: vi.fn((run: unknown) => {
        savedRuns.push(run)
        return options.saveRunSucceeds ?? true
      })
    }
  })
  if (options.usefulnessAttributions) {
    vi.doMock('../src/lib/session-tracking.js', () => ({
      dedupeInjectedMemories: vi.fn((entries: unknown[]) => entries),
      loadSessionTracking: vi.fn(() => ({
        memories: [{ id: 'memory-1', snippet: 'useful context', injectedAt: 1 }]
      })),
      removeSessionTracking: vi.fn()
    }))
    vi.doMock('../src/lib/extract.js', async () => {
      const actual = await vi.importActual<typeof import('../src/lib/extract.js')>('../src/lib/extract.js')
      return {
        ...actual,
        rateInjectedMemories: vi.fn(async (_transcript, _memories, _config, attribution) => {
          options.usefulnessAttributions!.push(attribution)
          return { helpfulIds: [], tokenUsage }
        })
      }
    })
  }
  return await import('../src/hooks/post-session-worker.js')
}

async function readAuditLog(): Promise<string> {
  return await fs.readFile(path.join(storageRoot, 'extraction-audit.log'), 'utf-8')
}

function writeWorkerInput(name: string, value: string | object): string {
  const inputPath = path.join(storageRoot, `${name}.json`)
  nodeFs.mkdirSync(path.dirname(inputPath), { recursive: true })
  nodeFs.writeFileSync(
    inputPath,
    typeof value === 'string' ? value : JSON.stringify(value),
    'utf-8'
  )
  return inputPath
}

function workerResult(reason?: string): Record<string, unknown> {
  return {
    inserted: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    records: [],
    insertedIds: [],
    updatedIds: [],
    extractedEventCount: 1,
    ...(reason ? { reason } : {})
  }
}

beforeEach(async () => {
  storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-memory-worker-'))
})

afterEach(async () => {
  vi.doUnmock('../src/lib/paths.js')
  vi.doUnmock('../src/lib/extraction-log.js')
  vi.doUnmock('../src/lib/session-tracking.js')
  vi.doUnmock('../src/lib/extract.js')
  vi.doUnmock('../src/lib/self-update.js')
  vi.doUnmock('../src/lib/lancedb.js')
  vi.doUnmock('../src/hooks/post-session.js')
  vi.doUnmock('../src/lib/settings.js')
  vi.doUnmock('../src/lib/maintenance-log.js')
  vi.doUnmock('../src/lib/maintenance-api.js')
  vi.doUnmock('../src/lib/stats-snapshots.js')
  vi.doUnmock('../src/lib/memory-stats.js')
  vi.doUnmock('../src/lib/memory-write-hints.js')
  vi.resetModules()
  await fs.rm(storageRoot, { recursive: true, force: true })
})

describe('post-session worker run saving', () => {
  it('saves true failures without skipReason or checkpoint and logs FAILED', async () => {
    const { saveRunLog } = await loadWorker()

    const persisted = saveRunLog(payload, {
      inserted: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      records: [],
      insertedIds: [],
      updatedIds: [],
      reason: 'no_records',
      extractedEventCount: 42,
      extractionError: {
        kind: 'api_error',
        code: 'api_error',
        message: 'Internal server error',
        requestId: 'req_failed'
      }
    }, 'planned-failed', 123, tokenUsage, 'test-collection')

    expect(persisted).toBe(true)
    expect(savedRuns).toHaveLength(1)
    const saved = savedRuns[0] as { skipReason?: string; extractedEventCount?: number; error?: unknown }
    expect(saved.skipReason).toBeUndefined()
    expect(saved.extractedEventCount).toBeUndefined()
    expect(saved.error).toMatchObject({ kind: 'api_error', requestId: 'req_failed' })
    expect(await readAuditLog()).toContain('FAILED session=worker-session')
    expect(await readAuditLog()).toContain('error=api_error:api_error request_id=req_failed')
  })

  it('keeps partial successes as DONE with error suffix', async () => {
    const { saveRunLog } = await loadWorker()

    const persisted = saveRunLog(payload, {
      inserted: 1,
      updated: 0,
      skipped: 0,
      failed: 0,
      records: [],
      insertedIds: ['record-1'],
      updatedIds: [],
      extractedEventCount: 43,
      extractionError: { kind: 'max_tokens', maxTokens: 64000 }
    }, 'planned-partial', 456, tokenUsage, 'test-collection')

    expect(persisted).toBe(true)
    expect(savedRuns).toHaveLength(1)
    const saved = savedRuns[0] as { recordCount?: number; extractedEventCount?: number; skipReason?: string }
    expect(saved.recordCount).toBe(1)
    expect(saved.extractedEventCount).toBe(43)
    expect(saved.skipReason).toBeUndefined()
    const audit = await readAuditLog()
    expect(audit).toContain('DONE session=worker-session')
    expect(audit).toContain('error=max_tokens')
  })

  it('persists record outcome metadata and keeps updated IDs in the destructive union', async () => {
    const { saveRunLog } = await loadWorker()
    const inserted = createMockDiscoveryRecord({ id: 'extracted-insert' })
    const updated = createMockDiscoveryRecord({ id: 'extracted-update' })
    const skipped = createMockDiscoveryRecord({ id: 'extracted-skip' })
    const failed = createMockDiscoveryRecord({ id: 'extracted-failed' })

    const persisted = saveRunLog(payload, {
      inserted: 1,
      updated: 1,
      skipped: 1,
      failed: 1,
      records: [inserted, updated, skipped, failed],
      recordOutcomes: [
        { id: inserted.id, outcome: 'inserted', storedRecordId: inserted.id },
        { id: updated.id, outcome: 'updated', storedRecordId: 'existing-updated', dedupSimilarity: 0.876 },
        { id: skipped.id, outcome: 'skipped', storedRecordId: 'existing-skipped', dedupSimilarity: 0.765 },
        { id: failed.id, outcome: 'failed', storeError: 'store failed' }
      ],
      insertedIds: [inserted.id],
      updatedIds: ['existing-updated'],
      extractedEventCount: 45
    }, 'planned-outcomes', 111, tokenUsage, 'test-collection')

    expect(persisted).toBe(true)
    expect(savedRuns).toHaveLength(1)
    const saved = savedRuns[0] as {
      recordCount?: number
      skippedRecordCount?: number
      failedRecordCount?: number
      extractedEventCount?: number
      extractedRecordIds?: string[]
      updatedRecordIds?: string[]
      extractedRecords?: Array<Record<string, unknown>>
    }
    expect(saved.recordCount).toBe(2)
    expect(saved.skippedRecordCount).toBe(1)
    expect(saved.failedRecordCount).toBe(1)
    expect(saved.extractedEventCount).toBe(45)
    expect(saved.extractedRecordIds).toEqual([inserted.id])
    expect(saved.updatedRecordIds).toEqual(['existing-updated'])
    const deleteUnion = new Set([...(saved.extractedRecordIds ?? []), ...(saved.updatedRecordIds ?? [])])
    expect(Array.from(deleteUnion)).toEqual([inserted.id, 'existing-updated'])
    expect(deleteUnion.has('existing-skipped')).toBe(false)
    expect(saved.extractedRecords).toMatchObject([
      { id: inserted.id, outcome: 'inserted', storedRecordId: inserted.id },
      { id: updated.id, outcome: 'updated', storedRecordId: 'existing-updated', dedupSimilarity: 0.876 },
      { id: skipped.id, outcome: 'skipped', storedRecordId: 'existing-skipped', dedupSimilarity: 0.765 },
      { id: failed.id, outcome: 'failed', storeError: 'store failed' }
    ])
  })

  it('preserves clean no_records skipReason and checkpoint behavior', async () => {
    const { saveRunLog } = await loadWorker()

    const persisted = saveRunLog(payload, {
      inserted: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      records: [],
      insertedIds: [],
      updatedIds: [],
      reason: 'no_records',
      extractedEventCount: 44
    }, 'planned-clean', 789, tokenUsage, 'test-collection')

    expect(persisted).toBe(true)
    expect(savedRuns).toHaveLength(1)
    const saved = savedRuns[0] as { skipReason?: string; extractedEventCount?: number; error?: unknown }
    expect(saved.skipReason).toBe('no_records')
    expect(saved.extractedEventCount).toBe(44)
    expect(saved.error).toBeUndefined()
    expect(await readAuditLog()).toContain('DONE session=worker-session')
  })

  it('withholds the checkpoint when extraction produced records but every store failed', async () => {
    const { saveRunLog } = await loadWorker()
    const failedRecord = createMockDiscoveryRecord({ id: 'all-store-failed' })

    const persisted = saveRunLog(payload, {
      inserted: 0,
      updated: 0,
      skipped: 0,
      failed: 1,
      records: [failedRecord],
      recordOutcomes: [{
        id: failedRecord.id,
        outcome: 'failed',
        storeError: 'embedding endpoint unavailable'
      }],
      insertedIds: [],
      updatedIds: [],
      extractedEventCount: 45
    }, 'planned-store-failure', 123, tokenUsage, 'test-collection')

    expect(persisted).toBe(true)
    expect(savedRuns).toHaveLength(1)
    expect(savedRuns[0]).toMatchObject({
      recordCount: 0,
      failedRecordCount: 1
    })
    expect((savedRuns[0] as { extractedEventCount?: number }).extractedEventCount).toBeUndefined()
    expect(await readAuditLog()).toContain('FAILED session=worker-session runId=planned-store-failure')
  })

  it('uses the planned run id and appends compact stage timings to audit lines', async () => {
    const { saveRunLog } = await loadWorker()

    const persisted = saveRunLog(payload, {
      inserted: 1,
      updated: 0,
      skipped: 0,
      failed: 0,
      records: [],
      insertedIds: ['record-1'],
      updatedIds: [],
      extractedEventCount: 45,
      timings: { parse: 12, llm: 100.9, store: 3 }
    }, 'planned-timing', 222, tokenUsage, 'test-collection', {
      parse: 12,
      llm: 100.9,
      store: 3,
      usefulness: 8
    })

    expect(persisted).toBe(true)
    expect(savedRuns).toHaveLength(1)
    const saved = savedRuns[0] as { runId?: string }
    expect(saved.runId).toBe('planned-timing')
    const audit = await readAuditLog()
    expect(audit).toContain('runId=planned-timing')
    expect(audit).toContain('stages=parse:12ms,llm:100ms,store:3ms,usefulness:8ms')
  })

  it('saves crash partial runs as internal_error without checkpoint fields', async () => {
    const { saveCrashRun } = await loadWorker()

    saveCrashRun(
      payload,
      'planned-crash',
      321,
      new Error('database unavailable\nstack details'),
      'test-collection'
    )

    expect(savedRuns).toHaveLength(1)
    const saved = savedRuns[0] as {
      runId?: string
      recordCount?: number
      extractedEventCount?: number
      skipReason?: string
      error?: { kind?: string; message?: string }
    }
    expect(saved.runId).toBe('planned-crash')
    expect(saved.recordCount).toBe(0)
    expect(saved.extractedEventCount).toBeUndefined()
    expect(saved.skipReason).toBeUndefined()
    expect(saved.error).toEqual({ kind: 'internal_error', message: 'database unavailable' })
    const audit = await readAuditLog()
    expect(audit).toContain('FAILED session=worker-session runId=planned-crash')
    expect(audit).toContain('error=internal_error')
  })

  it('returns false when no run is persisted for no-save reasons', async () => {
    const { saveRunLog } = await loadWorker()

    const persisted = saveRunLog(payload, {
      inserted: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      records: [],
      insertedIds: [],
      updatedIds: [],
      reason: 'no_new_events',
      extractedEventCount: 44
    }, 'planned-no-save', 789, tokenUsage, 'test-collection')

    expect(persisted).toBe(false)
    expect(savedRuns).toHaveLength(0)
    expect(await readAuditLog()).toContain('DONE session=worker-session reason=no_new_events (no run saved)')
  })

  it('returns false when extraction-run persistence is not confirmed', async () => {
    const { saveRunLog } = await loadWorker({ saveRunSucceeds: false })

    const persisted = saveRunLog(payload, {
      inserted: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      records: [],
      insertedIds: [],
      updatedIds: [],
      reason: 'no_records',
      extractedEventCount: 44
    }, 'planned-write-failure', 789, tokenUsage, 'test-collection')

    expect(persisted).toBe(false)
    expect(savedRuns).toHaveLength(1)
  })

  it('trims debug and audit logs to recent whole-line tails once before appending', async () => {
    const { saveRunLog } = await loadWorker()
    const debugPath = path.join(storageRoot, 'debug.log')
    const auditPath = path.join(storageRoot, 'extraction-audit.log')
    const debugLines = Array.from({ length: 5200 }, (_, index) => `debug-line-${String(index).padStart(4, '0')}-${'x'.repeat(1010)}\n`)
    const auditLines = Array.from({ length: 5200 }, (_, index) => `audit-line-${String(index).padStart(4, '0')}-${'y'.repeat(1010)}\n`)
    await fs.writeFile(debugPath, `partial-old-line\n${debugLines.join('')}keep-debug\n`)
    await fs.writeFile(auditPath, `partial-old-line\n${auditLines.join('')}keep-audit\n`)

    saveRunLog(payload, {
      inserted: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      records: [],
      insertedIds: [],
      updatedIds: [],
      reason: 'no_records',
      extractedEventCount: 44
    }, 'planned-trim', 789, tokenUsage, 'test-collection')

    const debug = await fs.readFile(debugPath, 'utf-8')
    const audit = await fs.readFile(auditPath, 'utf-8')
    const debugFirstLine = `${debug.split('\n')[0]}\n`
    const auditFirstLine = `${audit.split('\n')[0]}\n`
    expect(debugLines).toContain(debugFirstLine)
    expect(auditLines).toContain(auditFirstLine)
    expect(debug).toContain('keep-debug')
    expect(audit).toContain('keep-audit')
    expect(audit).toContain('DONE session=worker-session')
  })

  it('leaves under-cap logs byte-identical when trimming is triggered', async () => {
    const { trimLogsOnce } = await loadWorker()
    const debugPath = path.join(storageRoot, 'debug.log')
    const auditPath = path.join(storageRoot, 'extraction-audit.log')
    const debugBefore = 'debug-one\ndebug-two\n'
    const auditBefore = 'audit-one\naudit-two\n'
    await fs.writeFile(debugPath, debugBefore)
    await fs.writeFile(auditPath, auditBefore)

    trimLogsOnce()

    await expect(fs.readFile(debugPath, 'utf-8')).resolves.toBe(debugBefore)
    await expect(fs.readFile(auditPath, 'utf-8')).resolves.toBe(auditBefore)
  })

  it('leaves the log unchanged when a concurrent shrink makes the trim read return zero bytes', async () => {
    const { trimLogFile } = await loadWorker()
    const logPath = path.join(storageRoot, 'debug.log')
    const before = 'short log\n'
    await fs.writeFile(logPath, before)
    const statSpy = vi.spyOn(nodeFs, 'statSync').mockReturnValue({
      size: 6 * 1024 * 1024
    } as unknown as ReturnType<typeof nodeFs.statSync>)

    try {
      trimLogFile(logPath)
    } finally {
      statSpy.mockRestore()
    }

    await expect(fs.readFile(logPath, 'utf-8')).resolves.toBe(before)
  })

  it('handles worker crashes by saving only pre-persist crashes', async () => {
    const { handleWorkerCrash } = await loadWorker()

    handleWorkerCrash(payload, 'planned-pre-save-crash', 123, new Error('pre-save failed'), 'test-collection', false)
    expect(savedRuns).toHaveLength(1)
    expect(savedRuns[0]).toMatchObject({
      runId: 'planned-pre-save-crash',
      error: { kind: 'internal_error', message: 'pre-save failed' }
    })
    expect(await readAuditLog()).toContain('FAILED session=worker-session runId=planned-pre-save-crash')

    handleWorkerCrash(payload, 'planned-post-save-crash', 456, new Error('post-save failed'), 'test-collection', true)
    expect(savedRuns).toHaveLength(1)
    const audit = await readAuditLog()
    expect(audit).toContain('WARN session=worker-session runId=planned-post-save-crash stage=post_save cause="post-save failed"')
  })

  it('omits orphan run ids from usefulness token attribution for no-save results', async () => {
    const attributions: Array<{ sessionId?: string; runId?: string }> = []
    const { getUsefulnessRunId, processUsefulnessRating } = await loadWorker({ usefulnessAttributions: attributions })
    const transcript = { events: [], messages: [], toolCalls: [], toolResults: [], parseErrors: 0 }
    const noSaveResult: Parameters<typeof getUsefulnessRunId>[0] = {
      inserted: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      records: [],
      insertedIds: [],
      updatedIds: [],
      reason: 'no_new_events'
    }
    const savedResult: Parameters<typeof getUsefulnessRunId>[0] = {
      inserted: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      records: [],
      insertedIds: [],
      updatedIds: [],
      reason: 'no_records'
    }

    await processUsefulnessRating(
      payload,
      DEFAULT_CONFIG,
      transcript,
      getUsefulnessRunId(noSaveResult, 'planned-no-save')
    )
    await processUsefulnessRating(
      payload,
      DEFAULT_CONFIG,
      transcript,
      getUsefulnessRunId(savedResult, 'planned-save')
    )

    expect(attributions).toHaveLength(2)
    expect(attributions[0]).toMatchObject({ sessionId: 'worker-session' })
    expect(attributions[0].runId).toBeUndefined()
    expect(attributions[1]).toMatchObject({ sessionId: 'worker-session', runId: 'planned-save' })
  })
})

describe('post-session worker memory_write hint lifecycle', () => {
  function calls() {
    return { loaded: [] as string[], deleted: [] as string[], cleanupCutoffs: [] as number[] }
  }

  function hint(sessionId: string, timestamp: number, toolUseId: string): MemoryWriteHintEvent {
    return {
      sessionId,
      timestamp,
      name: `hint-${toolUseId}`,
      toolUseId,
      content: `content-${toolUseId}`
    }
  }

  it('loads by exact session id and excludes only hints recorded on the prior run', async () => {
    const sessionId = 'exact-hint-session'
    const transcriptPath = path.join(storageRoot, 'hint-transcript.jsonl')
    await fs.writeFile(transcriptPath, '{"type":"user","message":"hello"}\n')
    const hintCalls = calls()
    const handleCalls: unknown[][] = []
    const before = Date.now()
    const processedById = hint(sessionId, 100, 'processed-by-id')
    const appendedDuringPriorRun = hint(sessionId, 150, 'appended-during-prior-run')
    const processedByFallback: MemoryWriteHintEvent = {
      sessionId,
      timestamp: 175,
      name: 'processed-by-fallback',
      content: 'current content'
    }
    const unprocessedByFallback: MemoryWriteHintEvent = {
      sessionId,
      timestamp: 180,
      name: 'unprocessed-by-fallback',
      content: 'new content'
    }
    const { runPostSessionWorker } = await loadWorker({
      lifecycle: [],
      hintCalls,
      handleCalls,
      memoryWriteHints: [
        processedById,
        appendedDuringPriorRun,
        processedByFallback,
        unprocessedByFallback
      ],
      priorRun: {
        runId: 'prior',
        timestamp: 500,
        extractedEventCount: 1,
        memoryWriteHints: [
          { ...processedById, timestamp: 450, name: 'renamed-on-prior-run' },
          { ...processedByFallback, content: 'persisted prior content' }
        ]
      },
      workerResult: workerResult('no_records')
    })

    await runPostSessionWorker(writeWorkerInput('hint-pass-through', {
      hook_event_name: 'SessionEnd',
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd: storageRoot
    }))

    expect(hintCalls.loaded).toEqual([sessionId])
    expect(hintCalls.cleanupCutoffs).toHaveLength(1)
    const retentionMs = 90 * 24 * 60 * 60 * 1000
    expect(hintCalls.cleanupCutoffs[0]).toBeGreaterThanOrEqual(before - retentionMs)
    expect(hintCalls.cleanupCutoffs[0]).toBeLessThanOrEqual(Date.now() - retentionMs)
    expect(handleCalls).toHaveLength(1)
    expect((handleCalls[0][2] as { memoryWriteHints?: MemoryWriteHintEvent[] }).memoryWriteHints)
      .toEqual([appendedDuringPriorRun, unprocessedByFallback])
    expect(hintCalls.deleted).toEqual([sessionId])
    expect(savedRuns[0]).toMatchObject({
      memoryWriteHints: [appendedDuringPriorRun, unprocessedByFallback]
    })
  })

  it('keeps hints through PreCompact, partial extraction errors, and record failures', async () => {
    const sessionId = 'retained-hint-session'
    const transcriptPath = path.join(storageRoot, 'retained-transcript.jsonl')
    await fs.writeFile(transcriptPath, '{"type":"user","message":"hello"}\n')

    const preCompactCalls = calls()
    const preCompactWorker = await loadWorker({
      lifecycle: [],
      hintCalls: preCompactCalls,
      memoryWriteHints: [hint(sessionId, 100, 'precompact')],
      workerResult: workerResult('no_records')
    })
    await preCompactWorker.runPostSessionWorker(writeWorkerInput('precompact-hints', {
      hook_event_name: 'PreCompact',
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd: storageRoot,
      trigger: 'auto'
    }))
    expect(preCompactCalls.deleted).toEqual([])

    const failureCalls = calls()
    const failureWorker = await loadWorker({
      lifecycle: [],
      hintCalls: failureCalls,
      memoryWriteHints: [hint(sessionId, 200, 'failure')],
      workerResult: {
        ...workerResult(),
        inserted: 1,
        insertedIds: ['partial-record'],
        extractionError: { kind: 'max_tokens', maxTokens: 64_000 }
      }
    })
    await failureWorker.runPostSessionWorker(writeWorkerInput('failed-hints', {
      hook_event_name: 'SessionEnd',
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd: storageRoot
    }))
    expect(failureCalls.deleted).toEqual([])

    const recordFailureCalls = calls()
    const recordFailureWorker = await loadWorker({
      lifecycle: [],
      hintCalls: recordFailureCalls,
      memoryWriteHints: [hint(sessionId, 300, 'record-failure')],
      workerResult: {
        ...workerResult('no_records'),
        failed: 1
      }
    })
    await recordFailureWorker.runPostSessionWorker(writeWorkerInput('record-failed-hints', {
      hook_event_name: 'SessionEnd',
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd: storageRoot
    }))
    expect(recordFailureCalls.deleted).toEqual([])
  })

  it('retains hints when the extraction run log cannot be persisted', async () => {
    const sessionId = 'unsaved-hint-session'
    const transcriptPath = path.join(storageRoot, 'unsaved-hint-transcript.jsonl')
    await fs.writeFile(transcriptPath, '{"type":"user","message":"hello"}\n')
    const hintCalls = calls()
    const { runPostSessionWorker } = await loadWorker({
      lifecycle: [],
      hintCalls,
      memoryWriteHints: [hint(sessionId, 100, 'unsaved')],
      workerResult: workerResult('no_records'),
      saveRunSucceeds: false
    })

    await runPostSessionWorker(writeWorkerInput('unsaved-hints', {
      hook_event_name: 'SessionEnd',
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd: storageRoot
    }))

    expect(savedRuns).toHaveLength(1)
    expect(hintCalls.deleted).toEqual([])
  })

  it('deletes on terminal clear and explicit skip but retains on missing transcript or lock contention', async () => {
    const transcriptPath = path.join(storageRoot, 'skip-hint-transcript.jsonl')
    await fs.writeFile(transcriptPath, `${SKIP_EXTRACTION_MARKER}\n`)

    const clearCalls = calls()
    const clearWorker = await loadWorker({
      lifecycle: [],
      hintCalls: clearCalls,
      memoryWriteHints: [hint('clear-hints', 100, 'clear')],
      workerResult: workerResult('no_records')
    })
    await clearWorker.runPostSessionWorker(writeWorkerInput('clear-hints', {
      hook_event_name: 'SessionEnd',
      session_id: 'clear-hints',
      transcript_path: transcriptPath,
      cwd: storageRoot,
      reason: 'clear'
    }))
    expect(clearCalls.deleted).toEqual(['clear-hints'])

    const skipCalls = calls()
    const skipWorker = await loadWorker({
      lifecycle: [],
      hintCalls: skipCalls,
      memoryWriteHints: [hint('skip-hints', 100, 'skip')],
      workerResult: workerResult('no_records')
    })
    await skipWorker.runPostSessionWorker(writeWorkerInput('skip-hints', {
      hook_event_name: 'SessionEnd',
      session_id: 'skip-hints',
      transcript_path: transcriptPath,
      cwd: storageRoot
    }))
    expect(skipCalls.deleted).toEqual(['skip-hints'])

    const missingCalls = calls()
    const missingWorker = await loadWorker({
      lifecycle: [],
      hintCalls: missingCalls,
      memoryWriteHints: [hint('missing-hints', 100, 'missing')],
      workerResult: workerResult('no_records')
    })
    await missingWorker.runPostSessionWorker(writeWorkerInput('missing-hints', {
      hook_event_name: 'SessionEnd',
      session_id: 'missing-hints',
      cwd: storageRoot
    }))
    expect(missingCalls.deleted).toEqual([])

    const lockedSession = 'locked-hints'
    const lockPath = path.join(storageRoot, 'locks', `${lockedSession}.lock`)
    nodeFs.mkdirSync(path.dirname(lockPath), { recursive: true })
    nodeFs.writeFileSync(lockPath, `${process.pid}\n${Date.now()}`)
    const lockCalls = calls()
    const lockWorker = await loadWorker({
      lifecycle: [],
      hintCalls: lockCalls,
      memoryWriteHints: [hint(lockedSession, 100, 'locked')],
      workerResult: workerResult('no_records')
    })
    await lockWorker.runPostSessionWorker(writeWorkerInput('locked-hints', {
      hook_event_name: 'SessionEnd',
      session_id: lockedSession,
      transcript_path: path.join(storageRoot, 'unused-transcript.jsonl'),
      cwd: storageRoot
    }))
    expect(lockCalls.deleted).toEqual([])
  })

  it('does not pass stored hints when the setting is disabled', async () => {
    const sessionId = 'disabled-hints'
    const transcriptPath = path.join(storageRoot, 'disabled-hints-transcript.jsonl')
    await fs.writeFile(transcriptPath, '{"type":"user","message":"hello"}\n')
    const hintCalls = calls()
    const handleCalls: unknown[][] = []
    const { runPostSessionWorker } = await loadWorker({
      lifecycle: [],
      hintCalls,
      handleCalls,
      hintsEnabled: false,
      memoryWriteHints: [hint(sessionId, 100, 'disabled')],
      workerResult: workerResult('no_records')
    })

    await runPostSessionWorker(writeWorkerInput('disabled-hints', {
      hook_event_name: 'SessionEnd',
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd: storageRoot
    }))

    expect((handleCalls[0][2] as { memoryWriteHints?: MemoryWriteHintEvent[] }).memoryWriteHints)
      .toEqual([])
    expect(hintCalls.deleted).toEqual([sessionId])
  })
})

describe('post-session worker self-update wiring', () => {
  it('runs self-update exactly once and last after every early-return class', async () => {
    const transcriptPath = path.join(storageRoot, 'transcript.jsonl')
    await fs.writeFile(transcriptPath, '{"type":"user","message":"hello"}\n')
    const validPayload = {
      hook_event_name: 'SessionEnd',
      session_id: 'early-return-session',
      transcript_path: transcriptPath,
      cwd: storageRoot
    }
    const scenarios: Array<{
      name: string
      input: () => string | undefined
      result?: unknown
    }> = [
      { name: 'no argument', input: () => undefined },
      {
        name: 'missing input file',
        input: () => path.join(storageRoot, 'does-not-exist.json')
      },
      { name: 'empty input', input: () => writeWorkerInput('empty', '') },
      { name: 'invalid JSON', input: () => writeWorkerInput('invalid', '{') },
      {
        name: 'unexpected event',
        input: () => writeWorkerInput('wrong-event', {
          ...validPayload,
          hook_event_name: 'UserPromptSubmit'
        })
      },
      {
        name: 'worker lock held',
        input: () => {
          const lockPath = path.join(storageRoot, 'locks', 'locked-session.lock')
          nodeFs.mkdirSync(path.dirname(lockPath), { recursive: true })
          nodeFs.writeFileSync(lockPath, `${process.pid}\n${Date.now()}`)
          return writeWorkerInput('locked', {
            ...validPayload,
            session_id: 'locked-session'
          })
        }
      },
      {
        name: 'clear event',
        input: () => writeWorkerInput('clear', {
          ...validPayload,
          session_id: 'clear-session',
          reason: 'clear'
        })
      },
      {
        name: 'missing transcript path',
        input: () => writeWorkerInput('no-transcript-path', {
          ...validPayload,
          session_id: 'no-transcript-session',
          transcript_path: undefined
        })
      },
      {
        name: 'skip marker',
        input: () => {
          const markedTranscript = path.join(storageRoot, 'skip-transcript.jsonl')
          nodeFs.writeFileSync(markedTranscript, `${SKIP_EXTRACTION_MARKER}\n`)
          return writeWorkerInput('skip-marker', {
            ...validPayload,
            session_id: 'skip-marker-session',
            transcript_path: markedTranscript
          })
        }
      },
      {
        name: 'null extraction result',
        input: () => writeWorkerInput('null-result', {
          ...validPayload,
          session_id: 'null-result-session'
        }),
        result: null
      },
      {
        name: 'handler no transcript',
        input: () => writeWorkerInput('handler-no-transcript', {
          ...validPayload,
          session_id: 'handler-no-transcript-session'
        }),
        result: workerResult('no_transcript')
      },
      {
        name: 'handler no new events',
        input: () => writeWorkerInput('handler-no-events', {
          ...validPayload,
          session_id: 'handler-no-events-session'
        }),
        result: workerResult('no_new_events')
      },
      {
        name: 'handler no records',
        input: () => writeWorkerInput('handler-no-records', {
          ...validPayload,
          session_id: 'handler-no-records-session'
        }),
        result: workerResult('no_records')
      }
    ]

    for (const scenario of scenarios) {
      const lifecycle: string[] = []
      const loadOptions: Parameters<typeof loadWorker>[0] = { lifecycle }
      if (Object.prototype.hasOwnProperty.call(scenario, 'result')) {
        loadOptions.workerResult = scenario.result
      }
      const { runPostSessionWorker } = await loadWorker(loadOptions)

      await runPostSessionWorker(scenario.input())

      expect(lifecycle, scenario.name).toEqual(['close', 'self-update'])
      expect(
        lifecycle.filter(event => event === 'self-update'),
        scenario.name
      ).toHaveLength(1)
      expect(selfUpdateCallArguments, scenario.name).toEqual([
        [{ trigger: 'auto' }]
      ])
    }
  })

  it('runs self-update after extraction cleanup and both periodic jobs', async () => {
    const lifecycle: string[] = []
    const sessionId = 'ordered-session'
    const inputPath = writeWorkerInput('ordered', {
      hook_event_name: 'SessionEnd',
      session_id: sessionId,
      transcript_path: path.join(storageRoot, 'ordered-transcript.jsonl'),
      cwd: storageRoot
    })
    await fs.writeFile(
      path.join(storageRoot, 'ordered-transcript.jsonl'),
      '{"type":"user","message":"hello"}\n'
    )
    const lockPath = path.join(storageRoot, 'locks', `${sessionId}.lock`)
    const { runPostSessionWorker } = await loadWorker({
      lifecycle,
      workerResult: workerResult(),
      runPeriodicJobs: true,
      onSelfUpdate: () => {
        expect(nodeFs.existsSync(lockPath)).toBe(false)
      }
    })

    await runPostSessionWorker(inputPath)

    expect(lifecycle).toEqual(['maintenance', 'stats', 'close', 'self-update'])
    expect(lifecycle.filter(event => event === 'self-update')).toHaveLength(1)
    expect(selfUpdateCallArguments).toEqual([[{ trigger: 'auto' }]])
  })
})
