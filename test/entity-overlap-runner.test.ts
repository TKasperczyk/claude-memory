import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MemoryRecord } from '../src/lib/types.js'
import { DEFAULT_CONFIG } from '../src/lib/types.js'
import { runEntityOverlapDiscovery } from '../src/lib/maintenance/runners/entities.js'
import { batchUpdateRecords, fetchRecordsByIds, iterateRecords } from '../src/lib/lancedb.js'
import { createMockDiscoveryRecord } from './helpers.js'

const mockState = vi.hoisted(() => ({
  records: [] as MemoryRecord[]
}))

vi.mock('../src/lib/lancedb.js', () => ({
  batchUpdateRecords: vi.fn(async (records: MemoryRecord[]) => ({ updated: records.length, failed: 0 })),
  fetchRecordsByIds: vi.fn(async (ids: string[]) => {
    const idSet = new Set(ids)
    return mockState.records.filter(record => idSet.has(record.id))
  }),
  iterateRecords: vi.fn(async function* () {
    for (const record of mockState.records) yield record
  })
}))

const SETTINGS = { maxRelationsPerRecord: 50 }

function record(id: string, entities: string[], overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return createMockDiscoveryRecord({ id, entities, ...overrides } as never)
}

/** Pad the corpus so the 10% document-frequency ceiling doesn't bite. */
function filler(count: number, offset = 0): MemoryRecord[] {
  return Array.from({ length: count }, (_, i) => record(`filler-${offset + i}`, []))
}

function relationsOf(id: string) {
  const stored = mockState.records.find(candidate => candidate.id === id)
  return stored?.relations ?? []
}

beforeEach(() => {
  vi.clearAllMocks()
  mockState.records = []
})

describe('runEntityOverlapDiscovery', () => {
  it('creates bidirectional shares_entity edges for records sharing a rare entity', async () => {
    mockState.records = [
      record('a', ['phantom', 'src/lib/retrieval.ts']),
      record('b', ['phantom']),
      ...filler(28)
    ]

    const result = await runEntityOverlapDiscovery(false, DEFAULT_CONFIG, SETTINGS)

    expect(result.summary.pairs).toBe(1)
    const aRelations = relationsOf('a')
    const bRelations = relationsOf('b')
    expect(aRelations).toHaveLength(1)
    expect(bRelations).toHaveLength(1)
    expect(aRelations[0]).toMatchObject({ targetId: 'b', kind: 'shares_entity' })
    expect(bRelations[0]).toMatchObject({ targetId: 'a', kind: 'shares_entity' })
    expect(aRelations[0].weight).toBeGreaterThan(0)
    expect(aRelations[0].weight).toBeLessThanOrEqual(1)
    expect(iterateRecords).toHaveBeenCalledWith(
      { filter: 'deprecated = false', includeEmbeddings: false },
      DEFAULT_CONFIG
    )
    expect(fetchRecordsByIds).toHaveBeenCalledWith(
      expect.arrayContaining(['a', 'b']),
      DEFAULT_CONFIG,
      { includeEmbeddings: true }
    )
    expect(batchUpdateRecords).toHaveBeenCalledTimes(1)
  })

  it('ignores unique entities and entities above the df ceiling', async () => {
    // Corpus of 30: maxDf = max(2, floor(3)) = 3, so df-4 'common' is noise.
    mockState.records = [
      record('a', ['unique-entity', 'common']),
      record('b', ['common']),
      record('c', ['common']),
      record('d', ['common']),
      ...filler(26)
    ]

    const result = await runEntityOverlapDiscovery(false, DEFAULT_CONFIG, SETTINGS)

    expect(result.summary.pairs).toBe(0)
    expect(batchUpdateRecords).not.toHaveBeenCalled()
  })

  it('skips pairs already related by any kind', async () => {
    const a = record('a', ['phantom'])
    a.relations = [{
      targetId: 'b',
      kind: 'relates_to',
      weight: 0.5,
      createdAt: new Date().toISOString(),
      lastReinforcedAt: new Date().toISOString(),
      reinforcementCount: 3
    }]
    mockState.records = [a, record('b', ['phantom']), ...filler(28)]

    const result = await runEntityOverlapDiscovery(false, DEFAULT_CONFIG, SETTINGS)

    expect(result.summary.skipped).toBe(1)
    expect(relationsOf('a')).toHaveLength(1)
    expect(relationsOf('a')[0].kind).toBe('relates_to')
    expect(relationsOf('b')).toHaveLength(0)
  })

  it('caps shares_entity edges per record keeping the strongest', async () => {
    // Hub shares distinct entities with three spokes; extra entities on
    // spoke pairs give differing weights.
    mockState.records = [
      record('hub', ['alpha-svc', 'beta-svc', 'gamma-svc']),
      record('s1', ['alpha-svc', 'beta-svc']),
      record('s2', ['beta-svc', 'gamma-svc']),
      record('s3', ['gamma-svc']),
      ...filler(40)
    ]

    await runEntityOverlapDiscovery(false, DEFAULT_CONFIG, { maxRelationsPerRecord: 2 })

    const hubRelations = mockState.records.find(candidate => candidate.id === 'hub')?.relations ?? []
    expect(hubRelations.length).toBe(2)
    expect(hubRelations.every(relation => relation.kind === 'shares_entity')).toBe(true)
  })

  it('does not write in dry-run mode but still reports pairs', async () => {
    mockState.records = [
      record('a', ['phantom']),
      record('b', ['phantom']),
      ...filler(28)
    ]

    const result = await runEntityOverlapDiscovery(true, DEFAULT_CONFIG, SETTINGS)

    expect(result.summary.pairs).toBe(1)
    expect(result.summary.updated).toBe(2)
    expect(batchUpdateRecords).not.toHaveBeenCalled()
    expect(result.actions).toHaveLength(1)
    expect(result.actions[0].details?.kind).toBe('shares_entity')
  })

  it('skips deprecated records via the iteration filter contract', async () => {
    // The runner filters deprecated = false at the DB level; the mock honors
    // whatever it receives, so this documents the expectation on live data.
    mockState.records = [
      record('a', ['phantom']),
      record('b', ['phantom']),
      ...filler(28)
    ]

    const result = await runEntityOverlapDiscovery(false, DEFAULT_CONFIG, SETTINGS)
    expect(result.summary.scanned).toBe(30)
  })

  it('omits actions and writes when maxRelationsPerRecord cap immediately evicts an edge on both sides', async () => {
    const now = new Date().toISOString()
    const strongEdge = (targetId: string) => ({
      targetId,
      kind: 'shares_entity' as const,
      weight: 1,
      createdAt: now,
      lastReinforcedAt: now,
      reinforcementCount: 1
    })

    // In a 30-record corpus, df=3 gives weight = 0.4 * ln((30+1)/(3+1)) ≈ 0.819 < 1.
    // Both a and b already hold weight-1 edges at cap=1, so the weaker a<->b edge is evicted on both sides.
    mockState.records = [
      record('a', ['shared-tool'], { relations: [strongEdge('x')] }),
      record('b', ['shared-tool'], { relations: [strongEdge('y')] }),
      record('c', ['shared-tool'], { relations: [strongEdge('z')] }),
      ...filler(27)
    ]

    const result = await runEntityOverlapDiscovery(false, DEFAULT_CONFIG, { maxRelationsPerRecord: 1 })

    expect(result.summary.pairs).toBe(3)
    expect(result.summary.updated).toBe(0)
    expect(result.actions).toHaveLength(0)
    expect(batchUpdateRecords).not.toHaveBeenCalled()
  })

  it('omits actions when maxRelationsPerRecord is zero in both live and dry-run modes', async () => {
    mockState.records = [
      record('a', ['phantom']),
      record('b', ['phantom']),
      ...filler(28)
    ]

    const dryRunResult = await runEntityOverlapDiscovery(true, DEFAULT_CONFIG, { maxRelationsPerRecord: 0 })
    expect(dryRunResult.summary.pairs).toBe(1)
    expect(dryRunResult.summary.updated).toBe(0)
    expect(dryRunResult.actions).toHaveLength(0)
    expect(batchUpdateRecords).not.toHaveBeenCalled()
  })

  it('omits actions and writes when trimSharesEntityRelations evicts edges due to content size ceiling', async () => {
    const hugeEvidence = 'x'.repeat(16_050)
    mockState.records = [
      record('a', ['phantom'], { evidence: hugeEvidence }),
      record('b', ['phantom'], { evidence: hugeEvidence }),
      ...filler(28)
    ]

    const result = await runEntityOverlapDiscovery(false, DEFAULT_CONFIG, SETTINGS)

    expect(result.summary.pairs).toBe(1)
    expect(result.summary.updated).toBe(0)
    expect(result.actions).toHaveLength(0)
    expect(relationsOf('a')).toHaveLength(0)
    expect(relationsOf('b')).toHaveLength(0)
    expect(batchUpdateRecords).not.toHaveBeenCalled()
  })

  it('reports the surviving side when only one record retains an edge after capping', async () => {
    const now = new Date().toISOString()
    const strongEdge = {
      targetId: 'x',
      kind: 'shares_entity' as const,
      weight: 1,
      createdAt: now,
      lastReinforcedAt: now,
      reinforcementCount: 1
    }

    // Record 'a' is already at cap=1 with a weight-1 edge and drops 'b'; 'b' has room and retains 'a'.
    mockState.records = [
      record('a', ['shared-tool'], { relations: [strongEdge] }),
      record('b', ['shared-tool']),
      record('c', ['shared-tool'], { relations: [{ ...strongEdge, targetId: 'z' }] }),
      ...filler(27)
    ]

    const result = await runEntityOverlapDiscovery(false, DEFAULT_CONFIG, { maxRelationsPerRecord: 1 })

    // Only 'b' keeps a single edge (the lexicographically first targetId 'a' at cap=1).
    expect(result.summary.updated).toBe(1)
    expect(result.actions).toHaveLength(1)
    expect(result.actions[0]).toMatchObject({
      recordId: 'b',
      details: expect.objectContaining({
        targetId: 'a',
        kind: 'shares_entity'
      })
    })
    expect(batchUpdateRecords).toHaveBeenCalledTimes(1)
    expect(vi.mocked(batchUpdateRecords).mock.calls[0][0].map(r => r.id)).toEqual(['b'])
  })

  it('ignores duplicate entities on a single record without emitting self-edges or actions', async () => {
    mockState.records = [
      record('a', ['phantom', 'phantom']),
      ...filler(29)
    ]

    const result = await runEntityOverlapDiscovery(false, DEFAULT_CONFIG, SETTINGS)

    expect(result.summary.pairs).toBe(0)
    expect(result.summary.updated).toBe(0)
    expect(result.actions).toHaveLength(0)
    expect(batchUpdateRecords).not.toHaveBeenCalled()
  })
})
