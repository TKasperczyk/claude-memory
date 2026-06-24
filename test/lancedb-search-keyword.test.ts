import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type MemoryRecord } from '../src/lib/types.js'
import { ensureClient } from '../src/lib/lancedb-client.js'
import { buildKeywordFilter, hybridSearch } from '../src/lib/lancedb-search.js'

vi.mock('../src/lib/lancedb-client.js', () => ({
  ensureClient: vi.fn()
}))

const mockedEnsureClient = vi.mocked(ensureClient)

type QueryCall = {
  filter?: string
  limit?: number
}

function makeRow(id: string, command: string): Record<string, unknown> {
  const record: MemoryRecord = {
    id,
    type: 'command',
    command,
    exitCode: 0,
    outcome: 'success',
    context: {
      project: '/project',
      cwd: '/project',
      intent: 'test search'
    },
    project: '/project',
    scope: 'project',
    timestamp: 1,
    successCount: 0,
    failureCount: 0,
    retrievalCount: 0,
    usageCount: 0,
    lastUsed: 1,
    deprecated: false
  }

  return {
    id,
    type: record.type,
    content: JSON.stringify(record),
    exact_text: command,
    project: record.project,
    scope: record.scope,
    timestamp: record.timestamp,
    success_count: record.successCount,
    failure_count: record.failureCount,
    retrieval_count: record.retrievalCount,
    usage_count: record.usageCount,
    last_used: record.lastUsed,
    deprecated: record.deprecated,
    deprecated_at: null,
    deprecated_reason: null,
    superseding_record_id: null,
    generalized: false,
    last_generalization_check: 0,
    last_global_check: 0,
    last_consolidation_check: 0,
    last_conflict_check: 0,
    last_currentness_check: 0,
    last_warning_synthesis_check: 0,
    source_session_id: null,
    source_excerpt: null
  }
}

function setupKeywordTable(resolveRows: (filter: string) => Array<Record<string, unknown>>): QueryCall[] {
  const calls: QueryCall[] = []
  const table = {
    query: vi.fn(() => {
      const call: QueryCall = {}
      calls.push(call)
      const builder = {
        where: vi.fn((filter: string) => {
          call.filter = filter
          return builder
        }),
        select: vi.fn(() => builder),
        limit: vi.fn((limit: number) => {
          call.limit = limit
          return builder
        }),
        toArray: vi.fn(async () => {
          const rows = resolveRows(call.filter ?? '')
          return rows.slice(0, call.limit ?? rows.length)
        })
      }
      return builder
    })
  }

  mockedEnsureClient.mockResolvedValue({ table } as any)
  return calls
}

describe('hybridSearch keyword branch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('queries each keyword needle separately so rare needles are represented', async () => {
    const broadOne = makeRow('broad-1', 'broad network match one')
    const broadTwo = makeRow('broad-2', 'broad network match two')
    const rare = makeRow('rare-1', 'rare arda-only match')
    const calls = setupKeywordTable(filter => {
      if (filter.includes('%broad%') && filter.includes('%rare%')) return [broadOne, broadTwo]
      if (filter.includes('%broad%')) return [broadOne, broadTwo]
      if (filter.includes('%rare%')) return [rare]
      return []
    })

    const results = await hybridSearch({
      query: 'broad',
      keywordQueries: ['broad', 'rare'],
      limit: 10,
      keywordLimit: 2,
      vectorWeight: 0,
      keywordWeight: 1
    }, DEFAULT_CONFIG)

    expect(calls).toHaveLength(2)
    expect(calls.map(call => call.limit)).toEqual([1, 1])
    expect(calls[0].filter).toBe(buildKeywordFilter('broad'))
    expect(calls[1].filter).toBe(buildKeywordFilter('rare'))
    expect(results.map(result => result.record.id)).toContain('rare-1')
    expect(results.map(result => result.record.id)).not.toContain('broad-2')
  })

  it('keeps rare keyword rows through the final result limit slice', async () => {
    const broadRows = Array.from({ length: 6 }, (_, index) =>
      makeRow(`broad-${index + 1}`, `broad network match ${index + 1}`)
    )
    const rare = makeRow('rare-1', 'rare arda-only match')
    const calls = setupKeywordTable(filter => {
      if (filter.includes('%broad%')) return broadRows
      if (filter.includes('%rare%')) return [rare]
      return []
    })

    const results = await hybridSearch({
      query: 'broad',
      keywordQueries: ['broad', 'rare'],
      limit: 2,
      keywordLimit: 4,
      vectorWeight: 0,
      keywordWeight: 1
    }, DEFAULT_CONFIG)

    expect(calls).toHaveLength(2)
    expect(calls.map(call => call.limit)).toEqual([2, 2])
    expect(results.map(result => result.record.id)).toEqual(['broad-1', 'rare-1'])
  })

  it('honors keywordLimit as an aggregate cap after per-needle fetch rounding', async () => {
    const calls = setupKeywordTable(filter => {
      if (filter.includes('%alpha%')) return [makeRow('alpha-1', 'alpha match')]
      if (filter.includes('%beta%')) return [makeRow('beta-1', 'beta match')]
      if (filter.includes('%gamma%')) return [makeRow('gamma-1', 'gamma match')]
      return []
    })

    const results = await hybridSearch({
      query: 'alpha',
      keywordQueries: ['alpha', 'beta', 'gamma'],
      limit: 10,
      keywordLimit: 2,
      vectorWeight: 0,
      keywordWeight: 1
    }, DEFAULT_CONFIG)

    expect(calls).toHaveLength(3)
    expect(calls.map(call => call.limit)).toEqual([1, 1, 1])
    expect(results.map(result => result.record.id)).toEqual(['alpha-1', 'beta-1'])
  })

  it('keeps single-needle searches on the original one-query limit path', async () => {
    const singleNeedleCalls = setupKeywordTable(() => [makeRow('single-1', 'single needle match')])

    await hybridSearch({
      query: 'single',
      keywordQueries: ['single'],
      limit: 10,
      keywordLimit: 7,
      vectorWeight: 0,
      keywordWeight: 1
    }, DEFAULT_CONFIG)

    expect(singleNeedleCalls).toHaveLength(1)
    expect(singleNeedleCalls[0].filter).toBe(buildKeywordFilter(['single']))
    expect(singleNeedleCalls[0].limit).toBe(7)

    const queryFallbackCalls = setupKeywordTable(() => [makeRow('single-1', 'single needle match')])
    await hybridSearch({
      query: 'single',
      limit: 10,
      keywordLimit: 7,
      vectorWeight: 0,
      keywordWeight: 1
    }, DEFAULT_CONFIG)

    expect(queryFallbackCalls).toHaveLength(1)
    expect(queryFallbackCalls[0]).toEqual(singleNeedleCalls[0])
  })
})
