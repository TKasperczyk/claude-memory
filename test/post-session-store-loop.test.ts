import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMBEDDING_DIM, type DiscoveryRecord, type TokenUsage } from '../src/lib/types.js'
import { handlePostSession } from '../src/hooks/post-session.js'
import { extractRecords } from '../src/lib/extract.js'
import { findSimilar, insertRecord, updateRecord } from '../src/lib/lancedb.js'
import { markDeprecated } from '../src/lib/maintenance/operations.js'
import { DEFAULT_CONFIG } from '../src/lib/types.js'
import { cleanupTempFiles, createMockDiscoveryRecord, createMockTranscript } from './helpers.js'
import { TEST_PROJECT } from './config.js'

process.env.CC_MEMORIES_SETTING_EXTRACTION_MIN_TOKENS = '0'

vi.mock('../src/lib/extract.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/extract.js')>('../src/lib/extract.js')
  return {
    ...actual,
    extractRecords: vi.fn()
  }
})

vi.mock('../src/lib/lancedb.js', () => ({
  buildEmbeddingInput: vi.fn(() => ''),
  escapeFilterValue: vi.fn((value: string) => value.replace(/'/g, "''")),
  findSimilar: vi.fn(),
  insertRecord: vi.fn(),
  updateRecord: vi.fn()
}))

vi.mock('../src/lib/maintenance/operations.js', () => ({
  markDeprecated: vi.fn()
}))

const mockedExtractRecords = vi.mocked(extractRecords)
const mockedFindSimilar = vi.mocked(findSimilar)
const mockedInsertRecord = vi.mocked(insertRecord)
const mockedUpdateRecord = vi.mocked(updateRecord)
const mockedMarkDeprecated = vi.mocked(markDeprecated)

function makeEmbedding(index: number): number[] {
  const embedding = new Array<number>(EMBEDDING_DIM).fill(0)
  embedding[index] = 1
  return embedding
}

function emptyUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0
  }
}

function transcriptPath(): string {
  return createMockTranscript([
    { type: 'user', message: { role: 'user', content: 'extract durable facts' } },
    { type: 'assistant', message: { role: 'assistant', content: 'done' } }
  ])
}

function extractionInput(transcript_path: string) {
  return {
    hook_event_name: 'SessionEnd' as const,
    session_id: 'store-loop-session',
    transcript_path,
    cwd: TEST_PROJECT,
    reason: 'prompt_input_exit'
  }
}

describe('handlePostSession store outcomes', () => {
  beforeEach(() => {
    mockedExtractRecords.mockReset()
    mockedFindSimilar.mockReset()
    mockedInsertRecord.mockReset()
    mockedUpdateRecord.mockReset()
    mockedMarkDeprecated.mockReset()
    mockedFindSimilar.mockResolvedValue([])
    mockedInsertRecord.mockResolvedValue(undefined)
    mockedUpdateRecord.mockResolvedValue(true)
    mockedMarkDeprecated.mockResolvedValue(true)
  })

  afterEach(() => {
    cleanupTempFiles()
  })

  it('records inserted, updated, skipped, and failed outcomes with only skipped dedup IDs excluded', async () => {
    const inserted = createMockDiscoveryRecord({ id: 'extracted-insert', embedding: makeEmbedding(0) })
    const updated = createMockDiscoveryRecord({ id: 'extracted-update', evidence: 'new evidence', embedding: makeEmbedding(1) })
    const skipped = createMockDiscoveryRecord({ id: 'extracted-skip', embedding: makeEmbedding(2) })
    const failed = createMockDiscoveryRecord({ id: 'extracted-fail', embedding: makeEmbedding(3) })
    const existingUpdate: DiscoveryRecord = createMockDiscoveryRecord({
      id: 'existing-update',
      evidence: '',
      embedding: makeEmbedding(4)
    })
    const existingSkip: DiscoveryRecord = createMockDiscoveryRecord({
      id: 'existing-skip',
      what: skipped.what,
      where: skipped.where,
      evidence: skipped.evidence,
      project: skipped.project,
      embedding: makeEmbedding(5)
    })

    mockedExtractRecords.mockResolvedValueOnce({
      records: [inserted, updated, skipped, failed],
      tokenUsage: emptyUsage()
    })
    mockedFindSimilar
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ record: existingUpdate, similarity: 0.87654 }])
      .mockResolvedValueOnce([{ record: existingSkip, similarity: 0.76543 }])
      .mockResolvedValueOnce([])
    mockedInsertRecord
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('insert failed\nstack details'))

    const result = await handlePostSession(extractionInput(transcriptPath()), DEFAULT_CONFIG)

    expect(result.inserted).toBe(1)
    expect(result.updated).toBe(1)
    expect(result.skipped).toBe(1)
    expect(result.failed).toBe(1)
    expect(result.insertedIds).toEqual(['extracted-insert'])
    expect(result.updatedIds).toEqual(['existing-update'])
    expect(result.recordOutcomes).toEqual([
      {
        id: 'extracted-insert',
        outcome: 'inserted',
        storedRecordId: 'extracted-insert'
      },
      {
        id: 'extracted-update',
        outcome: 'updated',
        storedRecordId: 'existing-update',
        dedupSimilarity: 0.877
      },
      {
        id: 'extracted-skip',
        outcome: 'skipped',
        storedRecordId: 'existing-skip',
        dedupSimilarity: 0.765
      },
      {
        id: 'extracted-fail',
        outcome: 'failed',
        storeError: 'insert failed'
      }
    ])
  })

  it('treats updateRecord false as a failed non-persisted record', async () => {
    const incoming = createMockDiscoveryRecord({ id: 'extracted-update-false', evidence: 'new evidence', embedding: makeEmbedding(6) })
    const existing = createMockDiscoveryRecord({ id: 'existing-vanished', evidence: '', embedding: makeEmbedding(7) })
    mockedExtractRecords.mockResolvedValueOnce({ records: [incoming], tokenUsage: emptyUsage() })
    mockedFindSimilar.mockResolvedValueOnce([{ record: existing, similarity: 0.91 }])
    mockedUpdateRecord.mockResolvedValueOnce(false)

    const result = await handlePostSession(extractionInput(transcriptPath()), DEFAULT_CONFIG)

    expect(result.updated).toBe(0)
    expect(result.failed).toBe(1)
    expect(result.updatedIds).toEqual([])
    expect(result.recordOutcomes).toEqual([{
      id: 'extracted-update-false',
      outcome: 'failed',
      storeError: 'record disappeared during update'
    }])
  })

  it('keeps inserted outcome when supersedes persistence throws after insert', async () => {
    const incoming = createMockDiscoveryRecord({
      id: 'extracted-post-store-error',
      supersedes: 'old-record',
      embedding: makeEmbedding(8)
    })
    mockedExtractRecords.mockResolvedValueOnce({ records: [incoming], tokenUsage: emptyUsage() })
    mockedFindSimilar.mockResolvedValueOnce([])
    mockedMarkDeprecated.mockRejectedValueOnce(new Error('deprecation write failed\nstack details'))

    const result = await handlePostSession(extractionInput(transcriptPath()), DEFAULT_CONFIG)

    expect(result.inserted).toBe(1)
    expect(result.failed).toBe(1)
    expect(result.recordOutcomes).toEqual([{
      id: 'extracted-post-store-error',
      outcome: 'inserted',
      storedRecordId: 'extracted-post-store-error',
      storeError: 'deprecation write failed'
    }])
  })
})
