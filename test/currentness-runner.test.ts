import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, EMBEDDING_DIM, type DiscoveryRecord, type MemoryRecord } from '../src/lib/types.js'
import { runCurrentnessCheck } from '../src/lib/maintenance/runners/currentness-runner.js'
import { vectorSearchSimilar } from '../src/lib/lancedb.js'
import { fetchRecords } from '../src/lib/maintenance/scans.js'
import { markDeprecated } from '../src/lib/maintenance/operations.js'
import { createMockDiscoveryRecord } from './helpers.js'

const mockState = vi.hoisted(() => ({
  records: [] as DiscoveryRecord[],
  verdictInput: {} as Record<string, unknown>
}))

vi.mock('../src/lib/lancedb.js', () => ({
  buildFilter: vi.fn(() => 'project = \'/tmp/e2e-test-project\' AND type = \'discovery\' AND deprecated = false'),
  vectorSearchSimilar: vi.fn(async (embedding: number[]) => {
    const seed = mockState.records.find(record => record.embedding === embedding)
    if (!seed || seed.id !== 'sprint-25-state') return []
    return mockState.records
      .filter(record => record.id !== seed.id)
      .map(record => ({ record, similarity: 0.74 }))
  })
}))

vi.mock('../src/lib/maintenance/scans.js', () => ({
  fetchRecords: vi.fn(async () => mockState.records),
  isValidEmbedding: vi.fn((embedding: unknown) => Array.isArray(embedding) && embedding.length === EMBEDDING_DIM)
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
        create: vi.fn(async () => ({
          content: [{
            type: 'tool_use',
            id: 'toolu_currentness',
            name: actual.CURRENTNESS_TOOL_NAME,
            input: mockState.verdictInput
          }]
        }))
      }
    }))
  }
})

function embedding(index: number): number[] {
  const vector = new Array<number>(EMBEDDING_DIM).fill(0)
  vector[index] = 1
  return vector
}

function sprintDiscovery(id: string, what: string, timestamp: string, index: number): DiscoveryRecord {
  return createMockDiscoveryRecord({
    id,
    what,
    where: '/home/luthriel/Programming/borg',
    evidence: 'Sprint notes and test output.',
    timestamp: Date.parse(timestamp),
    embedding: embedding(index)
  })
}

describe('currentness runner', () => {
  beforeEach(() => {
    mockState.records = []
    mockState.verdictInput = {}
    vi.mocked(fetchRecords).mockClear()
    vi.mocked(vectorSearchSimilar).mockClear()
    vi.mocked(markDeprecated).mockClear()
  })

  it('deprecates superseded sprint-progression discoveries with superseding metadata', async () => {
    const current = sprintDiscovery(
      'sprint-96-queue',
      'Remaining sprint queue after Sprint 9.6: trivial cleanup, OQ tightening, and simulator follow-ups remain current.',
      '2026-05-10T07:30:10.197Z',
      4
    )
    const historical = sprintDiscovery(
      'sprint-31-summary',
      'Current state after Sprint 31a-33: shipped review fixes and captured historical remediation context.',
      '2026-04-28T09:00:00.000Z',
      3
    )
    const supersededRecords = [
      sprintDiscovery(
        'sprint-25-state',
        'Borg project current state after Sprint 25: early sprint numbering and 417 tests.',
        '2026-04-23T09:00:00.000Z',
        0
      ),
      sprintDiscovery(
        'sprint-8d-queue',
        'Remaining sprint queue after Sprint 8d.6: OQ resolution selection and semantic graph work remain.',
        '2026-05-09T21:30:43.653Z',
        1
      ),
      sprintDiscovery(
        'test-count-old',
        'Borg project test count progression snapshot: Sprint 6c to 6d reached 1268 tests.',
        '2026-05-09T22:00:00.000Z',
        2
      )
    ]

    mockState.records = [supersededRecords[0], supersededRecords[1], supersededRecords[2], historical, current]
    mockState.verdictInput = {
      records: [
        ...supersededRecords.map(record => ({
          id: record.id,
          verdict: 'superseded',
          reason: 'A newer cluster record describes the current sprint state.',
          supersedingRecordId: current.id
        })),
        {
          id: historical.id,
          verdict: 'historical_useful',
          reason: 'This shipped-work summary remains useful historical context.'
        },
        {
          id: current.id,
          verdict: 'current',
          reason: 'This is the newest current sprint queue record.'
        }
      ],
      reason: 'The cluster contains successive sprint-state snapshots.'
    }

    const result = await runCurrentnessCheck(false, DEFAULT_CONFIG)

    expect(result.summary).toMatchObject({
      candidates: 5,
      clusters: 1,
      checked: 5,
      current: 1,
      historical: 1,
      deprecated: 3,
      errors: 0
    })
    expect(result.actions.map(action => action.recordId)).toEqual(supersededRecords.map(record => record.id))
    for (const record of supersededRecords) {
      expect(markDeprecated).toHaveBeenCalledWith(record.id, DEFAULT_CONFIG, {
        reason: `currentness:superseded-by:${current.id}`,
        supersedingRecordId: current.id
      })
    }
  })
})
