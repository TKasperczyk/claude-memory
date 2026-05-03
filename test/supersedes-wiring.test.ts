import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMBEDDING_DIM, type CommandRecord, type TokenUsage } from '../src/lib/types.js'
import { handlePostSession, buildUpdates } from '../src/hooks/post-session.js'
import { coerceExtractionResult, extractRecords } from '../src/lib/extract.js'
import { findSimilar, insertRecord, updateRecord } from '../src/lib/lancedb.js'
import { markDeprecated } from '../src/lib/maintenance/operations.js'
import { DEFAULT_CONFIG } from '../src/lib/types.js'
import { TEST_PROJECT } from './config.js'
import { cleanupTempFiles, createMockCommandRecord, createMockTranscript } from './helpers.js'

process.env.CC_MEMORIES_SETTING_EXTRACTION_MIN_TOKENS = '0'

vi.mock('../src/lib/extract.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/extract.js')>('../src/lib/extract.js')
  return {
    ...actual,
    extractRecords: vi.fn()
  }
})

vi.mock('../src/lib/lancedb.js', () => ({
  buildEmbeddingInput: vi.fn(() => ''),
  escapeFilterValue: vi.fn((value: string) => value.replace(/'/g, "''")),
  findSimilar: vi.fn(),
  insertRecord: vi.fn(),
  updateRecord: vi.fn()
}))

vi.mock('../src/lib/maintenance/operations.js', () => ({
  markDeprecated: vi.fn()
}))

const mockedExtractRecords = vi.mocked(extractRecords)
const mockedFindSimilar = vi.mocked(findSimilar)
const mockedInsertRecord = vi.mocked(insertRecord)
const mockedUpdateRecord = vi.mocked(updateRecord)
const mockedMarkDeprecated = vi.mocked(markDeprecated)

function makeEmbedding(index: number): number[] {
  const embedding = new Array<number>(EMBEDDING_DIM).fill(0)
  embedding[index] = 1
  return embedding
}

function emptyUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0
  }
}

describe('supersedes wiring', () => {
  beforeEach(() => {
    mockedExtractRecords.mockReset()
    mockedFindSimilar.mockReset()
    mockedInsertRecord.mockReset()
    mockedUpdateRecord.mockReset()
    mockedMarkDeprecated.mockReset()
    mockedFindSimilar.mockResolvedValue([])
    mockedInsertRecord.mockResolvedValue(undefined)
    mockedUpdateRecord.mockResolvedValue(true)
    mockedMarkDeprecated.mockResolvedValue(true)
  })

  it('preserves incoming supersedes on dedup updates', () => {
    const existing = createMockCommandRecord({ command: 'pnpm build' })
    const incoming = createMockCommandRecord({ command: 'pnpm build', supersedes: 'old-id' })

    expect(buildUpdates(existing, incoming).supersedes).toBe('old-id')
  })

  it('does not copy incoming supersedes when it points to the dedup-matched record', () => {
    const existing = createMockCommandRecord({ command: 'pnpm build' })
    const incoming = createMockCommandRecord({ command: 'pnpm build', supersedes: existing.id })

    expect(buildUpdates(existing, incoming).supersedes).toBeUndefined()
  })

  it('coerces extracted supersedes fields onto records', () => {
    const records = coerceExtractionResult({
      records: [{
        type: 'discovery',
        what: 'New API behavior',
        where: 'SDK docs',
        evidence: 'The newer endpoint replaces the old behavior.',
        confidence: 'verified',
        sourceExcerpt: 'SDK docs discussion',
        supersedes: 'old-memory-id'
      }]
    }, {
      sessionId: 'coerce-session',
      cwd: TEST_PROJECT,
      project: TEST_PROJECT
    })

    expect(records).toHaveLength(1)
    expect(records[0].supersedes).toBe('old-memory-id')
  })

  it('marks superseded records deprecated after extracted replacement is stored', async () => {
    const oldRecord = createMockCommandRecord({
      command: 'old-command',
      embedding: makeEmbedding(0),
      deprecated: false
    })

    const replacement: CommandRecord = createMockCommandRecord({
      command: 'new-command',
      supersedes: oldRecord.id,
      embedding: makeEmbedding(0),
      deprecated: false
    })
    mockedExtractRecords.mockResolvedValueOnce({ records: [replacement], tokenUsage: emptyUsage() })

    const transcriptPath = createMockTranscript([
      { type: 'user', message: { role: 'user', content: 'replace old command' } },
      { type: 'assistant', message: { role: 'assistant', content: 'done' } }
    ])

    const result = await handlePostSession({
      hook_event_name: 'SessionEnd',
      session_id: 'supersedes-session',
      transcript_path: transcriptPath,
      cwd: TEST_PROJECT,
      reason: 'prompt_input_exit'
    }, DEFAULT_CONFIG)

    expect(result.inserted).toBe(1)
    expect(result.updated).toBe(0)
    expect(result.supersedesMissing).toBe(0)
    expect(mockedFindSimilar).toHaveBeenCalledWith(
      replacement,
      expect.any(Number),
      1,
      DEFAULT_CONFIG,
      `id <> '${oldRecord.id}'`
    )
    expect(mockedInsertRecord).toHaveBeenCalledWith(
      expect.objectContaining({ id: replacement.id, supersedes: oldRecord.id }),
      DEFAULT_CONFIG,
      expect.anything()
    )
    expect(mockedMarkDeprecated).toHaveBeenCalledWith(oldRecord.id, DEFAULT_CONFIG, {
      supersedingRecordId: replacement.id,
      reason: `extraction:superseded-by:${replacement.id}`
    })
  })
})

afterEach(() => {
  cleanupTempFiles()
})
