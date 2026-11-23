import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type MemoryRecord } from '../src/lib/types.js'
import { DEFAULT_MAINTENANCE_SETTINGS } from '../src/lib/settings-schema.js'
import { runConsolidation, runCrossTypeConsolidation } from '../src/lib/maintenance/runners/consolidation-runners.js'
import { batchUpdateRecords, fetchRecordsByIds } from '../src/lib/lancedb.js'
import { consolidateCluster, findSimilarClusters, llmVerifyConsolidation, pickConsolidationFallback, resolveMergeGroups } from '../src/lib/maintenance/consolidation.js'
import {
  cleanupConsolidationNoMergeVerdicts,
  loadConsolidationNoMergeVerdict,
  saveConsolidationNoMergeVerdict
} from '../src/lib/maintenance/consolidation-verdicts.js'
import { createMockDiscoveryRecord } from './helpers.js'

const mockState = vi.hoisted(() => ({
  clusters: [] as any[],
  dbRecords: null as MemoryRecord[] | null,
  singletons: [] as MemoryRecord[],
  cachedVerdict: null as any,
  verification: {
    shouldMerge: false,
    reason: 'The records are related but preserve distinct durable facts.'
  }
}))

vi.mock('../src/lib/lancedb.js', () => ({
  batchUpdateRecords: vi.fn(async (records: MemoryRecord[]) => ({ updated: records.length, failed: 0 })),
  fetchRecordsByIds: vi.fn(async (ids: string[]) => {
    const source = mockState.dbRecords
      ?? mockState.clusters.flatMap(cluster => cluster.members.map((member: any) => member.record))
    const idSet = new Set(ids)
    return source.filter(record => idSet.has(record.id))
  }),
  queryRecords: vi.fn(async () => mockState.clusters.flatMap(cluster => cluster.members.map((member: any) => member.record))),
  updateRecord: vi.fn(async () => true)
}))

vi.mock('../src/lib/maintenance/consolidation.js', () => ({
  consolidateCluster: vi.fn(async () => null),
  findCrossTypeClusters: vi.fn(async (_threshold, _config, _settings, options) => {
    options?.onScannedSingletons?.(mockState.singletons)
    return mockState.clusters
  }),
  findSimilarClusters: vi.fn(async (_threshold, _config, _settings, options) => {
    options?.onScannedSingletons?.(mockState.singletons)
    return mockState.clusters
  }),
  llmVerifyConsolidation: vi.fn(async () => mockState.verification),
  pickConsolidationFallback: vi.fn(() => ({ shouldMerge: true, keptId: 'a', reason: 'fallback' })),
  resolveMergeGroups: vi.fn(() => [])
}))

vi.mock('../src/lib/maintenance/consolidation-verdicts.js', () => ({
  cleanupConsolidationNoMergeVerdicts: vi.fn(() => 0),
  loadConsolidationNoMergeVerdict: vi.fn(() => mockState.cachedVerdict),
  saveConsolidationNoMergeVerdict: vi.fn((_mode, records, reason, model, options) => ({
    mode: 'same-type',
    memberIds: records.map((record: MemoryRecord) => record.id).sort(),
    durableContentHash: 'hash',
    reason,
    checkedAt: options.now,
    model,
    policyVersion: 'test'
  }))
}))

function buildCluster(): any {
  const records = [
    createMockDiscoveryRecord({ id: 'a', what: 'First durable fact.' }),
    createMockDiscoveryRecord({ id: 'b', what: 'Second durable fact.' })
  ]
  const cluster = [...records] as any
  cluster.seedId = records[0].id
  cluster.members = records.map((record, index) => ({ record, similarity: index === 0 ? 1 : 0.8 }))
  return cluster
}

const settings = {
  ...DEFAULT_MAINTENANCE_SETTINGS,
  enableConsolidationLlmVerification: true,
  consolidationNoMergeBackoffDays: 90
}

describe('consolidation runner no-merge verdict cache', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockState.clusters = [buildCluster()]
    mockState.dbRecords = null
    mockState.singletons = []
    mockState.cachedVerdict = null
    mockState.verification = {
      shouldMerge: false,
      reason: 'The records are related but preserve distinct durable facts.'
    }
  })

  it('skips LLM verification for a cached rejection and refreshes check markers', async () => {
    mockState.cachedVerdict = {
      reason: 'Cached no-merge verdict.',
      checkedAt: Date.now()
    }

    const result = await runConsolidation(false, DEFAULT_CONFIG, settings)

    expect(llmVerifyConsolidation).not.toHaveBeenCalled()
    expect(saveConsolidationNoMergeVerdict).not.toHaveBeenCalled()
    expect(cleanupConsolidationNoMergeVerdicts).toHaveBeenCalledWith({
      collection: DEFAULT_CONFIG.lancedb.table,
      backoffDays: 90
    })
    expect(result.summary).toMatchObject({
      rejected: 1,
      clustersRejectedFromCache: 1,
      errors: 0
    })
    expect(batchUpdateRecords).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ id: 'a' }),
        expect.objectContaining({ id: 'b' })
      ]),
      { lastConsolidationCheck: expect.any(Number) },
      DEFAULT_CONFIG
    )
  })

  it('persists an explicit non-dry-run LLM rejection', async () => {
    const result = await runConsolidation(false, DEFAULT_CONFIG, settings)

    expect(llmVerifyConsolidation).toHaveBeenCalledTimes(1)
    expect(loadConsolidationNoMergeVerdict).toHaveBeenCalledWith(
      'same-type',
      expect.any(Array),
      expect.objectContaining({
        collection: DEFAULT_CONFIG.lancedb.table,
        backoffDays: 90,
        deleteInvalid: true
      })
    )
    expect(saveConsolidationNoMergeVerdict).toHaveBeenCalledWith(
      'same-type',
      expect.any(Array),
      mockState.verification.reason,
      DEFAULT_CONFIG.extraction.model,
      expect.objectContaining({ collection: DEFAULT_CONFIG.lancedb.table, now: expect.any(Number) })
    )
    expect(result.summary).toMatchObject({ rejected: 1, clustersRejectedFromCache: 0 })
  })

  it('uses a distinct cross-type cache mode', async () => {
    mockState.cachedVerdict = {
      reason: 'Cached cross-type no-merge verdict.',
      checkedAt: Date.now()
    }

    const result = await runCrossTypeConsolidation(false, DEFAULT_CONFIG, settings)

    expect(loadConsolidationNoMergeVerdict).toHaveBeenCalledWith(
      'cross-type',
      expect.any(Array),
      expect.objectContaining({ backoffDays: 90 })
    )
    expect(llmVerifyConsolidation).not.toHaveBeenCalled()
    expect(result.summary).toMatchObject({ rejected: 1, clustersRejectedFromCache: 1 })
    expect(batchUpdateRecords).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ id: 'a' }),
        expect.objectContaining({ id: 'b' })
      ]),
      { lastCrossTypeConsolidationCheck: expect.any(Number) },
      DEFAULT_CONFIG
    )
  })

  it('does not persist or refresh markers during a dry-run rejection', async () => {
    const result = await runConsolidation(true, DEFAULT_CONFIG, settings)

    expect(result.summary).toMatchObject({ rejected: 1, clustersRejectedFromCache: 0 })
    expect(loadConsolidationNoMergeVerdict).toHaveBeenCalledWith(
      'same-type',
      expect.any(Array),
      expect.objectContaining({ deleteInvalid: false })
    )
    expect(saveConsolidationNoMergeVerdict).not.toHaveBeenCalled()
    expect(cleanupConsolidationNoMergeVerdicts).not.toHaveBeenCalled()
    expect(batchUpdateRecords).not.toHaveBeenCalled()
  })

  it('skips cluster instead of falling back to blind merge when LLM verification fails', async () => {
    vi.mocked(llmVerifyConsolidation).mockRejectedValueOnce(new Error('503 Service Unavailable'))

    const result = await runConsolidation(false, DEFAULT_CONFIG, settings)

    expect(pickConsolidationFallback).not.toHaveBeenCalled()
    expect(consolidateCluster).not.toHaveBeenCalled()
    expect(saveConsolidationNoMergeVerdict).not.toHaveBeenCalled()
    expect(batchUpdateRecords).not.toHaveBeenCalled()
    expect(result.summary).toMatchObject({
      merged: 0,
      rejected: 0,
      deprecated: 0,
      errors: 1
    })
  })

  it('re-fetches post-merge cluster records from DB even when pre-merge snapshots already carry embeddings', async () => {
    const embedding = [0.1, 0.2, 0.3]
    const preMergeKeeper = createMockDiscoveryRecord({
      id: 'keeper',
      what: 'Original keeper text',
      deprecated: false,
      embedding
    })
    const preMergeDup = createMockDiscoveryRecord({
      id: 'dup',
      what: 'Duplicate text',
      deprecated: false,
      embedding
    })
    const cluster = [preMergeKeeper, preMergeDup] as any
    cluster.seedId = preMergeKeeper.id
    cluster.members = [
      { record: preMergeKeeper, similarity: 1 },
      { record: preMergeDup, similarity: 0.92 }
    ]
    mockState.clusters = [cluster]

    const postMergeKeeper: MemoryRecord = {
      ...preMergeKeeper,
      what: 'Synthesized merged fact',
      relations: [{ targetId: 'dup', kind: 'supersedes', weight: 1, updatedAt: '2026-11-23T00:00:00.000Z' }]
    }
    const postMergeDup: MemoryRecord = {
      ...preMergeDup,
      deprecated: true,
      deprecatedAt: 1700000000000,
      deprecatedReason: 'consolidation:superseded-by:keeper',
      supersedingRecordId: 'keeper'
    }
    mockState.dbRecords = [postMergeKeeper, postMergeDup]
    mockState.verification = { shouldMerge: true, reason: 'Exact duplicates' } as any
    vi.mocked(resolveMergeGroups).mockReturnValueOnce([{
      keptId: 'keeper',
      mergedIds: ['dup'],
      reason: 'Exact duplicates',
      synthesizedFields: { what: 'Synthesized merged fact' }
    }])
    vi.mocked(consolidateCluster).mockResolvedValueOnce({
      keptId: 'keeper',
      deprecatedIds: ['dup']
    })

    const result = await runConsolidation(false, DEFAULT_CONFIG, settings)

    expect(result.summary).toMatchObject({ merged: 1, deprecated: 1, errors: 0 })
    expect(fetchRecordsByIds).toHaveBeenCalledWith(['keeper', 'dup'], DEFAULT_CONFIG, { includeEmbeddings: true })
    expect(batchUpdateRecords).toHaveBeenCalledWith(
      [postMergeKeeper, postMergeDup],
      { lastConsolidationCheck: expect.any(Number) },
      DEFAULT_CONFIG
    )
    const written = vi.mocked(batchUpdateRecords).mock.calls[0][0]
    expect(written.find(r => r.id === 'dup')?.deprecated).toBe(true)
    expect((written.find(r => r.id === 'keeper') as any)?.what).toBe('Synthesized merged fact')
  })

  it('reuses in-memory snapshots for unmutated singletons that already have embeddings', async () => {
    const singleton = createMockDiscoveryRecord({
      id: 'singleton-1',
      what: 'Unique fact',
      embedding: [0.5, 0.5]
    })
    mockState.clusters = []
    mockState.singletons = [singleton]

    const result = await runConsolidation(false, DEFAULT_CONFIG, settings)

    expect(result.summary.errors).toBe(0)
    expect(findSimilarClusters).toHaveBeenCalledTimes(1)
    expect(fetchRecordsByIds).not.toHaveBeenCalled()
    expect(batchUpdateRecords).toHaveBeenCalledWith(
      [singleton],
      { lastConsolidationCheck: expect.any(Number) },
      DEFAULT_CONFIG
    )
  })
})
