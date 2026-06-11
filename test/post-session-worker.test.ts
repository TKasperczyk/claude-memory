import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExtractionHookInput, TokenUsage } from '../src/lib/types.js'

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

async function loadWorker(): Promise<typeof import('../src/hooks/post-session-worker.js')> {
  vi.resetModules()
  savedRuns.length = 0
  vi.doMock('../src/lib/paths.js', () => ({
    CLAUDE_MEMORY_ROOT: storageRoot,
    DEBUG_LOG_FILE: path.join(storageRoot, 'debug.log'),
    LOCKS_DIR: path.join(storageRoot, 'locks')
  }))
  vi.doMock('../src/lib/extraction-log.js', () => ({
    getLastExtractionRunForSession: vi.fn(),
    listInProgressExtractions: vi.fn(() => []),
    saveExtractionRun: vi.fn((run: unknown) => {
      savedRuns.push(run)
    })
  }))
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
  vi.resetModules()
  await fs.rm(storageRoot, { recursive: true, force: true })
})

describe('post-session worker run saving', () => {
  it('saves true failures without skipReason or checkpoint and logs FAILED', async () => {
    const { saveRunLog } = await loadWorker()

    saveRunLog(payload, {
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
    }, 123, tokenUsage, 'test-collection')

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

    saveRunLog(payload, {
      inserted: 1,
      updated: 0,
      skipped: 0,
      failed: 0,
      records: [],
      insertedIds: ['record-1'],
      updatedIds: [],
      extractedEventCount: 43,
      extractionError: { kind: 'max_tokens', maxTokens: 64000 }
    }, 456, tokenUsage, 'test-collection')

    expect(savedRuns).toHaveLength(1)
    const saved = savedRuns[0] as { recordCount?: number; extractedEventCount?: number; skipReason?: string }
    expect(saved.recordCount).toBe(1)
    expect(saved.extractedEventCount).toBe(43)
    expect(saved.skipReason).toBeUndefined()
    const audit = await readAuditLog()
    expect(audit).toContain('DONE session=worker-session')
    expect(audit).toContain('error=max_tokens')
  })

  it('preserves clean no_records skipReason and checkpoint behavior', async () => {
    const { saveRunLog } = await loadWorker()

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
    }, 789, tokenUsage, 'test-collection')

    expect(savedRuns).toHaveLength(1)
    const saved = savedRuns[0] as { skipReason?: string; extractedEventCount?: number; error?: unknown }
    expect(saved.skipReason).toBe('no_records')
    expect(saved.extractedEventCount).toBe(44)
    expect(saved.error).toBeUndefined()
    expect(await readAuditLog()).toContain('DONE session=worker-session')
  })
})
