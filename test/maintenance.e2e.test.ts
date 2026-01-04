/**
 * E2E tests for the maintenance flow.
 *
 * Tests: stale detection, validity checking, consolidation, deprecation
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { TEST_CONFIG, TEST_PROJECT } from './config.js'
import {
  dropTestCollection,
  createMockCommandRecord,
  createMockDiscoveryRecord,
  createMockProcedureRecord,
  cleanupTempFiles
} from './helpers.js'
import { initMilvus, insertRecord, getRecord, queryRecords } from '../src/lib/milvus.js'
import {
  findStaleRecords,
  checkValidity,
  markDeprecated,
  findSimilarClusters,
  consolidateCluster
} from '../src/lib/maintenance.js'

const STALE_CUTOFF_MS = 90 * 24 * 60 * 60 * 1000 // 90 days

describe('Maintenance E2E', () => {
  beforeAll(async () => {
    await dropTestCollection()
    await initMilvus(TEST_CONFIG)
  })

  afterAll(async () => {
    await dropTestCollection()
    cleanupTempFiles()
  })

  beforeEach(async () => {
    await dropTestCollection()
    await initMilvus(TEST_CONFIG)
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
          project: TEST_PROJECT,
          domain: 'shell'
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
          project: TEST_PROJECT,
          domain: 'shell'
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
  })

  describe('Consolidation', () => {
    it('should find clusters of similar records', async () => {
      // Insert several similar commands
      for (let i = 0; i < 3; i++) {
        await insertRecord(createMockCommandRecord({
          command: 'npm run build',
          exitCode: 0,
          outcome: 'success',
          project: TEST_PROJECT,
          domain: 'node'
        }), TEST_CONFIG)
      }

      // Insert a different command
      await insertRecord(createMockCommandRecord({
        command: 'docker compose up',
        exitCode: 0,
        outcome: 'success',
        project: TEST_PROJECT,
        domain: 'docker'
      }), TEST_CONFIG)

      const clusters = await findSimilarClusters(0.85, TEST_CONFIG)

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
      const clusters = await findSimilarClusters(0.85, TEST_CONFIG)
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
      await insertRecord(createMockCommandRecord({
        command: 'nonexistent-stale-cmd',
        lastUsed: staleTimestamp,
        deprecated: false
      }), TEST_CONFIG)

      // Insert duplicate records
      for (let i = 0; i < 3; i++) {
        await insertRecord(createMockCommandRecord({
          command: 'pnpm build',
          successCount: i + 1,
          failureCount: 0
        }), TEST_CONFIG)
      }

      // Insert a valid fresh record
      await insertRecord(createMockCommandRecord({
        command: 'git status',
        lastUsed: Date.now()
      }), TEST_CONFIG)

      // Check counts before maintenance
      const beforeRecords = await queryRecords({ filter: 'deprecated == false' }, TEST_CONFIG)
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
      const clusters = await findSimilarClusters(0.85, TEST_CONFIG)
      for (const cluster of clusters) {
        await consolidateCluster(cluster, TEST_CONFIG)
      }

      // Check counts after maintenance
      const afterRecords = await queryRecords({ filter: 'deprecated == false' }, TEST_CONFIG)

      // Should have fewer non-deprecated records
      expect(afterRecords.length).toBeLessThan(beforeRecords.length)
    })
  })
})
