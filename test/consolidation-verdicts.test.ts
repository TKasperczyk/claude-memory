import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JsonStore } from '../src/lib/file-store.js'
import {
  buildConsolidationDurableContentHash,
  buildConsolidationVerdictKey,
  cleanupConsolidationNoMergeVerdicts,
  loadConsolidationNoMergeVerdict,
  saveConsolidationNoMergeVerdict
} from '../src/lib/maintenance/consolidation-verdicts.js'
import { createMockCommandRecord, createMockDiscoveryRecord, createMockWarningRecord } from './helpers.js'

let storageRoot = ''

beforeEach(async () => {
  storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-memory-consolidation-verdicts-'))
})

afterEach(async () => {
  await fs.rm(storageRoot, { recursive: true, force: true })
})

function cluster() {
  return [
    createMockDiscoveryRecord({ id: 'b', what: 'Use LanceDB for embedded memory storage.', usageCount: 8 }),
    createMockDiscoveryRecord({ id: 'a', what: 'Post-session extraction stores memories in LanceDB.', usageCount: 3 })
  ]
}

describe('consolidation no-merge verdicts', () => {
  it('uses an order-independent member-set key separated by consolidation mode', () => {
    const records = cluster()

    expect(buildConsolidationVerdictKey('same-type', records)).toBe(
      buildConsolidationVerdictKey('same-type', [...records].reverse())
    )
    expect(buildConsolidationVerdictKey('same-type', records)).not.toBe(
      buildConsolidationVerdictKey('cross-type', records)
    )
    expect(buildConsolidationVerdictKey('same-type', records)).not.toBe(
      buildConsolidationVerdictKey('same-type', records.slice(0, 1))
    )
  })

  it('loads an unchanged verdict and ignores volatile usage-counter changes', () => {
    const now = Date.UTC(2026, 6, 10)
    const records = cluster()
    const saved = saveConsolidationNoMergeVerdict(
      'same-type',
      records,
      'The records overlap but preserve distinct facts.',
      'claude-sonnet-4-6',
      { collection: 'verdict-test', baseDir: storageRoot, now }
    )

    expect(saved).not.toBeNull()
    const withUpdatedCounters = records.map(record => ({
      ...record,
      usageCount: (record.usageCount ?? 0) + 100,
      retrievalCount: (record.retrievalCount ?? 0) + 200,
      lastUsed: now + 1_000
    }))
    expect(buildConsolidationDurableContentHash(withUpdatedCounters)).toBe(
      buildConsolidationDurableContentHash(records)
    )
    expect(loadConsolidationNoMergeVerdict('same-type', withUpdatedCounters, {
      collection: 'verdict-test',
      baseDir: storageRoot,
      now: now + 30 * 24 * 60 * 60 * 1000,
      backoffDays: 90
    })).toMatchObject({ reason: 'The records overlap but preserve distinct facts.' })
  })

  it('canonicalizes nested objects and order-insensitive ID arrays', () => {
    const commandA = createMockCommandRecord({
      id: 'command',
      context: { project: 'project', cwd: '/project', intent: 'build' }
    })
    const commandB = createMockCommandRecord({
      id: 'command',
      context: { intent: 'build', cwd: '/project', project: 'project' }
    })
    const warningA = createMockWarningRecord({ id: 'warning', sourceRecordIds: ['b', 'a'] })
    const warningB = createMockWarningRecord({ id: 'warning', sourceRecordIds: ['a', 'b'] })

    expect(buildConsolidationDurableContentHash([commandA, warningA])).toBe(
      buildConsolidationDurableContentHash([warningB, commandB])
    )
  })

  it('deletes invalidated verdicts only when requested and cleans up expired orphans', () => {
    const now = Date.UTC(2026, 6, 10)
    const records = cluster()
    const store = new JsonStore('consolidation-verdicts', { baseDir: storageRoot })
    const key = buildConsolidationVerdictKey('same-type', records)
    saveConsolidationNoMergeVerdict(
      'same-type',
      records,
      'Keep both.',
      'claude-sonnet-4-6',
      { collection: 'verdict-test', baseDir: storageRoot, now }
    )

    const changed = records.map(record => record.id === 'a'
      ? { ...record, what: 'Changed durable content.' }
      : record)
    expect(loadConsolidationNoMergeVerdict('same-type', changed, {
      collection: 'verdict-test',
      baseDir: storageRoot,
      now: now + 1_000,
      backoffDays: 90
    })).toBeNull()
    expect(store.exists(key, { collection: 'verdict-test' })).toBe(true)

    expect(loadConsolidationNoMergeVerdict('same-type', changed, {
      collection: 'verdict-test',
      baseDir: storageRoot,
      now: now + 1_000,
      backoffDays: 90,
      deleteInvalid: true
    })).toBeNull()
    expect(store.exists(key, { collection: 'verdict-test' })).toBe(false)

    saveConsolidationNoMergeVerdict(
      'same-type',
      records,
      'Keep both.',
      'claude-sonnet-4-6',
      { collection: 'verdict-test', baseDir: storageRoot, now }
    )

    expect(cleanupConsolidationNoMergeVerdicts({
      collection: 'verdict-test',
      baseDir: storageRoot,
      now: now + 90 * 24 * 60 * 60 * 1000,
      backoffDays: 90
    })).toBe(1)
    expect(store.exists(key, { collection: 'verdict-test' })).toBe(false)
  })
})
