import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type InjectedMemoryEntry, type MemoryRecord } from '../src/lib/types.js'
import { createMockDiscoveryRecord } from './helpers.js'

const mocks = vi.hoisted(() => ({
  batchUpdateRecords: vi.fn(),
  fetchRecordsByIds: vi.fn(),
  rateInjectedMemories: vi.fn(),
  removeSessionTracking: vi.fn(),
  sessionMemories: [] as InjectedMemoryEntry[]
}))

vi.mock('../src/lib/lancedb.js', () => ({
  batchUpdateRecords: mocks.batchUpdateRecords,
  closeLanceDB: vi.fn(async () => {}),
  fetchRecordsByIds: mocks.fetchRecordsByIds,
  flushCollection: vi.fn(async () => {}),
  initLanceDB: vi.fn(async () => {})
}))

vi.mock('../src/lib/session-tracking.js', () => ({
  dedupeInjectedMemories: vi.fn((entries: unknown[]) => entries),
  loadSessionTracking: vi.fn(() => ({ memories: mocks.sessionMemories })),
  removeSessionTracking: mocks.removeSessionTracking
}))

vi.mock('../src/lib/extract.js', () => ({
  rateInjectedMemories: mocks.rateInjectedMemories,
  sanitizeExtractionFailure: vi.fn((value: unknown) => value)
}))

import { processUsefulnessRating } from '../src/hooks/post-session-worker.js'

const transcript = {
  messages: [],
  events: [],
  toolCalls: [],
  toolResults: [],
  parseErrors: 0
}

describe('post-session counter batching', () => {
  const records = new Map<string, MemoryRecord>()
  const batches: MemoryRecord[][] = []
  const lifecycle: string[] = []

  beforeEach(() => {
    records.clear()
    batches.length = 0
    lifecycle.length = 0
    vi.clearAllMocks()

    mocks.sessionMemories = [
      { id: 'memory-1', snippet: 'first', injectedAt: 1 },
      { id: 'memory-1', snippet: 'first repeated', injectedAt: 2 },
      { id: 'memory-2', snippet: 'second', injectedAt: 3 }
    ]
    records.set('memory-1', createMockDiscoveryRecord({
      id: 'memory-1',
      retrievalCount: 4,
      usageCount: 2,
      embedding: [0.1, 0.2]
    }))
    records.set('memory-2', createMockDiscoveryRecord({
      id: 'memory-2',
      retrievalCount: 7,
      usageCount: 0,
      embedding: [0.3, 0.4]
    }))

    mocks.fetchRecordsByIds.mockImplementation(async (ids: string[]) => {
      lifecycle.push(`fetch:${ids.join(',')}`)
      return ids
        .map(id => records.get(id))
        .filter((record): record is MemoryRecord => Boolean(record))
        .map(record => ({ ...record, embedding: [...(record.embedding ?? [])] }))
    })
    mocks.batchUpdateRecords.mockImplementation(async (updatedRecords: MemoryRecord[], updates: Partial<MemoryRecord>) => {
      lifecycle.push(`batch:${updatedRecords.some(record => record.usageCount === 3) ? 'usage' : 'retrieval'}`)
      expect(updates).toEqual({})
      batches.push(updatedRecords.map(record => ({
        ...record,
        embedding: record.embedding ? [...record.embedding] : undefined
      })))
      for (const record of updatedRecords) {
        records.set(record.id, {
          ...record,
          embedding: record.embedding ? [...record.embedding] : undefined
        })
      }
      return { updated: updatedRecords.length, failed: 0 }
    })
    mocks.rateInjectedMemories.mockImplementation(async () => {
      lifecycle.push('rate')
      return {
        helpfulIds: ['memory-1'],
        tokenUsage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0
        }
      }
    })
  })

  it('uses one retrieval batch and a later refetched usefulness batch without dropping embeddings', async () => {
    const result = await processUsefulnessRating({
      hook_event_name: 'SessionEnd',
      session_id: 'batch-session',
      transcript_path: '/unused/transcript.jsonl',
      cwd: '/tmp/project'
    }, DEFAULT_CONFIG, transcript)

    expect(result).toMatchObject({ updated: true, ran: true })
    expect(lifecycle).toEqual([
      'fetch:memory-1,memory-2',
      'batch:retrieval',
      'rate',
      'fetch:memory-1',
      'batch:usage'
    ])
    expect(mocks.fetchRecordsByIds).toHaveBeenNthCalledWith(
      1,
      ['memory-1', 'memory-2'],
      DEFAULT_CONFIG,
      { includeEmbeddings: true }
    )
    expect(mocks.fetchRecordsByIds).toHaveBeenNthCalledWith(
      2,
      ['memory-1'],
      DEFAULT_CONFIG,
      { includeEmbeddings: true }
    )
    expect(batches).toHaveLength(2)
    expect(batches[0]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'memory-1',
        retrievalCount: 6,
        usageCount: 2,
        embedding: [0.1, 0.2],
        lastUsed: expect.any(Number)
      }),
      expect.objectContaining({
        id: 'memory-2',
        retrievalCount: 8,
        usageCount: 0,
        embedding: [0.3, 0.4],
        lastUsed: expect.any(Number)
      })
    ]))
    expect(batches[1]).toEqual([
      expect.objectContaining({
        id: 'memory-1',
        retrievalCount: 6,
        usageCount: 3,
        embedding: [0.1, 0.2],
        lastUsed: expect.any(Number)
      })
    ])
    expect(mocks.batchUpdateRecords).toHaveBeenNthCalledWith(
      1,
      expect.any(Array),
      {},
      DEFAULT_CONFIG,
      { continueOnBatchError: true }
    )
    expect(mocks.batchUpdateRecords).toHaveBeenNthCalledWith(
      2,
      expect.any(Array),
      {},
      DEFAULT_CONFIG,
      { continueOnBatchError: true }
    )
    expect(mocks.removeSessionTracking).toHaveBeenCalledWith('batch-session', DEFAULT_CONFIG.lancedb.table)
  })

  it('skips missing record IDs without fabricating an update', async () => {
    mocks.sessionMemories = [{ id: 'missing-memory', snippet: 'missing', injectedAt: 1 }]
    mocks.rateInjectedMemories.mockResolvedValueOnce({
      helpfulIds: [],
      tokenUsage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0
      }
    })

    const result = await processUsefulnessRating({
      hook_event_name: 'SessionEnd',
      session_id: 'missing-session',
      transcript_path: '/unused/transcript.jsonl',
      cwd: '/tmp/project'
    }, DEFAULT_CONFIG, transcript)

    expect(result).toMatchObject({ updated: false, ran: true })
    expect(mocks.fetchRecordsByIds).toHaveBeenCalledWith(
      ['missing-memory'],
      DEFAULT_CONFIG,
      { includeEmbeddings: true }
    )
    expect(mocks.batchUpdateRecords).not.toHaveBeenCalled()
    expect(mocks.rateInjectedMemories).toHaveBeenCalledTimes(1)
  })

  it('preserves a row-preparation failure cause while continuing usefulness rating', async () => {
    mocks.sessionMemories = [{ id: 'memory-1', snippet: 'first', injectedAt: 1 }]
    const preparationError = new Error('embedding vector was not preserved')
    mocks.batchUpdateRecords.mockResolvedValueOnce({
      updated: 0,
      failed: 1,
      failures: [{ recordIds: ['memory-1'], stage: 'prepare', error: preparationError }]
    })
    mocks.rateInjectedMemories.mockResolvedValueOnce({
      helpfulIds: [],
      tokenUsage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0
      }
    })
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await processUsefulnessRating({
      hook_event_name: 'SessionEnd',
      session_id: 'preparation-failure-session',
      transcript_path: '/unused/transcript.jsonl',
      cwd: '/tmp/project'
    }, DEFAULT_CONFIG, transcript)

    expect(result).toMatchObject({ updated: false, ran: true })
    expect(mocks.rateInjectedMemories).toHaveBeenCalledTimes(1)
    const loggedFailure = errorLog.mock.calls.find(call => call[0] === '[claude-memory] Failed to update retrieval counts:')?.[1]
    expect(loggedFailure).toBeInstanceOf(AggregateError)
    expect((loggedFailure as AggregateError).errors).toContain(preparationError)
    expect((loggedFailure as Error).message).toContain('embedding vector was not preserved')
  })
})
