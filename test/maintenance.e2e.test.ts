/**
 * E2E tests for the maintenance flow.
 *
 * Tests: stale detection, validity checking, consolidation, deprecation
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import { homedir } from 'os'
import { TEST_CONFIG, TEST_PROJECT } from './config.js'
import {
  dropTestCollection,
  createMockCommandRecord,
  createMockDiscoveryRecord,
  createMockProcedureRecord,
  cleanupTempFiles
} from './helpers.js'
import { initLanceDB, insertRecord, getRecord, queryRecords } from '../src/lib/lancedb.js'
import {
  findStaleRecords,
  checkValidity,
  markDeprecated,
  findSimilarClusters,
  consolidateCluster
} from '../src/lib/maintenance.js'
import { runRelationDiscovery } from '../src/lib/maintenance/runners/index.js'
import { getCollectionKey, recordRetrievalEvents } from '../src/lib/retrieval-events.js'
import { SIMILARITY_THRESHOLDS } from '../src/lib/types.js'

const STALE_CUTOFF_MS = 90 * 24 * 60 * 60 * 1000 // 90 days

function makeRelation(targetId: string, kind: 'relates_to' | 'supersedes' = 'relates_to', weight = 1) {
  return {
    targetId,
    kind,
    weight,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastReinforcedAt: '2026-01-01T00:00:00.000Z',
    reinforcementCount: 1
  }
}

function cleanupRetrievalEvents(): void {
  fs.rmSync(
    path.join(homedir(), '.claude-memory', 'retrieval-events', getCollectionKey(TEST_CONFIG.lancedb.table)),
    { recursive: true, force: true }
  )
}

describe('Maintenance E2E', () => {
  beforeAll(async () => {
    await dropTestCollection()
    await initLanceDB(TEST_CONFIG)
  })

  afterAll(async () => {
    await dropTestCollection()
    cleanupRetrievalEvents()
    cleanupTempFiles()
  })

  beforeEach(async () => {
    await dropTestCollection()
    cleanupRetrievalEvents()
    await initLanceDB(TEST_CONFIG)
  })

  describe('Stale Detection', () => {
    it('should find records not used in 90+ days', async () => {
      const staleTimestamp = Date.now() - STALE_CUTOFF_MS - 1000

      // Insert a stale record
      await insertRecord(createMockCommandRecord({
        command: 'stale-command',
        lastUsed: staleTimestamp,
        timestamp: staleTimestamp
      }), TEST_CONFIG)

      // Insert a fresh record
      await insertRecord(createMockCommandRecord({
        command: 'fresh-command',
        lastUsed: Date.now(),
        timestamp: Date.now()
      }), TEST_CONFIG)

      const staleRecords = await findStaleRecords(TEST_CONFIG)

      expect(staleRecords.length).toBe(1)
      expect((staleRecords[0] as { command: string }).command).toBe('stale-command')
    })

    it('should not flag deprecated records as stale', async () => {
      const staleTimestamp = Date.now() - STALE_CUTOFF_MS - 1000

      await insertRecord(createMockCommandRecord({
        command: 'already-deprecated',
        lastUsed: staleTimestamp,
        deprecated: true
      }), TEST_CONFIG)

      const staleRecords = await findStaleRecords(TEST_CONFIG)

      expect(staleRecords.length).toBe(0)
    })
  })

  describe('Validity Checking', () => {
    it('should validate command with existing executable', async () => {
      const record = createMockCommandRecord({
        command: 'ls -la',
        context: {
          project: TEST_PROJECT,
          cwd: TEST_PROJECT,
          intent: 'list files'
        }
      })

      const result = await checkValidity(record)

      expect(result.valid).toBe(true)
    })

    it('should invalidate command with non-existent executable', async () => {
      const record = createMockCommandRecord({
        command: 'nonexistent-cmd-xyz123 --help',
        context: {
          project: TEST_PROJECT,
          cwd: TEST_PROJECT,
          intent: 'run fake command'
        }
      })

      const result = await checkValidity(record)

      expect(result.valid).toBe(false)
      expect(result.reason).toContain('missing-command')
    })

    it('should validate procedure with existing commands', async () => {
      const record = createMockProcedureRecord({
        name: 'List and grep',
        steps: [
          'ls -la',
          'grep pattern file',
          'cat output.txt'
        ],
        context: {
          project: TEST_PROJECT
        }
      })

      const result = await checkValidity(record)

      expect(result.valid).toBe(true)
    })

    it('should invalidate procedure with non-existent commands', async () => {
      const record = createMockProcedureRecord({
        name: 'Broken procedure',
        steps: [
          'ls -la',
          'fake-broken-cmd --option',
          'cat output.txt'
        ],
        context: {
          project: TEST_PROJECT
        }
      })

      const result = await checkValidity(record)

      expect(result.valid).toBe(false)
      expect(result.reason).toContain('missing-command')
    })

    it('should handle discovery records (always valid unless aged)', async () => {
      const record = createMockDiscoveryRecord({
        what: 'Test discovery',
        timestamp: Date.now()
      })

      const result = await checkValidity(record)

      expect(result.valid).toBe(true)
    })

    it('should invalidate old discovery records', async () => {
      const oldTimestamp = Date.now() - 200 * 24 * 60 * 60 * 1000 // 200 days

      const record = createMockDiscoveryRecord({
        what: 'Old discovery',
        timestamp: oldTimestamp
      })

      const result = await checkValidity(record)

      expect(result.valid).toBe(false)
      expect(result.reason).toContain('discovery-aged')
    })
  })

  describe('Deprecation', () => {
    it('should mark a record as deprecated', async () => {
      const record = createMockCommandRecord({
        command: 'to-deprecate',
        deprecated: false
      })

      await insertRecord(record, TEST_CONFIG)

      const success = await markDeprecated(record.id, TEST_CONFIG)
      expect(success).toBe(true)

      const updated = await getRecord(record.id, TEST_CONFIG)
      expect(updated!.deprecated).toBe(true)
    })

    it('should return false for non-existent record', async () => {
      const success = await markDeprecated('non-existent-id', TEST_CONFIG)
      expect(success).toBe(false)
    })

    it('should write a supersedes relation on the superseding record', async () => {
      const existing = createMockCommandRecord({
        command: 'old-command',
        deprecated: false
      })
      const candidate = createMockCommandRecord({
        command: 'new-command',
        deprecated: false
      })

      await insertRecord(existing, TEST_CONFIG)
      await insertRecord(candidate, TEST_CONFIG)

      const success = await markDeprecated(existing.id, TEST_CONFIG, { supersedingRecordId: candidate.id })
      expect(success).toBe(true)

      const deprecated = await getRecord(existing.id, TEST_CONFIG)
      const superseding = await getRecord(candidate.id, TEST_CONFIG)

      expect(deprecated?.deprecated).toBe(true)
      expect(superseding?.supersedes).toBe(existing.id)
      expect(superseding?.relations).toContainEqual(expect.objectContaining({
        targetId: existing.id,
        kind: 'supersedes',
        weight: 1,
        reinforcementCount: 1
      }))
    })
  })

  describe('Relation Discovery', () => {
    it('should build bidirectional relates_to edges from co-injected retrieval events', async () => {
      const a = createMockCommandRecord({ command: 'relation-a', deprecated: false })
      const b = createMockCommandRecord({ command: 'relation-b', deprecated: false })
      await insertRecord(a, TEST_CONFIG)
      await insertRecord(b, TEST_CONFIG)

      const now = Date.now()
      for (let i = 0; i < 3; i += 1) {
        const groupId = `group-${i}`
        recordRetrievalEvents([
          {
            id: a.id,
            type: a.type,
            timestamp: now + i,
            groupId,
            coInjectedIds: [a.id, b.id]
          },
          {
            id: b.id,
            type: b.type,
            timestamp: now + i,
            groupId,
            coInjectedIds: [a.id, b.id]
          }
        ], { collection: TEST_CONFIG.lancedb.table })
      }

      const result = await runRelationDiscovery(false, TEST_CONFIG)
      expect(result.summary.eligiblePairs).toBe(1)
      expect(result.summary.updated).toBe(2)

      const updatedA = await getRecord(a.id, TEST_CONFIG)
      const updatedB = await getRecord(b.id, TEST_CONFIG)
      const relationA = updatedA?.relations?.find(relation => relation.targetId === b.id && relation.kind === 'relates_to')
      const relationB = updatedB?.relations?.find(relation => relation.targetId === a.id && relation.kind === 'relates_to')
      const expectedLastReinforcedAt = new Date(now + 2).toISOString()

      expect(relationA).toEqual(expect.objectContaining({
        weight: 0.3,
        reinforcementCount: 3,
        lastReinforcedAt: expectedLastReinforcedAt
      }))
      expect(relationB).toEqual(expect.objectContaining({
        weight: 0.3,
        reinforcementCount: 3,
        lastReinforcedAt: expectedLastReinforcedAt
      }))

      await runRelationDiscovery(false, TEST_CONFIG)
      const rerunA = await getRecord(a.id, TEST_CONFIG)
      const rerunRelationA = rerunA?.relations?.find(relation => relation.targetId === b.id && relation.kind === 'relates_to')
      expect(rerunRelationA?.reinforcementCount).toBe(3)
    })

    it('caps relates_to edges while preserving supersedes relations', async () => {
      const hub = createMockCommandRecord({ command: 'relation-hub', deprecated: false })
      const a = createMockCommandRecord({ command: 'relation-cap-a', deprecated: false })
      const b = createMockCommandRecord({ command: 'relation-cap-b', deprecated: false })
      const c = createMockCommandRecord({ command: 'relation-cap-c', deprecated: false })
      const superseded = createMockCommandRecord({ command: 'relation-cap-superseded', deprecated: false })
      hub.relations = [makeRelation(superseded.id, 'supersedes')]

      for (const record of [hub, a, b, c, superseded]) {
        await insertRecord(record, TEST_CONFIG)
      }

      const now = Date.now()
      const pairs = [
        { target: a, count: 5 },
        { target: b, count: 4 },
        { target: c, count: 3 }
      ]
      for (const pair of pairs) {
        for (let i = 0; i < pair.count; i += 1) {
          const groupId = `${pair.target.id}-${i}`
          recordRetrievalEvents([
            { id: hub.id, type: hub.type, timestamp: now + i, groupId, coInjectedIds: [hub.id, pair.target.id] },
            { id: pair.target.id, type: pair.target.type, timestamp: now + i, groupId, coInjectedIds: [hub.id, pair.target.id] }
          ], { collection: TEST_CONFIG.lancedb.table })
        }
      }

      await runRelationDiscovery(false, TEST_CONFIG, { maxRelationsPerRecord: 2 })

      const updatedHub = await getRecord(hub.id, TEST_CONFIG)
      const relatesTo = updatedHub?.relations?.filter(relation => relation.kind === 'relates_to') ?? []
      expect(relatesTo.map(relation => relation.targetId).sort()).toEqual([a.id, b.id].sort())
      expect(updatedHub?.relations).toContainEqual(expect.objectContaining({
        targetId: superseded.id,
        kind: 'supersedes'
      }))
    })

    it('prunes stale relates_to edges absent from the current observation window', async () => {
      const a = createMockCommandRecord({ command: 'relation-prune-a', deprecated: false })
      const b = createMockCommandRecord({ command: 'relation-prune-b', deprecated: false })
      a.relations = [makeRelation(b.id), makeRelation(b.id, 'supersedes')]
      b.relations = [makeRelation(a.id)]
      await insertRecord(a, TEST_CONFIG)
      await insertRecord(b, TEST_CONFIG)

      await runRelationDiscovery(false, TEST_CONFIG, { maxRelationsPerRecord: 50 })

      const updatedA = await getRecord(a.id, TEST_CONFIG)
      const updatedB = await getRecord(b.id, TEST_CONFIG)
      expect(updatedA?.relations?.some(relation => relation.kind === 'relates_to')).toBe(false)
      expect(updatedB?.relations?.some(relation => relation.kind === 'relates_to')).toBe(false)
      expect(updatedA?.relations).toContainEqual(expect.objectContaining({
        targetId: b.id,
        kind: 'supersedes'
      }))
    })
  })

  describe('Consolidation', () => {
    it('should find clusters of similar records', async () => {
      // Insert several similar commands
      for (let i = 0; i < 3; i++) {
        await insertRecord(createMockCommandRecord({
          command: 'npm run build',
          exitCode: 0,
          outcome: 'success',
          project: TEST_PROJECT
        }), TEST_CONFIG)
      }

      // Insert a different command
      await insertRecord(createMockCommandRecord({
        command: 'docker compose up',
        exitCode: 0,
        outcome: 'success',
        project: TEST_PROJECT
      }), TEST_CONFIG)

      const clusters = await findSimilarClusters(SIMILARITY_THRESHOLDS.CONSOLIDATION, TEST_CONFIG)

      // Should find at least one cluster with the similar npm commands
      const npmCluster = clusters.find(c =>
        c.some(r => r.type === 'command' && (r as { command: string }).command === 'npm run build')
      )

      expect(npmCluster).toBeDefined()
      expect(npmCluster!.length).toBeGreaterThanOrEqual(2)
    })

    it('should consolidate cluster and keep best record', async () => {
      const records = [
        createMockCommandRecord({
          command: 'npm test',
          successCount: 10,
          failureCount: 0,
          lastUsed: Date.now()
        }),
        createMockCommandRecord({
          command: 'npm test',
          successCount: 2,
          failureCount: 1,
          lastUsed: Date.now() - 1000
        }),
        createMockCommandRecord({
          command: 'npm test',
          successCount: 1,
          failureCount: 0,
          lastUsed: Date.now() - 2000
        })
      ]

      for (const record of records) {
        await insertRecord(record, TEST_CONFIG)
      }

      // Get the cluster
      const clusters = await findSimilarClusters(SIMILARITY_THRESHOLDS.CONSOLIDATION, TEST_CONFIG)
      expect(clusters.length).toBeGreaterThan(0)

      const cluster = clusters[0]
      const result = await consolidateCluster(cluster, TEST_CONFIG)

      expect(result).not.toBeNull()
      expect(result!.deprecatedIds.length).toBeGreaterThan(0)

      // The kept record should have aggregated counts
      const kept = await getRecord(result!.keptId, TEST_CONFIG)
      expect(kept).not.toBeNull()
      expect(kept!.successCount).toBeGreaterThanOrEqual(10)

      // Deprecated records should be marked
      for (const deprecatedId of result!.deprecatedIds) {
        const deprecated = await getRecord(deprecatedId, TEST_CONFIG)
        expect(deprecated!.deprecated).toBe(true)
      }
    })

    it('should not consolidate single-record cluster', async () => {
      const record = createMockCommandRecord({
        command: 'unique-command-xyz'
      })

      const result = await consolidateCluster([record], TEST_CONFIG)

      expect(result).toBeNull()
    })
  })

  describe('Full Maintenance Flow', () => {
    it('should process stale, invalid, and duplicate records', async () => {
      const staleTimestamp = Date.now() - STALE_CUTOFF_MS - 1000

      // Insert a stale record with invalid command
      const staleRecord = createMockCommandRecord({
        command: 'nonexistent-stale-cmd',
        lastUsed: staleTimestamp,
        timestamp: staleTimestamp,
        deprecated: false
      })
      await insertRecord(staleRecord, TEST_CONFIG)

      // Insert duplicate records
      const duplicateRecords = Array.from({ length: 3 }, (_, i) =>
        createMockCommandRecord({
          command: 'pnpm build',
          successCount: i + 1,
          failureCount: 0
        })
      )
      for (const record of duplicateRecords) {
        await insertRecord(record, TEST_CONFIG)
      }

      // Insert a valid fresh record
      const freshRecord = createMockCommandRecord({
        command: 'git status',
        lastUsed: Date.now()
      })
      await insertRecord(freshRecord, TEST_CONFIG)

      // Check counts before maintenance
      const beforeRecords = await queryRecords({ filter: 'deprecated = false' }, TEST_CONFIG)
      expect(beforeRecords.length).toBe(5)

      // Run stale check
      const staleRecords = await findStaleRecords(TEST_CONFIG)
      expect(staleRecords.length).toBeGreaterThanOrEqual(1)

      // Check validity and deprecate invalid
      for (const record of staleRecords) {
        const validity = await checkValidity(record)
        if (!validity.valid) {
          await markDeprecated(record.id, TEST_CONFIG)
        }
      }

      // Run consolidation
      const clusters = await findSimilarClusters(SIMILARITY_THRESHOLDS.CONSOLIDATION, TEST_CONFIG)
      for (const cluster of clusters) {
        await consolidateCluster(cluster, TEST_CONFIG)
      }

      // Check counts after maintenance
      const afterRecords = await queryRecords({ filter: 'deprecated = false' }, TEST_CONFIG)

      // Should have fewer non-deprecated records
      expect(afterRecords.length).toBeLessThan(beforeRecords.length)

      const staleUpdated = await getRecord(staleRecord.id, TEST_CONFIG)
      expect(staleUpdated!.deprecated).toBe(true)

      const duplicateUpdates = await Promise.all(
        duplicateRecords.map(record => getRecord(record.id, TEST_CONFIG))
      )
      const activeDuplicates = duplicateUpdates.filter(record => record && !record.deprecated)
      const deprecatedDuplicates = duplicateUpdates.filter(record => record?.deprecated)

      expect(activeDuplicates.length).toBe(1)
      expect(deprecatedDuplicates.length).toBe(duplicateRecords.length - 1)

      const freshUpdated = await getRecord(freshRecord.id, TEST_CONFIG)
      expect(freshUpdated!.deprecated).toBe(false)
    })
  })
})
