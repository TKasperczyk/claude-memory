import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type MemoryRecord } from '../src/lib/types.js'
import { runRelationDiscovery } from '../src/lib/maintenance/runners/relations.js'
import { batchUpdateRecords, fetchRecordsByIds, iterateRecords } from '../src/lib/lancedb.js'
import { listRetrievalEvents } from '../src/lib/retrieval-events.js'
import { createMockCommandRecord } from './helpers.js'

const mockState = vi.hoisted(() => ({
  records: [] as MemoryRecord[],
  events: [] as ReturnType<typeof listRetrievalEvents>
}))

vi.mock('../src/lib/lancedb.js', () => ({
  batchUpdateRecords: vi.fn(async (records: MemoryRecord[]) => ({ updated: records.length, failed: 0 })),
  fetchRecordsByIds: vi.fn(async (ids: string[]) => {
    const idSet = new Set(ids)
    return mockState.records.filter(record => idSet.has(record.id)).map(record => ({
      ...record,
      relations: record.relations ? record.relations.map(r => ({ ...r })) : undefined
    }))
  }),
  iterateRecords: vi.fn(async function* () {
    for (const record of mockState.records) {
      yield {
        ...record,
        relations: record.relations ? record.relations.map(r => ({ ...r })) : undefined
      }
    }
  })
}))

vi.mock('../src/lib/retrieval-events.js', () => ({
  listRetrievalEvents: vi.fn(() => mockState.events)
}))

function coInject(ids: [string, string], count: number, baseTime: number) {
  for (let i = 0; i < count; i += 1) {
    const groupId = `${ids[0]}-${ids[1]}-${i}`
    mockState.events.push(
      { id: ids[0], type: 'command', timestamp: baseTime + i, groupId, coInjectedIds: ids },
      { id: ids[1], type: 'command', timestamp: baseTime + i, groupId, coInjectedIds: ids }
    )
  }
}

describe('runRelationDiscovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockState.records = []
    mockState.events = []
  })

  it('batches all pair updates into a single batchUpdateRecords call and scans without embeddings', async () => {
    const a = createMockCommandRecord({ id: 'a', command: 'cmd-a' })
    const b = createMockCommandRecord({ id: 'b', command: 'cmd-b' })
    const c = createMockCommandRecord({ id: 'c', command: 'cmd-c' })
    mockState.records = [a, b, c]

    const now = Date.now()
    coInject(['a', 'b'], 4, now)
    coInject(['b', 'c'], 3, now + 100)

    const result = await runRelationDiscovery(false, DEFAULT_CONFIG, { maxRelationsPerRecord: 50 })

    expect(result.summary).toMatchObject({ eligiblePairs: 2, updated: 3, errors: 0 })
    expect(batchUpdateRecords).toHaveBeenCalledTimes(1)
    expect(iterateRecords).toHaveBeenCalledWith({ includeEmbeddings: false }, DEFAULT_CONFIG)
    expect(fetchRecordsByIds).toHaveBeenNthCalledWith(
      1,
      expect.arrayContaining(['a', 'b', 'c']),
      DEFAULT_CONFIG,
      { includeEmbeddings: false }
    )
    expect(fetchRecordsByIds).toHaveBeenNthCalledWith(
      2,
      expect.arrayContaining(['a', 'b', 'c']),
      DEFAULT_CONFIG,
      { includeEmbeddings: true }
    )
  })

  it('skips phantom writes and actions when capRelatesToRelations immediately evicts a new weaker edge', async () => {
    const now = Date.now()
    const iso = new Date(now + 4).toISOString()
    const strongRelation = (targetId: string, weight: number, count: number) => ({
      targetId,
      kind: 'relates_to' as const,
      weight,
      createdAt: iso,
      lastReinforcedAt: iso,
      reinforcementCount: count
    })

    const a = createMockCommandRecord({ id: 'a', command: 'cmd-a', relations: [strongRelation('x', 0.9, 9)] })
    const b = createMockCommandRecord({ id: 'b', command: 'cmd-b', relations: [strongRelation('y', 0.9, 9)] })
    const x = createMockCommandRecord({ id: 'x', command: 'cmd-x', relations: [strongRelation('a', 0.9, 9)] })
    const y = createMockCommandRecord({ id: 'y', command: 'cmd-y', relations: [strongRelation('b', 0.9, 9)] })
    mockState.records = [a, b, x, y]

    // Keep strong edges alive in window, plus weaker a<->b pair that cannot survive cap=1 on either side.
    coInject(['a', 'x'], 9, now - 4)
    coInject(['b', 'y'], 9, now - 4)
    coInject(['a', 'b'], 3, now)

    const result = await runRelationDiscovery(false, DEFAULT_CONFIG, { maxRelationsPerRecord: 1 })

    expect(result.summary.eligiblePairs).toBe(3)
    expect(result.summary.updated).toBe(0)
    expect(result.actions).toHaveLength(0)
    expect(batchUpdateRecords).not.toHaveBeenCalled()
  })

  it('does not write when capping relates_to only reorders mixed relates_to and shares_entity edges', async () => {
    const now = Date.now()
    const iso = new Date(now + 4).toISOString()
    const strongRelates = (targetId: string) => ({
      targetId,
      kind: 'relates_to' as const,
      weight: 0.9,
      createdAt: iso,
      lastReinforcedAt: iso,
      reinforcementCount: 9
    })
    const sharesEntity = (targetId: string) => ({
      targetId,
      kind: 'shares_entity' as const,
      weight: 0.8,
      createdAt: iso,
      lastReinforcedAt: iso,
      reinforcementCount: 1
    })

    // Records hold [relates_to, shares_entity] (the order capSharesEntityRelations produces).
    // capRelatesToRelations reorders to [shares_entity, relates_to] when evicting the weaker new edge.
    mockState.records = [
      createMockCommandRecord({ id: 'a', command: 'cmd-a', relations: [strongRelates('x'), sharesEntity('e1')] }),
      createMockCommandRecord({ id: 'b', command: 'cmd-b', relations: [strongRelates('y'), sharesEntity('e2')] }),
      createMockCommandRecord({ id: 'x', command: 'cmd-x', relations: [strongRelates('a'), sharesEntity('e3')] }),
      createMockCommandRecord({ id: 'y', command: 'cmd-y', relations: [strongRelates('b'), sharesEntity('e4')] })
    ]

    coInject(['a', 'x'], 9, now - 4)
    coInject(['b', 'y'], 9, now - 4)
    coInject(['a', 'b'], 3, now)

    const result = await runRelationDiscovery(false, DEFAULT_CONFIG, { maxRelationsPerRecord: 1 })

    expect(result.summary.eligiblePairs).toBe(3)
    expect(result.summary.updated).toBe(0)
    expect(result.actions).toHaveLength(0)
    expect(batchUpdateRecords).not.toHaveBeenCalled()
  })
})
