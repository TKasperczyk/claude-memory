import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/lib/config.js'
import { embed } from '../src/lib/embed.js'
import { hybridSearch, initLanceDB } from '../src/lib/lancedb.js'
import { loadSettings } from '../src/lib/settings.js'
import { DEFAULT_CONFIG } from '../src/lib/types.js'
import { runSearchMemoriesTool } from '../src/mcp-server.js'

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
  fetchRecordsByIds: vi.fn()
}))

vi.mock('../src/lib/settings.js', () => ({
  loadSettings: vi.fn()
}))

const mockedLoadConfig = vi.mocked(loadConfig)
const mockedEmbed = vi.mocked(embed)
const mockedHybridSearch = vi.mocked(hybridSearch)
const mockedInitLanceDB = vi.mocked(initLanceDB)
const mockedLoadSettings = vi.mocked(loadSettings)

describe('MCP search_memories', () => {
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
