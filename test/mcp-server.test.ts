import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/lib/config.js'
import { embed } from '../src/lib/embed.js'
import { getRecord, hybridSearch, initLanceDB, updateRecord } from '../src/lib/lancedb.js'
import { markDeprecated } from '../src/lib/maintenance/operations.js'
import { loadSettings } from '../src/lib/settings.js'
import { DEFAULT_CONFIG } from '../src/lib/types.js'
import type { MemoryRecord } from '../src/lib/types.js'
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
const mockedUpdateRecord = vi.mocked(updateRecord)
const mockedMarkDeprecated = vi.mocked(markDeprecated)

const LIVE_DISCOVERY: MemoryRecord = {
  id: 'rec-1',
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
    minSemanticSimilarity: 0.7,
    usageRatioWeight: 0.2,
    maxKeywordQueries: 4
  } as ReturnType<typeof loadSettings>)
  mockedEmbed.mockResolvedValue([0.1, 0.2, 0.3])
  mockedHybridSearch.mockResolvedValue([])
})

describe('MCP search_memories', () => {
  it('passes discrete fallback keyword needles while embedding the full query', async () => {
    await runSearchMemoriesTool({
      query: 'arda mikrotik',
      limit: 10
    })

    expect(mockedInitLanceDB).toHaveBeenCalledTimes(1)
    expect(mockedEmbed).toHaveBeenCalledWith('arda mikrotik', DEFAULT_CONFIG)
    expect(mockedHybridSearch).toHaveBeenCalledTimes(1)
    expect(mockedHybridSearch.mock.calls[0][0]).toMatchObject({
      query: 'arda mikrotik',
      keywordQueries: ['arda', 'mikrotik'],
      embedding: [0.1, 0.2, 0.3],
      vectorWeight: 1,
      keywordWeight: 1
    })
  })
})

describe('MCP update_memory', () => {
  it('applies only provided fields and returns the updated record', async () => {
    mockedGetRecord.mockResolvedValue({ ...LIVE_DISCOVERY })
    mockedUpdateRecord.mockResolvedValue(true)

    const result = await runUpdateMemoryTool({ id: 'rec-1', what: 'corrected claim' })

    expect(result.isError).toBeUndefined()
    expect(mockedUpdateRecord).toHaveBeenCalledWith('rec-1', { what: 'corrected claim' }, expect.anything())
  })

  it('rejects unknown records', async () => {
    mockedGetRecord.mockResolvedValue(null)

    const result = await runUpdateMemoryTool({ id: 'missing', what: 'x' })

    expect(result.isError).toBe(true)
    expect(mockedUpdateRecord).not.toHaveBeenCalled()
  })

  it('rejects deprecated records instead of resurrecting them', async () => {
    mockedGetRecord.mockResolvedValue({ ...LIVE_DISCOVERY, deprecated: true })

    const result = await runUpdateMemoryTool({ id: 'rec-1', what: 'x' })

    expect(result.isError).toBe(true)
    expect(mockedUpdateRecord).not.toHaveBeenCalled()
  })

  it('rejects empty updates including blank strings', async () => {
    mockedGetRecord.mockResolvedValue({ ...LIVE_DISCOVERY })

    const result = await runUpdateMemoryTool({ id: 'rec-1', what: '   ' })

    expect(result.isError).toBe(true)
    expect(mockedUpdateRecord).not.toHaveBeenCalled()
  })
})

describe('MCP deprecate_memory', () => {
  it('marks the record deprecated with mcp provenance', async () => {
    mockedGetRecord.mockResolvedValue({ ...LIVE_DISCOVERY })
    mockedMarkDeprecated.mockResolvedValue(true)

    const result = await runDeprecateMemoryTool({ id: 'rec-1', reason: 'falsified by direct measurement' })

    expect(result.isError).toBeUndefined()
    expect(mockedMarkDeprecated).toHaveBeenCalledWith(
      'rec-1',
      expect.anything(),
      { reason: 'manual:mcp: falsified by direct measurement' }
    )
  })

  it('refuses to double-deprecate', async () => {
    mockedGetRecord.mockResolvedValue({ ...LIVE_DISCOVERY, deprecated: true })

    const result = await runDeprecateMemoryTool({ id: 'rec-1', reason: 'already dead but trying anyway' })

    expect(result.isError).toBe(true)
    expect(mockedMarkDeprecated).not.toHaveBeenCalled()
  })
})
