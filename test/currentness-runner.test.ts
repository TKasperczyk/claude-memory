import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, EMBEDDING_DIM, type DiscoveryRecord } from '../src/lib/types.js'
import type { MaintenanceSettings } from '../src/lib/settings.js'
import { DEFAULT_MAINTENANCE_SETTINGS } from '../src/lib/settings-schema.js'
import { runCurrentnessCheck } from '../src/lib/maintenance/runners/currentness-runner.js'
import { batchUpdateRecords, vectorSearchSimilar } from '../src/lib/lancedb.js'
import { fetchRecords } from '../src/lib/maintenance/scans.js'
import { markDeprecated } from '../src/lib/maintenance/operations.js'
import { createMockDiscoveryRecord } from './helpers.js'

const mockState = vi.hoisted(() => ({
  records: [] as DiscoveryRecord[],
  matchesBySeed: new Map<string, string[]>(),
  verdictInput: {} as Record<string, unknown>
}))

vi.mock('../src/lib/lancedb.js', () => ({
  batchUpdateRecords: vi.fn(async () => ({ updated: mockState.records.length, failed: 0 })),
  buildFilter: vi.fn((filters: { project?: string; type?: string; excludeId?: string; excludeDeprecated?: boolean }) => {
    const parts: string[] = []
    if (filters.project) parts.push(`project = '${filters.project}'`)
    if (filters.type) parts.push(`type = '${filters.type}'`)
    if (filters.excludeId) parts.push(`id <> '${filters.excludeId}'`)
    if (filters.excludeDeprecated) parts.push('deprecated = false')
    return parts.join(' AND ')
  }),
  vectorSearchSimilar: vi.fn(async (embedding: number[]) => {
    const seed = mockState.records.find(record => record.embedding === embedding)
    if (!seed) return []
    const matchIds = mockState.matchesBySeed.get(seed.id) ?? []
    return matchIds
      .map(id => mockState.records.find(record => record.id === id))
      .filter((record): record is DiscoveryRecord => Boolean(record))
      .map(record => ({ record, similarity: 0.74 }))
  })
}))

vi.mock('../src/lib/maintenance/scans.js', () => ({
  fetchRecords: vi.fn(async (filter?: string) => {
    if (filter?.startsWith('id IN')) {
      return mockState.records.filter(record => filter.includes(`'${record.id}'`))
    }
    return mockState.records
  }),
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

const settings: MaintenanceSettings = {
  ...DEFAULT_MAINTENANCE_SETTINGS,
  currentnessRecheckDays: 7
}

function embedding(index: number): number[] {
  const vector = new Array<number>(EMBEDDING_DIM).fill(0)
  vector[index] = 1
  return vector
}

function discovery(id: string, what: string, timestamp: string, index: number): DiscoveryRecord {
  return createMockDiscoveryRecord({
    id,
    what,
    where: '/home/luthriel/Programming/borg',
    evidence: 'Repository inspection and test output.',
    timestamp: Date.parse(timestamp),
    embedding: embedding(index)
  })
}

describe('currentness runner', () => {
  beforeEach(() => {
    mockState.records = []
    mockState.matchesBySeed = new Map<string, string[]>()
    mockState.verdictInput = {}
    vi.mocked(fetchRecords).mockClear()
    vi.mocked(vectorSearchSimilar).mockClear()
    vi.mocked(batchUpdateRecords).mockClear()
    vi.mocked(markDeprecated).mockClear()
  })

  it('uses embedding clusters instead of English currentness keywords', async () => {
    const oldTools = discovery(
      'finalizer-tools-12',
      "The finalizer's tools array contains 12 internal tools.",
      '2026-05-08T09:00:00.000Z',
      0
    )
    const currentTools = discovery(
      'finalizer-tools-3',
      "The finalizer's tools array contains 3 emission tools.",
      '2026-05-10T09:00:00.000Z',
      1
    )
    const unrelated = discovery(
      'unrelated-cache',
      'The cache writer persists token usage events as JSONL.',
      '2026-05-10T10:00:00.000Z',
      2
    )

    mockState.records = [oldTools, currentTools, unrelated]
    mockState.matchesBySeed.set(oldTools.id, [currentTools.id])
    mockState.verdictInput = {
      records: [
        {
          id: oldTools.id,
          verdict: 'superseded',
          reason: 'The newer record gives the replacement tool count.',
          supersedingRecordId: currentTools.id
        },
        {
          id: currentTools.id,
          verdict: 'current',
          reason: 'This is the latest observed tool count.'
        }
      ],
      reason: 'The records describe the same finalizer tool array at different points in time.'
    }

    const result = await runCurrentnessCheck(false, DEFAULT_CONFIG, settings)

    expect(result.summary).toMatchObject({
      candidates: 3,
      clusters: 1,
      checked: 2,
      current: 1,
      historical: 0,
      deprecated: 1,
      errors: 0
    })
    expect(vectorSearchSimilar).toHaveBeenCalled()
    expect(result.candidates[0]?.records.map(record => record.id)).toEqual([oldTools.id, currentTools.id])
    expect(markDeprecated).toHaveBeenCalledWith(oldTools.id, DEFAULT_CONFIG, {
      reason: `currentness:superseded-by:${currentTools.id}`,
      supersedingRecordId: currentTools.id
    })
    expect(batchUpdateRecords).toHaveBeenCalledWith(
      [oldTools, currentTools],
      { lastCurrentnessCheck: expect.any(Number) },
      DEFAULT_CONFIG
    )
  })

  it('adjudicates a Polish-language topical cluster', async () => {
    const oldRecord = discovery(
      'narzedzia-finalizatora-12',
      'Tablica narzedzi finalizatora ma 12 narzedzi wewnetrznych.',
      '2026-05-08T09:00:00.000Z',
      3
    )
    const currentRecord = discovery(
      'narzedzia-finalizatora-3',
      'Tablica narzedzi finalizatora ma 3 narzedzia emisji.',
      '2026-05-10T09:00:00.000Z',
      4
    )

    mockState.records = [oldRecord, currentRecord]
    mockState.matchesBySeed.set(oldRecord.id, [currentRecord.id])
    mockState.verdictInput = {
      records: [
        {
          id: oldRecord.id,
          verdict: 'superseded',
          reason: 'Nowszy rekord opisuje aktualna liczbe narzedzi.',
          supersedingRecordId: currentRecord.id
        },
        {
          id: currentRecord.id,
          verdict: 'current',
          reason: 'To najnowszy opis tej samej tablicy narzedzi.'
        }
      ],
      reason: 'Rekordy opisuja ten sam temat w roznych momentach.'
    }

    const result = await runCurrentnessCheck(false, DEFAULT_CONFIG, settings)

    expect(result.summary).toMatchObject({
      candidates: 2,
      clusters: 1,
      checked: 2,
      current: 1,
      deprecated: 1,
      errors: 0
    })
    expect(result.candidates[0]?.records.map(record => record.id)).toEqual([oldRecord.id, currentRecord.id])
    expect(markDeprecated).toHaveBeenCalledWith(oldRecord.id, DEFAULT_CONFIG, {
      reason: `currentness:superseded-by:${currentRecord.id}`,
      supersedingRecordId: currentRecord.id
    })
  })
})
