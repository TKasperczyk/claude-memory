import nodeFs from 'fs'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type ExtractionHookInput, type TokenUsage } from '../src/lib/types.js'
import { createMockDiscoveryRecord } from './helpers.js'

let storageRoot = ''
const savedRuns: unknown[] = []

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
} = {}): Promise<typeof import('../src/hooks/post-session-worker.js')> {
  vi.resetModules()
  savedRuns.length = 0
  vi.doMock('../src/lib/paths.js', () => ({
    CLAUDE_MEMORY_ROOT: storageRoot,
    DEBUG_LOG_FILE: path.join(storageRoot, 'debug.log'),
    LOCKS_DIR: path.join(storageRoot, 'locks')
  }))
  vi.doMock('../src/lib/extraction-log.js', async () => {
    const actual = await vi.importActual<typeof import('../src/lib/extraction-log.js')>('../src/lib/extraction-log.js')
    return {
      ...actual,
      getLastExtractionRunForSession: vi.fn(),
      listInProgressExtractions: vi.fn(() => []),
      saveExtractionRun: vi.fn((run: unknown) => {
        savedRuns.push(run)
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

beforeEach(async () => {
  storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-memory-worker-'))
})

afterEach(async () => {
  vi.doUnmock('../src/lib/paths.js')
  vi.doUnmock('../src/lib/extraction-log.js')
  vi.doUnmock('../src/lib/session-tracking.js')
  vi.doUnmock('../src/lib/extract.js')
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
      extractedRecordIds?: string[]
      updatedRecordIds?: string[]
      extractedRecords?: Array<Record<string, unknown>>
    }
    expect(saved.recordCount).toBe(2)
    expect(saved.skippedRecordCount).toBe(1)
    expect(saved.failedRecordCount).toBe(1)
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
