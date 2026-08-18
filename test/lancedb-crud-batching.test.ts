import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type MemoryRecord } from '../src/lib/types.js'
import { createMockDiscoveryRecord } from './helpers.js'

const mocks = vi.hoisted(() => ({
  buildLanceRow: vi.fn(),
  ensureClient: vi.fn()
}))

vi.mock('../src/lib/lancedb-client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/lancedb-client.js')>('../src/lib/lancedb-client.js')
  return { ...actual, ensureClient: mocks.ensureClient }
})

vi.mock('../src/lib/lancedb-records.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/lancedb-records.js')>('../src/lib/lancedb-records.js')
  return { ...actual, buildLanceRow: mocks.buildLanceRow }
})

import { batchUpdateRecords } from '../src/lib/lancedb-crud.js'

describe('batchUpdateRecords best-effort chunking', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('attempts later chunks and retains the original execute failure', async () => {
    const executeFailure = new Error('first chunk merge failed')
    const execute = vi.fn()
      .mockRejectedValueOnce(executeFailure)
      .mockResolvedValueOnce(undefined)
    const merge = {
      execute,
      whenMatchedUpdateAll: vi.fn(),
      whenNotMatchedInsertAll: vi.fn()
    }
    merge.whenMatchedUpdateAll.mockReturnValue(merge)
    merge.whenNotMatchedInsertAll.mockReturnValue(merge)
    const table = { mergeInsert: vi.fn(() => merge) }
    mocks.ensureClient.mockResolvedValue({ table })
    mocks.buildLanceRow.mockImplementation(async (record: MemoryRecord) => ({ id: record.id }))
    const records = Array.from({ length: 501 }, (_, index) => createMockDiscoveryRecord({
      id: `memory-${index}`,
      embedding: [index]
    }))

    const result = await batchUpdateRecords(
      records,
      {},
      DEFAULT_CONFIG,
      { continueOnBatchError: true }
    )

    expect(execute).toHaveBeenCalledTimes(2)
    expect(execute.mock.calls[0]?.[0]).toHaveLength(500)
    expect(execute.mock.calls[1]?.[0]).toEqual([{ id: 'memory-500' }])
    expect(result.updated).toBe(1)
    expect(result.failed).toBe(500)
    expect(result.failures).toEqual([{
      recordIds: records.slice(0, 500).map(record => record.id),
      stage: 'execute',
      error: executeFailure
    }])
  })

  it('retains a row-preparation cause while updating other rows', async () => {
    const preparationFailure = new Error('invalid preserved embedding')
    const execute = vi.fn(async () => {})
    const merge = {
      execute,
      whenMatchedUpdateAll: vi.fn(),
      whenNotMatchedInsertAll: vi.fn()
    }
    merge.whenMatchedUpdateAll.mockReturnValue(merge)
    merge.whenNotMatchedInsertAll.mockReturnValue(merge)
    mocks.ensureClient.mockResolvedValue({ table: { mergeInsert: vi.fn(() => merge) } })
    mocks.buildLanceRow.mockImplementation(async (record: MemoryRecord) => {
      if (record.id === 'bad-memory') throw preparationFailure
      return { id: record.id }
    })
    const records = [
      createMockDiscoveryRecord({ id: 'bad-memory', embedding: [0.1] }),
      createMockDiscoveryRecord({ id: 'good-memory', embedding: [0.2] })
    ]

    const result = await batchUpdateRecords(
      records,
      {},
      DEFAULT_CONFIG,
      { continueOnBatchError: true }
    )

    expect(execute).toHaveBeenCalledWith([{ id: 'good-memory' }])
    expect(result).toEqual({
      updated: 1,
      failed: 1,
      failures: [{
        recordIds: ['bad-memory'],
        stage: 'prepare',
        error: preparationFailure
      }]
    })
  })
})
