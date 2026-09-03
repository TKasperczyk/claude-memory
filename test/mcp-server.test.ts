import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/lib/config.js'
import { embed } from '../src/lib/embed.js'
import { getRecord, hybridSearch, initLanceDB, resolveMemoryRecord, updateRecord } from '../src/lib/lancedb.js'
import { markDeprecated } from '../src/lib/maintenance/operations.js'
import { loadSettings } from '../src/lib/settings.js'
import { DEFAULT_SETTINGS } from '../src/lib/settings-schema.js'
import { DEFAULT_CONFIG } from '../src/lib/types.js'
import type { HybridSearchResult, MemoryRecord } from '../src/lib/types.js'
import { runDeprecateMemoryTool, runSearchMemoriesTool, runUpdateMemoryTool } from '../src/mcp-server.js'

vi.mock('../src/lib/config.js', () => ({
  loadConfig: vi.fn()
}))

vi.mock('../src/lib/embed.js', () => ({
  embed: vi.fn()
}))

vi.mock('../src/lib/lancedb.js', () => ({
  initLanceDB: vi.fn(),
  closeLanceDB: vi.fn(),
  hybridSearch: vi.fn(),
  computeUsageRatio: vi.fn(() => 0),
    fetchRecordsByIds: vi.fn(),
    getRecord: vi.fn(),
    resolveMemoryRecord: vi.fn(),
    updateRecord: vi.fn()
}))

vi.mock('../src/lib/maintenance/operations.js', () => ({
  markDeprecated: vi.fn()
}))

vi.mock('../src/lib/settings.js', () => ({
  loadSettings: vi.fn()
}))

const mockedLoadConfig = vi.mocked(loadConfig)
const mockedEmbed = vi.mocked(embed)
const mockedHybridSearch = vi.mocked(hybridSearch)
const mockedInitLanceDB = vi.mocked(initLanceDB)
const mockedLoadSettings = vi.mocked(loadSettings)
const mockedGetRecord = vi.mocked(getRecord)
const mockedResolveMemoryRecord = vi.mocked(resolveMemoryRecord)
const mockedUpdateRecord = vi.mocked(updateRecord)
const mockedMarkDeprecated = vi.mocked(markDeprecated)

const LIVE_ID = '12345678-1234-4123-8123-123456789abc'

const LIVE_DISCOVERY: MemoryRecord = {
  id: LIVE_ID,
  type: 'discovery',
  scope: 'project',
  project: '/tmp/proj',
  timestamp: 1,
  what: 'stale claim',
  where: 'somewhere',
  confidence: 'verified',
  deprecated: false
} as MemoryRecord

beforeEach(() => {
  vi.clearAllMocks()
  mockedLoadConfig.mockReturnValue(DEFAULT_CONFIG)
  mockedLoadSettings.mockReturnValue({
    ...DEFAULT_SETTINGS,
    maxKeywordQueries: 4
  })
  mockedEmbed.mockResolvedValue([0.1, 0.2, 0.3])
  mockedHybridSearch.mockResolvedValue([])
  mockedResolveMemoryRecord.mockResolvedValue({
    status: 'resolved',
    record: { ...LIVE_DISCOVERY },
    matchedBy: 'exact'
  })
})

describe('MCP search_memories', () => {
  it('uses the shared ranked search with overfetched, hard-scoped channels', async () => {
    await runSearchMemoriesTool({
      query: 'arda mikrotik',
      project: '/tmp/proj',
      limit: 10
    })

    expect(mockedInitLanceDB).toHaveBeenCalledTimes(1)
    expect(mockedEmbed).toHaveBeenCalledWith('arda mikrotik', DEFAULT_CONFIG)
    expect(mockedHybridSearch).toHaveBeenCalledTimes(2)
    expect(mockedHybridSearch.mock.calls[0][0]).toMatchObject({
      keywordQueries: ['arda', 'mikrotik'],
      limit: 30,
      project: '/tmp/proj',
      vectorWeight: 0,
      keywordWeight: 1,
      includeEmbeddings: true
    })
    expect(mockedHybridSearch.mock.calls[1][0]).toMatchObject({
      embedding: [0.1, 0.2, 0.3],
      limit: 30,
      project: '/tmp/proj',
      vectorWeight: 1,
      keywordWeight: 0,
      includeEmbeddings: true
    })
  })

  it('keeps keyword-only junk but re-scores it below a strong semantic match', async () => {
    mockedLoadSettings.mockReturnValue({
      ...DEFAULT_SETTINGS,
      maxKeywordQueries: 4,
      minScore: 0
    })
    mockedEmbed.mockResolvedValue([1, 0])
    const junk: HybridSearchResult = {
      record: { ...LIVE_DISCOVERY, id: 'junk-record', embedding: [0, 1] },
      score: 1,
      similarity: 0,
      keywordMatch: true
    }
    const semantic: HybridSearchResult = {
      record: { ...LIVE_DISCOVERY, id: 'semantic-record', embedding: [0.8, 0.2] },
      score: 0.8,
      similarity: 0.8,
      keywordMatch: false
    }
    const rawScoreOrder = [junk, semantic]
      .sort((a, b) => b.score - a.score)
      .map(item => item.record.id)
    expect(rawScoreOrder).toEqual(['junk-record', 'semantic-record'])

    const suppliedCandidateIds: string[] = []
    mockedHybridSearch.mockImplementation(async params => {
      const candidates = params.vectorWeight === 0
        ? [junk]
        : params.keywordWeight === 0
          ? [semantic]
          : [junk, semantic]
      suppliedCandidateIds.push(...candidates.map(item => item.record.id))
      return candidates
    })

    const result = await runSearchMemoriesTool({
      query: 'specific DDR5 part number',
      project: '/tmp/proj',
      limit: 2
    })

    const payload = JSON.parse(result.content[0].text) as Array<{ id: string; score: number; embedding?: number[] }>
    expect(mockedHybridSearch).toHaveBeenCalledTimes(2)
    expect(suppliedCandidateIds.sort()).toEqual(['junk-record', 'semantic-record'])
    expect(payload).toHaveLength(2)
    expect(payload.map(item => item.id)).toEqual(['semantic-record', 'junk-record'])
    expect(payload[0].score).toBeGreaterThan(payload[1].score)
    expect(payload.every(item => item.embedding === undefined)).toBe(true)
  })

  it('explicitly falls back to raw keyword ranking when embedding fails', async () => {
    mockedEmbed.mockRejectedValue(new Error('embedding unavailable'))
    mockedHybridSearch.mockResolvedValueOnce([{
      record: { ...LIVE_DISCOVERY, id: 'keyword-fallback', embedding: [0, 1] },
      score: 1,
      similarity: 0,
      keywordMatch: true
    }])

    const result = await runSearchMemoriesTool({ query: 'DDR5 fallback', project: '/tmp/proj', limit: 10 })

    const payload = JSON.parse(result.content[0].text) as Array<{ id: string; score: number; similarity: number }>
    expect(payload).toEqual([expect.objectContaining({ id: 'keyword-fallback', score: 1, similarity: 0 })])
    expect(mockedHybridSearch).toHaveBeenCalledTimes(1)
    expect(mockedHybridSearch.mock.calls[0][0]).toMatchObject({ vectorWeight: 0, keywordWeight: 1 })
  })
})

describe('MCP update_memory', () => {
  it('resolves a prefix and applies updates to the canonical full ID', async () => {
    mockedResolveMemoryRecord.mockResolvedValue({
      status: 'resolved',
      record: { ...LIVE_DISCOVERY },
      matchedBy: 'prefix'
    })
    mockedGetRecord.mockResolvedValue({ ...LIVE_DISCOVERY, what: 'corrected claim' })
    mockedUpdateRecord.mockResolvedValue(true)

    const result = await runUpdateMemoryTool({ id: '12345678', what: 'corrected claim' })

    expect(result.isError).toBeUndefined()
    expect(mockedUpdateRecord).toHaveBeenCalledWith(LIVE_ID, { what: 'corrected claim' }, expect.anything())
    expect(mockedGetRecord).toHaveBeenCalledWith(LIVE_ID, expect.anything())
    expect(JSON.parse(result.content[0].text).record.id).toBe(LIVE_ID)
  })

  it('rejects unknown records', async () => {
    mockedResolveMemoryRecord.mockResolvedValue({ status: 'not_found', identifier: 'missing0' })

    const result = await runUpdateMemoryTool({ id: 'missing0', what: 'x' })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('use search_memories')
    expect(mockedUpdateRecord).not.toHaveBeenCalled()
  })

  it('rejects ambiguous prefixes with instructions to use a longer ID', async () => {
    mockedResolveMemoryRecord.mockResolvedValue({
      status: 'ambiguous',
      identifier: '12345678',
      matchingIds: [LIVE_ID, '12345678-ffff-4fff-8fff-ffffffffffff']
    })

    const result = await runUpdateMemoryTool({ id: '12345678', what: 'x' })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('matches multiple records')
    expect(result.content[0].text).toContain('longer prefix')
    expect(mockedUpdateRecord).not.toHaveBeenCalled()
  })

  it('rejects prefixes shorter than the safe minimum', async () => {
    mockedResolveMemoryRecord.mockResolvedValue({
      status: 'prefix_too_short',
      identifier: '1234',
      minimumLength: 8
    })

    const result = await runUpdateMemoryTool({ id: '1234', what: 'x' })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('at least 8 characters')
    expect(mockedUpdateRecord).not.toHaveBeenCalled()
  })

  it('rejects deprecated records instead of resurrecting them', async () => {
    mockedResolveMemoryRecord.mockResolvedValue({
      status: 'resolved',
      record: { ...LIVE_DISCOVERY, deprecated: true },
      matchedBy: 'prefix'
    })

    const result = await runUpdateMemoryTool({ id: '12345678', what: 'x' })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain(LIVE_ID)
    expect(mockedUpdateRecord).not.toHaveBeenCalled()
  })

  it('rejects empty updates including blank strings', async () => {
    const result = await runUpdateMemoryTool({ id: LIVE_ID, what: '   ' })

    expect(result.isError).toBe(true)
    expect(mockedUpdateRecord).not.toHaveBeenCalled()
  })
})

describe('MCP deprecate_memory', () => {
  it('marks the canonical full record ID deprecated with mcp provenance', async () => {
    mockedResolveMemoryRecord.mockResolvedValue({
      status: 'resolved',
      record: { ...LIVE_DISCOVERY },
      matchedBy: 'prefix'
    })
    mockedMarkDeprecated.mockResolvedValue(true)

    const result = await runDeprecateMemoryTool({ id: '12345678', reason: 'falsified by direct measurement' })

    expect(result.isError).toBeUndefined()
    expect(mockedMarkDeprecated).toHaveBeenCalledWith(
      LIVE_ID,
      expect.anything(),
      { reason: 'manual:mcp: falsified by direct measurement' }
    )
    expect(JSON.parse(result.content[0].text).deprecated).toBe(LIVE_ID)
  })

  it('refuses to double-deprecate', async () => {
    mockedResolveMemoryRecord.mockResolvedValue({
      status: 'resolved',
      record: { ...LIVE_DISCOVERY, deprecated: true },
      matchedBy: 'prefix'
    })

    const result = await runDeprecateMemoryTool({ id: '12345678', reason: 'already dead but trying anyway' })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain(LIVE_ID)
    expect(mockedMarkDeprecated).not.toHaveBeenCalled()
  })
})
