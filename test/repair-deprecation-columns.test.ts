import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Config, MemoryRecord } from '../src/lib/types.js'

const mocks = vi.hoisted(() => ({
  batchUpdateRecords: vi.fn(),
  ensureClient: vi.fn(),
  initLanceDB: vi.fn(),
  iterateRecords: vi.fn()
}))

vi.mock('../src/lib/lancedb.js', () => ({
  batchUpdateRecords: mocks.batchUpdateRecords,
  closeLanceDB: vi.fn(),
  escapeFilterValue: (value: string) => value.replace(/'/g, "''"),
  initLanceDB: mocks.initLanceDB,
  iterateRecords: mocks.iterateRecords
}))

vi.mock('../src/lib/lancedb-client.js', () => ({
  ensureClient: mocks.ensureClient
}))

vi.mock('../src/lib/config.js', () => ({
  loadConfig: vi.fn()
}))

import { repairDeprecationColumns } from '../scripts/repair-deprecation-columns.js'

const config = {
  lancedb: { directory: '/tmp/lancedb', table: 'test_memories' },
  embeddings: { baseUrl: 'http://127.0.0.1:1234/v1', model: 'test' },
  extraction: { model: 'test', maxTokens: 1000 },
  injection: { maxRecords: 5, maxTokens: 2000 }
} satisfies Config

function makeRecord(overrides: Partial<MemoryRecord>): MemoryRecord {
  return {
    id: 'record',
    type: 'command',
    command: 'pnpm build',
    exitCode: 0,
    outcome: 'success',
    context: {
      project: '/repo',
      cwd: '/repo',
      intent: 'test'
    },
    project: '/repo',
    scope: 'project',
    timestamp: 1000,
    deprecated: true,
    embedding: [0],
    ...overrides
  } as MemoryRecord
}

function schemaWith(typeByName: Record<string, string>) {
  return {
    fields: Object.entries(typeByName).map(([name, type]) => ({
      name,
      type: { toString: () => type }
    }))
  }
}

function asyncRecordIterator(records: MemoryRecord[]): AsyncGenerator<MemoryRecord> {
  return (async function* iterator() {
    for (const record of records) {
      yield record
    }
  })()
}

describe('repair deprecation columns script', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('runs pre-check, repairs schema, verifies, and backfills metadata in order', async () => {
    const events: string[] = []
    const records = [
      makeRecord({
        id: 'deprecated-a',
        deprecatedAt: 111,
        deprecatedReason: 'consolidation:merged-into:keeper-a',
        supersedingRecordId: 'keeper-a'
      }),
      makeRecord({ id: 'deprecated-b' }),
      makeRecord({
        id: 'deprecated-c',
        deprecatedAt: 333,
        deprecatedReason: 'low-usage:unused'
      })
    ]
    const rawRows = new Map<string, Record<string, unknown>>([
      ['deprecated-a', {
        id: 'deprecated-a',
        deprecated_at: 111,
        deprecated_reason: 'consolidation:merged-into:keeper-a',
        superseding_record_id: 'keeper-a',
        content: JSON.stringify({
          deprecatedAt: 111,
          deprecatedReason: 'consolidation:merged-into:keeper-a',
          supersedingRecordId: 'keeper-a'
        })
      }],
      ['deprecated-c', {
        id: 'deprecated-c',
        deprecated_at: 333,
        deprecated_reason: 'low-usage:unused',
        superseding_record_id: null,
        content: JSON.stringify({
          deprecatedAt: 333,
          deprecatedReason: 'low-usage:unused'
        })
      }]
    ])

    let schemaCalls = 0
    let countCalls = 0
    const table = {
      schema: vi.fn(async () => {
        schemaCalls += 1
        if (schemaCalls === 1) {
          events.push('schema:pre')
          return schemaWith({
            deprecated_at: 'Null',
            deprecated_reason: 'Null',
            superseding_record_id: 'Null'
          })
        }
        events.push('schema:post')
        return schemaWith({
          deprecated_at: 'Int64',
          deprecated_reason: 'Utf8',
          superseding_record_id: 'Utf8'
        })
      }),
      countRows: vi.fn(async (filter?: string) => {
        events.push(`count:${filter}`)
        countCalls += 1
        return countCalls === 1 ? 0 : 2
      }),
      dropColumns: vi.fn(async (names: string[]) => {
        events.push(`drop:${names.join(',')}`)
      }),
      addColumns: vi.fn(async (columns: Array<{ name: string; valueSql: string }>) => {
        events.push(`add:${columns.map(column => column.name).join(',')}`)
      }),
      checkoutLatest: vi.fn(async () => {
        events.push('checkout')
      }),
      query: vi.fn(() => {
        let whereFilter = ''
        const query = {
          where: vi.fn((filter: string) => {
            whereFilter = filter
            events.push(`query:${filter}`)
            return query
          }),
          select: vi.fn(() => query),
          limit: vi.fn(() => query),
          toArray: vi.fn(async () => {
            const id = /id = '([^']+)'/.exec(whereFilter)?.[1]
            const row = id ? rawRows.get(id) : undefined
            return row ? [row] : []
          })
        }
        return query
      })
    }

    mocks.initLanceDB.mockImplementation(async () => {
      events.push('init')
    })
    mocks.ensureClient.mockResolvedValue({ table })
    mocks.iterateRecords.mockImplementation((options: { includeEmbeddings?: boolean }) => {
      events.push(options.includeEmbeddings ? 'iterate:backfill' : 'iterate:baseline')
      return asyncRecordIterator(records)
    })
    mocks.batchUpdateRecords.mockImplementation(async (batch: MemoryRecord[]) => {
      events.push(`batch:${batch.map(record => record.id).join(',')}`)
      return { updated: batch.length, failed: 0 }
    })

    const result = await repairDeprecationColumns({
      apply: true,
      collection: 'test_memories',
      config,
      preApplyDelayMs: 0
    })

    expect(table.dropColumns).toHaveBeenCalledWith([
      'deprecated_at',
      'deprecated_reason',
      'superseding_record_id'
    ])
    expect(table.addColumns).toHaveBeenCalledWith([
      { name: 'deprecated_at', valueSql: 'CAST(NULL AS BIGINT)' },
      { name: 'deprecated_reason', valueSql: 'CAST(NULL AS STRING)' },
      { name: 'superseding_record_id', valueSql: 'CAST(NULL AS STRING)' }
    ])
    expect(mocks.batchUpdateRecords).toHaveBeenCalledWith(
      [records[0], records[2]],
      {},
      config
    )
    expect(result.backfill?.recordsUpdated).toBe(2)
    expect(result.backfill?.recordsSkippedNoMetadata).toBe(1)
    expect(result.verification?.reasonColumnCount).toBe(2)
    expect(result.verification?.spotChecksPassed).toBe(2)

    expect(events.indexOf('schema:pre')).toBeLessThan(events.indexOf('drop:deprecated_at,deprecated_reason,superseding_record_id'))
    expect(events.indexOf('drop:deprecated_at,deprecated_reason,superseding_record_id')).toBeLessThan(events.indexOf('add:deprecated_at,deprecated_reason,superseding_record_id'))
    expect(events.indexOf('add:deprecated_at,deprecated_reason,superseding_record_id')).toBeLessThan(events.indexOf('schema:post'))
    expect(events.indexOf('schema:post')).toBeLessThan(events.indexOf('iterate:backfill'))
    expect(events.indexOf('iterate:backfill')).toBeLessThan(events.indexOf('batch:deprecated-a,deprecated-c'))
    expect(events.indexOf('batch:deprecated-a,deprecated-c')).toBeLessThan(events.lastIndexOf('count:deprecated_reason IS NOT NULL'))
  })
})
