import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type HybridSearchResult, type NearMissRecord, type RetrievalSettings } from '../src/lib/types.js'
import { retrieveContext } from '../src/lib/retrieval.js'
import { createMockCommandRecord } from './helpers.js'
import { loadSettings } from '../src/lib/settings.js'
import { closeLanceDB, hybridSearch, initLanceDB } from '../src/lib/lancedb.js'
import { embed } from '../src/lib/embed.js'
import { generateRetrievalQueryPlan } from '../src/lib/retrieval-query-generator.js'
import { recordTokenUsageEventsAsync } from '../src/lib/token-usage-events.js'
import { withTimeout } from '../src/lib/shared.js'

type BuildContextOptions = { diagnostic?: boolean; mmrExclusions?: unknown[] }

function buildContextMock(records: unknown, _config: unknown, options?: BuildContextOptions) {
  const scored = Array.isArray(records) ? records : []
  if (options?.diagnostic) {
    return {
      context: 'mock-context',
      injectedRecords: scored,
      exclusions: options?.mmrExclusions ?? []
    }
  }
  const normalized = scored.map((entry: any) => (entry && typeof entry === 'object' && 'record' in entry ? entry.record : entry))
  return { context: 'mock-context', records: normalized }
}

vi.mock('../src/lib/shared.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/shared.js')>('../src/lib/shared.js')
  return {
    ...actual,
    withTimeout: vi.fn(actual.withTimeout)
  }
})

vi.mock('../src/lib/lancedb.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/lancedb.js')>('../src/lib/lancedb.js')
  return {
    initLanceDB: vi.fn(),
    closeLanceDB: vi.fn(),
    hybridSearch: vi.fn(),
    computeUsageRatio: actual.computeUsageRatio
  }
})

vi.mock('../src/lib/embed.js', () => ({
  embed: vi.fn()
}))

vi.mock('../src/lib/retrieval-query-generator.js', () => ({
  generateRetrievalQueryPlan: vi.fn()
}))

vi.mock('../src/lib/token-usage-events.js', () => ({
  recordTokenUsageEventsAsync: vi.fn()
}))

vi.mock('../src/lib/settings.js', () => ({
  loadSettings: vi.fn()
}))

vi.mock('../src/lib/context.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/context.js')>('../src/lib/context.js')
  return {
    ...actual,
    buildContext: vi.fn(buildContextMock)
  }
})

const BASE_SETTINGS: RetrievalSettings = {
  minSemanticSimilarity: 0.7,
  minScore: 0.45,
  minSemanticOnlyScore: 0.65,
  maxRecords: 5,
  maxTokens: 2000,
  mmrLambda: 0.7,
  usageRatioWeight: 0.2,
  keywordBonus: 0.08,
  projectMatchBonus: 0.05,
  enableHaikuRetrieval: false,
  maxKeywordQueries: 4,
  maxKeywordErrors: 2,
  maxKeywordCommands: 2,
  prePromptTimeoutMs: 5000,
  haikuQueryTimeoutMs: 2500,
  maxSemanticQueryChars: 1200
}

const PROJECT_ROOT = process.cwd()

const mockedLoadSettings = vi.mocked(loadSettings)
const mockedHybridSearch = vi.mocked(hybridSearch)
const mockedEmbed = vi.mocked(embed)
const mockedGenerateRetrievalQueryPlan = vi.mocked(generateRetrievalQueryPlan)
const mockedRecordTokenUsageEventsAsync = vi.mocked(recordTokenUsageEventsAsync)
const mockedInitLanceDB = vi.mocked(initLanceDB)
const mockedCloseLanceDB = vi.mocked(closeLanceDB)
const mockedWithTimeout = vi.mocked(withTimeout)

const makeSettings = (overrides: Partial<RetrievalSettings> = {}): RetrievalSettings => ({
  ...BASE_SETTINGS,
  ...overrides
})

const makeResult = (
  id: string,
  embedding: number[],
  score: number,
  similarity: number = score,
  keywordMatch: boolean = true
): HybridSearchResult => ({
  record: createMockCommandRecord({
    id,
    command: `command-${id}`,
    embedding
  }),
  score,
  similarity,
  keywordMatch
})

beforeEach(async () => {
  vi.clearAllMocks()
  const actualShared = await vi.importActual<typeof import('../src/lib/shared.js')>('../src/lib/shared.js')
  mockedLoadSettings.mockReturnValue(makeSettings())
  mockedEmbed.mockResolvedValue([0.95, 0.05])
  mockedGenerateRetrievalQueryPlan.mockResolvedValue(null)
  mockedHybridSearch.mockResolvedValue([])
  mockedInitLanceDB.mockResolvedValue(undefined)
  mockedCloseLanceDB.mockResolvedValue(undefined)
  mockedWithTimeout.mockImplementation(actualShared.withTimeout)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('MMR re-ranking', () => {
  it('diversifies results with low lambda', async () => {
    const candidates = [
      makeResult('a', [1, 0], 0.9),
      makeResult('b', [0.99, 0.01], 0.85),
      makeResult('c', [0, 1], 0.8)
    ]

    mockedHybridSearch.mockImplementation(async params => {
      if (params.vectorWeight === 0) return candidates
      return []
    })

    const result = await retrieveContext(
      { prompt: 'find relevant memories', cwd: PROJECT_ROOT },
      DEFAULT_CONFIG,
      { projectRoot: PROJECT_ROOT, settingsOverride: { maxRecords: 2, mmrLambda: 0.2, minScore: 0.05 } }
    )

    expect(result.results.map(item => item.record.id)).toEqual(['a', 'c'])
  })

  it('follows relevance when lambda is high', async () => {
    const candidates = [
      makeResult('a', [1, 0], 0.9),
      makeResult('b', [0.99, 0.01], 0.85),
      makeResult('c', [0, 1], 0.8)
    ]

    mockedHybridSearch.mockImplementation(async params => {
      if (params.vectorWeight === 0) return candidates
      return []
    })

    const result = await retrieveContext(
      { prompt: 'find relevant memories', cwd: PROJECT_ROOT },
      DEFAULT_CONFIG,
      { projectRoot: PROJECT_ROOT, settingsOverride: { maxRecords: 2, mmrLambda: 1, minScore: 0.05 } }
    )

    expect(result.results.map(item => item.record.id)).toEqual(['a', 'b'])
  })

  it('handles empty and single result sets', async () => {
    mockedHybridSearch.mockImplementation(async params => {
      if (params.vectorWeight === 0) return []
      return []
    })

    const empty = await retrieveContext(
      { prompt: 'no hits', cwd: PROJECT_ROOT },
      DEFAULT_CONFIG,
      { projectRoot: PROJECT_ROOT }
    )

    expect(empty.results).toEqual([])
    expect(empty.context).toBeNull()

    const single = makeResult('solo', [1, 0], 0.75)
    mockedHybridSearch.mockImplementation(async params => {
      if (params.vectorWeight === 0) return [single]
      return []
    })

    const one = await retrieveContext(
      { prompt: 'single hit', cwd: PROJECT_ROOT },
      DEFAULT_CONFIG,
      { projectRoot: PROJECT_ROOT }
    )

    expect(one.results).toHaveLength(1)
    expect(one.results[0].record.id).toBe('solo')
  })
})

describe('Haiku query planning', () => {
  it('uses Haiku query plan to shape keyword search', async () => {
    mockedGenerateRetrievalQueryPlan.mockResolvedValue({
      plan: {
        resolvedQuery: 'How do I build the Docker image?',
        keywordQueries: ['docker build'],
        semanticQuery: 'Build a Docker image for this project.'
      },
      tokenUsage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0
      },
      model: 'claude-haiku-4-5-20251001'
    })

    mockedHybridSearch.mockResolvedValue([])

    await retrieveContext(
      { prompt: 'How do I build it?', cwd: PROJECT_ROOT, transcriptPath: '/tmp/fake-transcript.jsonl' },
      DEFAULT_CONFIG,
      { projectRoot: PROJECT_ROOT, settingsOverride: { enableHaikuRetrieval: true } }
    )

    const keywordCall = mockedHybridSearch.mock.calls.find(([params]) => params.vectorWeight === 0)
    expect(keywordCall?.[0].query).toBe('docker build')
  })

  it('falls back to prompt-based queries when Haiku is unavailable', async () => {
    mockedGenerateRetrievalQueryPlan.mockResolvedValue(null)

    const prompt = 'Need advice on deployment'

    await retrieveContext(
      { prompt, cwd: PROJECT_ROOT, transcriptPath: '/tmp/fake-transcript.jsonl' },
      DEFAULT_CONFIG,
      { projectRoot: PROJECT_ROOT, settingsOverride: { enableHaikuRetrieval: true } }
    )

    const keywordCall = mockedHybridSearch.mock.calls.find(([params]) => params.vectorWeight === 0)
    expect(keywordCall?.[0].query).toBe(prompt)
  })

  it('skips token usage recording when query plan omits token usage', async () => {
    mockedGenerateRetrievalQueryPlan.mockResolvedValue({
      plan: {
        resolvedQuery: 'How do I deploy?',
        keywordQueries: ['deploy'],
        semanticQuery: 'Deployment workflow'
      },
      model: 'claude-haiku-4-5-20251001'
    } as any)

    mockedHybridSearch.mockResolvedValue([])

    await retrieveContext(
      { prompt: 'How do I deploy?', cwd: PROJECT_ROOT, transcriptPath: '/tmp/fake-transcript.jsonl' },
      DEFAULT_CONFIG,
      { projectRoot: PROJECT_ROOT, settingsOverride: { enableHaikuRetrieval: true } }
    )

    expect(mockedRecordTokenUsageEventsAsync).not.toHaveBeenCalled()
  })
})

describe('Diagnostics and near misses', () => {
  it('returns near-miss details in diagnostic mode', async () => {
    const qualified = [
      makeResult('primary', [1, 0], 0.9),
      makeResult('secondary', [0, 1], 0.85)
    ]
    const nearMissRecord = createMockCommandRecord({
      id: 'near',
      command: 'near-miss',
      embedding: [0.5, 0.5]
    })
    const nearMiss: NearMissRecord = {
      record: {
        record: nearMissRecord,
        score: 0.2,
        similarity: 0.2,
        keywordMatch: false
      },
      exclusionReasons: [
        {
          reason: 'score_below_threshold',
          threshold: 0.45,
          actual: 0.2,
          gap: 0.25
        }
      ]
    }

    mockedHybridSearch.mockImplementation(async params => {
      if (!params.diagnostic) return qualified
      if (params.vectorWeight === 0) {
        return { qualified, nearMisses: [nearMiss] }
      }
      return { qualified: [], nearMisses: [] }
    })

    const result = await retrieveContext(
      { prompt: 'diagnostic search', cwd: PROJECT_ROOT },
      DEFAULT_CONFIG,
      { projectRoot: PROJECT_ROOT, diagnostic: true }
    )

    expect(result.diagnostics?.search.nearMisses).toHaveLength(1)
    expect(result.diagnostics?.search.nearMisses[0].record.record.id).toBe('near')
  })

  it('omits diagnostics in normal mode', async () => {
    const qualified = [makeResult('primary', [1, 0], 0.9)]

    mockedHybridSearch.mockResolvedValue(qualified)

    const result = await retrieveContext(
      { prompt: 'normal search', cwd: PROJECT_ROOT },
      DEFAULT_CONFIG,
      { projectRoot: PROJECT_ROOT }
    )

    expect(result.diagnostics).toBeUndefined()
  })
})

describe('Timeout handling', () => {
  it('returns timedOut when retrieval exceeds the configured timeout', async () => {
    vi.useFakeTimers()
    mockedLoadSettings.mockReturnValue(makeSettings({ prePromptTimeoutMs: 5 }))
    mockedInitLanceDB.mockImplementation(() => new Promise(() => {}))

    const pending = retrieveContext(
      { prompt: 'long running retrieval', cwd: PROJECT_ROOT },
      DEFAULT_CONFIG,
      { projectRoot: PROJECT_ROOT }
    )

    await vi.advanceTimersByTimeAsync(10)
    const result = await pending

    expect(result.timedOut).toBe(true)
    expect(result.context).toBeNull()
    expect(result.results).toEqual([])
  })
})

describe('Unified scoring', () => {
  it('re-scores keyword-only matches using cosine similarity', async () => {
    // Keyword match close to query embedding should score well
    const kwRelevant = makeResult('kw-relevant', [0.95, 0.05], 1.0, 0)
    // Keyword match far from query embedding should score poorly
    const kwIrrelevant = makeResult('kw-irrelevant', [0, 1], 1.0, 0)
    // Semantic match with moderate similarity
    const semantic = makeResult('semantic', [0.7, 0.3], 0.7, 0.7, false)

    mockedHybridSearch.mockImplementation(async params => {
      if (params.vectorWeight === 0) return [kwRelevant, kwIrrelevant]
      return [semantic]
    })

    const result = await retrieveContext(
      { prompt: 'test unified scoring', cwd: PROJECT_ROOT },
      DEFAULT_CONFIG,
      { projectRoot: PROJECT_ROOT, settingsOverride: { minScore: 0.05 } }
    )

    // kw-relevant should rank highest (high similarity + keyword bonus)
    expect(result.results[0].record.id).toBe('kw-relevant')
    // Scores should be < 1.0 (no longer inflated)
    expect(result.results[0].score).toBeLessThan(1.0)
    expect(result.results[0].score).toBeGreaterThan(0.5)
    // kw-irrelevant should rank below kw-relevant (or be filtered out entirely)
    const ids = result.results.map(r => r.record.id)
    const irrelevantIdx = ids.indexOf('kw-irrelevant')
    const relevantIdx = ids.indexOf('kw-relevant')
    expect(irrelevantIdx === -1 || irrelevantIdx > relevantIdx).toBe(true)
  })

  it('filters out keyword matches with low semantic relevance', async () => {
    // Keyword match with very low similarity to query
    const kwJunk = makeResult('junk', [0, 1], 1.0, 0)

    mockedHybridSearch.mockImplementation(async params => {
      if (params.vectorWeight === 0) return [kwJunk]
      return []
    })

    const result = await retrieveContext(
      { prompt: 'test filtering', cwd: PROJECT_ROOT },
      DEFAULT_CONFIG,
      { projectRoot: PROJECT_ROOT }
    )

    // With default minScore=0.45 and low similarity, keyword junk gets filtered
    expect(result.results).toHaveLength(0)
  })

  it('boosts project-matching memories over non-matching ones', async () => {
    // Two results with identical embeddings and similarity, but different projects
    const projectMatch = makeResult('project-match', [0.8, 0.2], 0.7, 0.7, false)
    projectMatch.record.project = PROJECT_ROOT
    const nonMatch = makeResult('non-match', [0.8, 0.2], 0.7, 0.7, false)
    nonMatch.record.project = '/some/other/project'

    mockedHybridSearch.mockImplementation(async params => {
      if (params.vectorWeight === 0) return []
      return [nonMatch, projectMatch] // non-match listed first
    })

    const result = await retrieveContext(
      { prompt: 'test project boost', cwd: PROJECT_ROOT },
      DEFAULT_CONFIG,
      { projectRoot: PROJECT_ROOT, settingsOverride: { minScore: 0.05 } }
    )

    expect(result.results.length).toBe(2)
    // Project-matching memory should rank first due to projectMatchBonus
    expect(result.results[0].record.id).toBe('project-match')
    expect(result.results[0].score).toBeGreaterThan(result.results[1].score)
  })

  it('falls back to original keyword scores when embedding generation fails', async () => {
    mockedEmbed.mockRejectedValue(new Error('Embedding service down'))

    const kwResult = makeResult('kw', [1, 0], 1.0, 0)

    mockedHybridSearch.mockImplementation(async params => {
      if (params.vectorWeight === 0) return [kwResult]
      return []
    })

    const result = await retrieveContext(
      { prompt: 'keyword only fallback', cwd: PROJECT_ROOT },
      DEFAULT_CONFIG,
      { projectRoot: PROJECT_ROOT }
    )

    // Should still return the keyword match with original scoring
    expect(result.results).toHaveLength(1)
    expect(result.results[0].record.id).toBe('kw')
    expect(result.results[0].score).toBeGreaterThanOrEqual(1.0)
  })
})

describe('Keyword query normalization', () => {
  const HAIKU_TOKEN_USAGE = {
    inputTokens: 10, outputTokens: 5,
    cacheCreationInputTokens: 0, cacheReadInputTokens: 0
  }

  it('passes all keyword queries through without substring dedup', async () => {
    mockedGenerateRetrievalQueryPlan.mockResolvedValue({
      plan: {
        resolvedQuery: 'p4 brain configuration',
        keywordQueries: ['p4 brain', 'p4', 'brain'],
        semanticQuery: 'p4 brain configuration'
      },
      tokenUsage: HAIKU_TOKEN_USAGE,
      model: 'claude-haiku-4-5-20251001'
    })
    mockedHybridSearch.mockResolvedValue([])

    await retrieveContext(
      { prompt: 'p4 brain', cwd: PROJECT_ROOT, transcriptPath: '/tmp/fake-transcript.jsonl' },
      DEFAULT_CONFIG,
      { projectRoot: PROJECT_ROOT, settingsOverride: { enableHaikuRetrieval: true } }
    )

    // All 3 keywords should be searched in a single batched call
    const keywordCalls = mockedHybridSearch.mock.calls.filter(([params]) => params.vectorWeight === 0)
    expect(keywordCalls).toHaveLength(1)
    const keywordQueries = keywordCalls[0][0].keywordQueries
    expect(keywordQueries).toContain('p4 brain')
    expect(keywordQueries).toContain('p4')
    expect(keywordQueries).toContain('brain')
  })

  it('extracts proper nouns from multi-word keywords', async () => {
    mockedGenerateRetrievalQueryPlan.mockResolvedValue({
      plan: {
        resolvedQuery: 'Find my Jira issue about Grafana statistics',
        keywordQueries: ['jira issue', 'grafana statistics'],
        semanticQuery: 'Find a Jira issue about Grafana statistics'
      },
      tokenUsage: HAIKU_TOKEN_USAGE,
      model: 'claude-haiku-4-5-20251001'
    })
    mockedHybridSearch.mockResolvedValue([])

    await retrieveContext(
      { prompt: 'find my jira issue about grafana statistics', cwd: PROJECT_ROOT, transcriptPath: '/tmp/fake-transcript.jsonl' },
      DEFAULT_CONFIG,
      { projectRoot: PROJECT_ROOT, settingsOverride: { enableHaikuRetrieval: true } }
    )

    const keywordCalls = mockedHybridSearch.mock.calls.filter(([params]) => params.vectorWeight === 0)
    expect(keywordCalls).toHaveLength(1)
    const keywordQueries = keywordCalls[0][0].keywordQueries
    // "jira" and "grafana" extracted as proper nouns from compounds
    expect(keywordQueries).toContain('jira issue')
    expect(keywordQueries).toContain('jira')
    expect(keywordQueries).toContain('grafana statistics')
    expect(keywordQueries).toContain('grafana')
  })

  it('does not duplicate when proper noun already present as keyword', async () => {
    mockedGenerateRetrievalQueryPlan.mockResolvedValue({
      plan: {
        resolvedQuery: 'Configure Redis cluster settings',
        keywordQueries: ['Redis cluster', 'redis', 'cluster settings'],
        semanticQuery: 'Configure Redis cluster settings'
      },
      tokenUsage: HAIKU_TOKEN_USAGE,
      model: 'claude-haiku-4-5-20251001'
    })
    mockedHybridSearch.mockResolvedValue([])

    await retrieveContext(
      { prompt: 'configure redis cluster', cwd: PROJECT_ROOT, transcriptPath: '/tmp/fake-transcript.jsonl' },
      DEFAULT_CONFIG,
      { projectRoot: PROJECT_ROOT, settingsOverride: { enableHaikuRetrieval: true } }
    )

    const keywordCalls = mockedHybridSearch.mock.calls.filter(([params]) => params.vectorWeight === 0)
    expect(keywordCalls).toHaveLength(1)
    const keywordQueries = keywordCalls[0][0].keywordQueries
    // "redis" already present (case-insensitive), should not be duplicated
    const redisCount = keywordQueries.filter((q: string) => q.toLowerCase() === 'redis').length
    expect(redisCount).toBe(1)
  })

  it('handles all-caps proper nouns like AWS and S3', async () => {
    mockedGenerateRetrievalQueryPlan.mockResolvedValue({
      plan: {
        resolvedQuery: 'Configure AWS S3 bucket policy',
        keywordQueries: ['AWS S3 bucket', 'bucket policy'],
        semanticQuery: 'Configure AWS S3 bucket policy'
      },
      tokenUsage: HAIKU_TOKEN_USAGE,
      model: 'claude-haiku-4-5-20251001'
    })
    mockedHybridSearch.mockResolvedValue([])

    await retrieveContext(
      { prompt: 'configure aws s3 bucket policy', cwd: PROJECT_ROOT, transcriptPath: '/tmp/fake-transcript.jsonl' },
      DEFAULT_CONFIG,
      { projectRoot: PROJECT_ROOT, settingsOverride: { enableHaikuRetrieval: true } }
    )

    const keywordCalls = mockedHybridSearch.mock.calls.filter(([params]) => params.vectorWeight === 0)
    expect(keywordCalls).toHaveLength(1)
    const keywordQueries = keywordCalls[0][0].keywordQueries
    expect(keywordQueries).toContain('aws')
    expect(keywordQueries).toContain('s3')
  })
})
