import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, EMBEDDING_DIM, type MemoryRecord } from '../src/lib/types.js'
import { runConflictResolution } from '../src/lib/maintenance.js'
import { findSimilar } from '../src/lib/lancedb.js'
import { fetchRecords } from '../src/lib/maintenance/scans.js'
import { markDeprecated } from '../src/lib/maintenance/operations.js'
import { CONFLICT_ADJUDICATION_TOOL } from '../src/lib/maintenance/prompts.js'
import { createMockDiscoveryRecord } from './helpers.js'

const mockState = vi.hoisted(() => ({
  unchecked: [] as MemoryRecord[],
  matches: [] as Array<{ record: MemoryRecord; similarity: number }>,
  verdictInput: {} as Record<string, unknown>,
  llmRequest: undefined as unknown
}))

vi.mock('../src/lib/lancedb.js', () => ({
  batchUpdateRecords: vi.fn(async () => ({ updated: mockState.unchecked.length, failed: 0 })),
  buildFilter: vi.fn(() => 'deprecated = false'),
  findSimilar: vi.fn(async () => mockState.matches),
  queryRecords: vi.fn(async () => []),
  updateRecord: vi.fn(async () => true),
  vectorSearchSimilar: vi.fn(async () => [])
}))

vi.mock('../src/lib/maintenance/scans.js', () => ({
  QUERY_PAGE_SIZE: 500,
  fetchRecords: vi.fn(async () => mockState.unchecked),
  isValidEmbedding: vi.fn(() => true)
}))

vi.mock('../src/lib/maintenance/operations.js', () => ({
  markDeprecated: vi.fn(async () => true)
}))

vi.mock('../src/lib/maintenance/prompts.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/maintenance/prompts.js')>(
    '../src/lib/maintenance/prompts.js'
  )
  return {
    ...actual,
    getAnthropicClient: vi.fn(async () => ({
      messages: {
        create: vi.fn(async (request: unknown) => {
          mockState.llmRequest = request
          return {
            content: [{
              type: 'tool_use',
              id: 'toolu_conflict',
              name: actual.CONFLICT_ADJUDICATION_TOOL_NAME,
              input: mockState.verdictInput
            }]
          }
        })
      }
    }))
  }
})

function embedding(index: number): number[] {
  const vector = new Array<number>(EMBEDDING_DIM).fill(0)
  vector[index] = 1
  return vector
}

describe('conflict resolution verdict actions', () => {
  beforeEach(() => {
    mockState.unchecked = []
    mockState.matches = []
    mockState.verdictInput = {}
    mockState.llmRequest = undefined
    vi.mocked(fetchRecords).mockClear()
    vi.mocked(findSimilar).mockClear()
    vi.mocked(markDeprecated).mockClear()
  })

  it('deprecates an older candidate when the existing record is the later resolution', async () => {
    const candidate = createMockDiscoveryRecord({
      id: 'd921ef0e-864c-44e4-bd73-aab9acb63dc7',
      what: 'Remaining quality debt from code review: cli/app.ts is a 1959 LOC god-file; self/repository.ts is 1779 LOC; storage codecs are duplicated.',
      where: 'src/cli/app.ts, src/memory/self/repository.ts, src/storage',
      evidence: 'Quality review findings deferred to future sprints.',
      timestamp: Date.parse('2026-04-23T20:48:30.198Z'),
      lastConflictCheck: 0,
      embedding: embedding(0)
    })
    const existing = createMockDiscoveryRecord({
      id: '6c959156-e1a7-4bed-ba5b-a85bfccbc075',
      what: 'Sprint 27 split remaining quality debt: cli/app.ts 1959 to 75 LOC, self/repository.ts 1779 to 13 LOC re-export shim, and shared storage codecs were extracted.',
      where: 'src/cli/, src/memory/self/, src/storage/codecs.ts',
      evidence: 'Commits ed4b5e9, c1babe9, and 5fa96f6 completed the split.',
      timestamp: Date.parse('2026-04-24T09:58:25.539Z'),
      lastConflictCheck: Date.parse('2026-04-24T10:00:00.000Z'),
      embedding: embedding(1)
    })

    mockState.unchecked = [candidate]
    mockState.matches = [{ record: existing, similarity: 0.75 }]
    mockState.verdictInput = {
      verdict: 'deprecate_candidate',
      reason: 'The existing record is the later resolved state for the same quality-debt topic.',
      supersedingRecordId: existing.id
    }

    const result = await runConflictResolution(false, DEFAULT_CONFIG)

    expect(result.summary).toMatchObject({
      candidates: 1,
      pairs: 1,
      checked: 1,
      deprecatedExisting: 0,
      deprecatedNew: 1,
      keptBoth: 0
    })
    expect(result.actions).toHaveLength(1)
    expect(result.actions[0]).toMatchObject({
      type: 'deprecate',
      recordId: candidate.id,
      details: {
        verdict: 'deprecate_candidate',
        candidateId: candidate.id,
        existingId: existing.id,
        supersedingRecordId: existing.id
      }
    })
    expect(markDeprecated).toHaveBeenCalledWith(candidate.id, DEFAULT_CONFIG, {
      reason: `conflict-resolution:superseded-by:${existing.id}`,
      supersedingRecordId: existing.id
    })
  })

  it('does not deprecate a newer existing record when an older candidate receives a bad deprecate_existing verdict', async () => {
    const candidate = createMockDiscoveryRecord({
      id: 'older-candidate',
      what: 'Remaining quality debt from code review: cli/app.ts is still large.',
      where: 'src/cli/app.ts',
      evidence: 'Deferred to future sprint.',
      timestamp: Date.parse('2026-04-23T20:48:30.198Z'),
      lastConflictCheck: 0,
      embedding: embedding(0)
    })
    const existing = createMockDiscoveryRecord({
      id: 'newer-existing',
      what: 'Sprint 27 split remaining quality debt: cli/app.ts was reduced to 75 LOC.',
      where: 'src/cli/',
      evidence: 'Commit ed4b5e9 completed the split.',
      timestamp: Date.parse('2026-04-24T09:58:25.539Z'),
      embedding: embedding(1)
    })

    mockState.unchecked = [candidate]
    mockState.matches = [{ record: existing, similarity: 0.75 }]
    mockState.verdictInput = {
      verdict: 'deprecate_existing',
      reason: 'The existing record supersedes the candidate, but the emitted action is wrong.',
      supersedingRecordId: candidate.id
    }

    const result = await runConflictResolution(false, DEFAULT_CONFIG)

    expect(result.summary).toMatchObject({
      checked: 1,
      deprecatedExisting: 0,
      deprecatedNew: 0,
      keptBoth: 1
    })
    expect(result.actions).toHaveLength(0)
    expect(markDeprecated).not.toHaveBeenCalled()
  })

  it('uses action-oriented conflict verdict labels in the tool schema', () => {
    expect(CONFLICT_ADJUDICATION_TOOL.input_schema.properties?.verdict).toEqual({
      type: 'string',
      enum: ['deprecate_existing', 'deprecate_candidate', 'keep_both']
    })
  })
})
