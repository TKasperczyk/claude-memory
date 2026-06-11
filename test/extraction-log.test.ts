import { randomUUID } from 'crypto'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getRunStatus, isTrueExtractionFailure } from '../src/lib/extraction-status.js'
import type { ExtractionRun } from '../shared/types.js'

let storageRoot = ''

async function loadExtractionLog(): Promise<typeof import('../src/lib/extraction-log.js')> {
  vi.resetModules()
  vi.doMock('../src/lib/paths.js', () => ({
    CLAUDE_MEMORY_ROOT: storageRoot,
    DEBUG_LOG_FILE: path.join(storageRoot, 'debug.log'),
    LOCKS_DIR: path.join(storageRoot, 'locks')
  }))
  return await import('../src/lib/extraction-log.js')
}

function buildRun(overrides: Partial<ExtractionRun> = {}): ExtractionRun {
  return {
    runId: randomUUID(),
    sessionId: 'session-1',
    transcriptPath: '/tmp/transcript.jsonl',
    timestamp: Date.now(),
    recordCount: 0,
    parseErrorCount: 0,
    extractedRecordIds: [],
    duration: 0,
    ...overrides
  }
}

beforeEach(async () => {
  storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-memory-extraction-log-'))
})

afterEach(async () => {
  vi.doUnmock('../src/lib/paths.js')
  vi.resetModules()
  await fs.rm(storageRoot, { recursive: true, force: true })
})

describe('extraction run log', () => {
  it('round-trips api_error requestId through persistence coercion', async () => {
    const { saveExtractionRun, getExtractionRun } = await loadExtractionLog()
    const collection = `extraction-log-${randomUUID()}`
    const run = buildRun({
      runId: 'run-request-id',
      error: {
        kind: 'api_error',
        status: 529,
        code: 'api_error',
        message: 'Internal server error',
        requestId: 'req_round_trip'
      }
    })

    saveExtractionRun(run, collection)

    const loaded = getExtractionRun(run.runId, collection)
    expect(loaded?.error).toEqual({
      kind: 'api_error',
      status: 529,
      code: 'api_error',
      message: 'Internal server error',
      requestId: 'req_round_trip'
    })
  })

  it('round-trips extraction record outcomes and persisted skipped/failed counts', async () => {
    const { saveExtractionRun, getExtractionRun } = await loadExtractionLog()
    const collection = `extraction-log-${randomUUID()}`
    const run = buildRun({
      runId: 'run-outcomes',
      recordCount: 1,
      skippedRecordCount: 1,
      failedRecordCount: 1,
      extractedRecordIds: ['inserted-record'],
      extractedRecords: [
        {
          id: 'extracted-insert',
          type: 'discovery',
          summary: 'Inserted summary',
          timestamp: 123,
          outcome: 'inserted',
          storedRecordId: 'inserted-record'
        },
        {
          id: 'extracted-skip',
          type: 'command',
          summary: 'Skipped summary',
          outcome: 'skipped',
          storedRecordId: 'existing-record',
          dedupSimilarity: 0.87654
        },
        {
          id: 'extracted-failed',
          type: 'error',
          summary: 'Failed summary',
          outcome: 'failed',
          storeError: 'store failed'
        }
      ]
    })

    saveExtractionRun(run, collection)

    const loaded = getExtractionRun(run.runId, collection)
    expect(loaded?.skippedRecordCount).toBe(1)
    expect(loaded?.failedRecordCount).toBe(1)
    expect(loaded?.extractedRecords).toEqual([
      {
        id: 'extracted-insert',
        type: 'discovery',
        summary: 'Inserted summary',
        timestamp: 123,
        outcome: 'inserted',
        storedRecordId: 'inserted-record'
      },
      {
        id: 'extracted-skip',
        type: 'command',
        summary: 'Skipped summary',
        outcome: 'skipped',
        storedRecordId: 'existing-record',
        dedupSimilarity: 0.877
      },
      {
        id: 'extracted-failed',
        type: 'error',
        summary: 'Failed summary',
        outcome: 'failed',
        storeError: 'store failed'
      }
    ])
  })

  it('leaves new outcome/count fields undefined for legacy runs', async () => {
    const { getExtractionRun } = await loadExtractionLog()
    const collection = `extractionlog${randomUUID().replace(/-/g, '')}`
    const runId = 'legacy-no-outcomes'
    const collectionDir = path.join(storageRoot, 'extractions', collection)
    await fs.mkdir(collectionDir, { recursive: true })
    await fs.writeFile(path.join(collectionDir, `${runId}.json`), JSON.stringify({
      runId,
      sessionId: 'legacy-session',
      transcriptPath: '/tmp/transcript.jsonl',
      timestamp: Date.now(),
      recordCount: 1,
      parseErrorCount: 0,
      extractedRecordIds: ['record-a'],
      extractedRecords: [{
        id: 'record-a',
        type: 'command',
        summary: 'Legacy summary'
      }],
      duration: 0
    }))

    const loaded = getExtractionRun(runId, collection)
    expect(loaded?.skippedRecordCount).toBeUndefined()
    expect(loaded?.failedRecordCount).toBeUndefined()
    expect(loaded?.extractedRecords).toEqual([{
      id: 'record-a',
      type: 'command',
      summary: 'Legacy summary',
      timestamp: undefined,
      outcome: undefined,
      storedRecordId: undefined,
      dedupSimilarity: undefined,
      storeError: undefined
    }])
  })

  it('uses clean no_records and partial-success runs as checkpoints but skips true failures', async () => {
    const { saveExtractionRun, getLastExtractionRunForSession } = await loadExtractionLog()
    const collection = `extraction-log-${randomUUID()}`
    const sessionId = 'checkpoint-session'
    const now = Date.now()

    saveExtractionRun(buildRun({
      runId: 'clean-no-records',
      sessionId,
      timestamp: now,
      skipReason: 'no_records',
      extractedEventCount: 10
    }), collection)
    saveExtractionRun(buildRun({
      runId: 'legacy-failed',
      sessionId,
      timestamp: now + 1,
      extractedEventCount: 11,
      error: { kind: 'api_error', message: 'upstream failed' }
    }), collection)

    expect(getLastExtractionRunForSession(sessionId, collection)?.runId).toBe('clean-no-records')

    saveExtractionRun(buildRun({
      runId: 'partial-success',
      sessionId,
      timestamp: now + 2,
      recordCount: 1,
      extractedRecordIds: ['record-1'],
      extractedEventCount: 12,
      error: { kind: 'max_tokens', maxTokens: 64000 }
    }), collection)

    expect(getLastExtractionRunForSession(sessionId, collection)?.runId).toBe('partial-success')
  })

  it('derives missing recordCount from the unique persisted ID union', async () => {
    const { getExtractionRun, getLastExtractionRunForSession } = await loadExtractionLog()
    const collection = `extractionlog${randomUUID().replace(/-/g, '')}`
    const sessionId = 'missing-record-count-session'
    const runId = 'missing-record-count'
    const collectionDir = path.join(storageRoot, 'extractions', collection)
    await fs.mkdir(collectionDir, { recursive: true })
    await fs.writeFile(path.join(collectionDir, `${runId}.json`), JSON.stringify({
      runId,
      sessionId,
      transcriptPath: '/tmp/transcript.jsonl',
      timestamp: Date.now(),
      parseErrorCount: 0,
      extractedRecordIds: ['record-a', 'record-b'],
      updatedRecordIds: ['record-b', 'record-c'],
      duration: 0,
      extractedEventCount: 20,
      error: { kind: 'api_error', message: 'partial failure' }
    }))

    const loaded = getExtractionRun(runId, collection)
    expect(loaded?.recordCount).toBe(3)
    expect(isTrueExtractionFailure(loaded?.error, loaded?.recordCount ?? 0)).toBe(false)
    expect(getLastExtractionRunForSession(sessionId, collection)?.runId).toBe(runId)
  })

  it('classifies extraction run display status consistently', () => {
    expect(getRunStatus(buildRun({
      skipReason: 'no_records',
      error: { kind: 'api_error', message: 'upstream failed' }
    }))).toBe('failed')

    expect(getRunStatus(buildRun({
      skipReason: 'no_records'
    }))).toBe('skipped')

    expect(getRunStatus(buildRun({
      recordCount: 1,
      extractedRecordIds: ['record-1'],
      error: { kind: 'max_tokens', maxTokens: 64000 }
    }))).toBe('partial')

    expect(getRunStatus(buildRun())).toBe('completed')
  })
})
