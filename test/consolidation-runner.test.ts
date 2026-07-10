import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type MemoryRecord } from '../src/lib/types.js'
import { DEFAULT_MAINTENANCE_SETTINGS } from '../src/lib/settings-schema.js'
import { runConsolidation, runCrossTypeConsolidation } from '../src/lib/maintenance/runners/consolidation-runners.js'
import { batchUpdateRecords } from '../src/lib/lancedb.js'
import { llmVerifyConsolidation } from '../src/lib/maintenance/consolidation.js'
import {
  cleanupConsolidationNoMergeVerdicts,
  loadConsolidationNoMergeVerdict,
  saveConsolidationNoMergeVerdict
} from '../src/lib/maintenance/consolidation-verdicts.js'
import { createMockDiscoveryRecord } from './helpers.js'

const mockState = vi.hoisted(() => ({
  clusters: [] as any[],
  cachedVerdict: null as any,
  verification: {
    shouldMerge: false,
    reason: 'The records are related but preserve distinct durable facts.'
  }
}))

vi.mock('../src/lib/lancedb.js', () => ({
  batchUpdateRecords: vi.fn(async (records: MemoryRecord[]) => ({ updated: records.length, failed: 0 })),
  queryRecords: vi.fn(async () => mockState.clusters.flatMap(cluster => cluster.members.map((member: any) => member.record))),
  updateRecord: vi.fn(async () => true)
}))

vi.mock('../src/lib/maintenance/consolidation.js', () => ({
  consolidateCluster: vi.fn(async () => null),
  findCrossTypeClusters: vi.fn(async () => mockState.clusters),
  findSimilarClusters: vi.fn(async () => mockState.clusters),
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
})
