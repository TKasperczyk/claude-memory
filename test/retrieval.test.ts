import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type HybridSearchResult, type NearMissRecord, type RetrievalSettings } from '../src/lib/types.js'
import { retrieveContext } from '../src/lib/retrieval.js'
import { createMockCommandRecord } from './helpers.js'
import { loadSettings } from '../src/lib/settings.js'
import { closeMilvus, hybridSearch, initMilvus } from '../src/lib/milvus.js'
import { embed } from '../src/lib/embed.js'
import { generateRetrievalQueryPlan } from '../src/lib/retrieval-query-generator.js'
import { buildContext } from '../src/lib/context.js'
import { withTimeout } from '../src/lib/shared.js'

vi.mock('../src/lib/shared.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/shared.js')>('../src/lib/shared.js')
  return {
    ...actual,
    withTimeout: vi.fn(actual.withTimeout)
  }
})

vi.mock('../src/lib/milvus.js', () => ({
  initMilvus: vi.fn(),
  closeMilvus: vi.fn(),
  hybridSearch: vi.fn()
}))

vi.mock('../src/lib/embed.js', () => ({
  embed: vi.fn()
}))

vi.mock('../src/lib/retrieval-query-generator.js', () => ({
  generateRetrievalQueryPlan: vi.fn()
}))

vi.mock('../src/lib/settings.js', () => ({
  loadSettings: vi.fn()
}))

vi.mock('../src/lib/context.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/context.js')>('../src/lib/context.js')
  return {
    ...actual,
    buildContext: vi.fn((records: unknown, _config: unknown, options?: { diagnostic?: boolean; mmrExclusions?: unknown[] }) => {
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
    })
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
const mockedInitMilvus = vi.mocked(initMilvus)
const mockedCloseMilvus = vi.mocked(closeMilvus)
const mockedBuildContext = vi.mocked(buildContext)
const mockedWithTimeout = vi.mocked(withTimeout)

const makeSettings = (overrides: Partial<RetrievalSettings> = {}): RetrievalSettings => ({
  ...BASE_SETTINGS,
  ...overrides
})

const makeResult = (
  id: string,
  embedding: number[],
  score: number,
  similarity: number = score
): HybridSearchResult => ({
  record: createMockCommandRecord({
    id,
    command: `command-${id}`,
    embedding
  }),
  score,
  similarity,
  keywordMatch: true
})

beforeEach(async () => {
  vi.clearAllMocks()
  const actualShared = await vi.importActual<typeof import('../src/lib/shared.js')>('../src/lib/shared.js')
  mockedLoadSettings.mockReturnValue(makeSettings())
  mockedEmbed.mockResolvedValue([0.1, 0.2])
  mockedGenerateRetrievalQueryPlan.mockResolvedValue(null)
  mockedHybridSearch.mockResolvedValue([])
  mockedInitMilvus.mockResolvedValue(undefined)
  mockedCloseMilvus.mockResolvedValue(undefined)
  mockedBuildContext.mockImplementation((records: unknown, _config: unknown, options?: { diagnostic?: boolean; mmrExclusions?: unknown[] }) => {
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
  })
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
      { projectRoot: PROJECT_ROOT, settingsOverride: { maxRecords: 2, mmrLambda: 0.2 } }
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
      { projectRoot: PROJECT_ROOT, settingsOverride: { maxRecords: 2, mmrLambda: 1 } }
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
  it('uses Haiku query plan to shape keyword search and domain', async () => {
    mockedGenerateRetrievalQueryPlan.mockResolvedValue({
      resolvedQuery: 'How do I build the Docker image?',
      keywordQueries: ['docker build'],
      semanticQuery: 'Build a Docker image for this project.',
      domain: 'docker'
    })

    mockedHybridSearch.mockResolvedValue([])

    await retrieveContext(
      { prompt: 'How do I build it?', cwd: PROJECT_ROOT, transcriptPath: '/tmp/fake-transcript.jsonl' },
      DEFAULT_CONFIG,
      { projectRoot: PROJECT_ROOT, settingsOverride: { enableHaikuRetrieval: true } }
    )

    const keywordCall = mockedHybridSearch.mock.calls.find(([params]) => params.vectorWeight === 0)
    expect(keywordCall?.[0].query).toBe('docker build')
    expect(keywordCall?.[0].domain).toBe('docker')
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
})

describe('Project to domain fallback', () => {
  it('detects domain from project root', async () => {
    mockedHybridSearch.mockResolvedValue([])

    const result = await retrieveContext(
      { prompt: 'check domain', cwd: PROJECT_ROOT },
      DEFAULT_CONFIG,
      { projectRoot: PROJECT_ROOT }
    )

    expect(result.signals.domain).toBe('node')
  })

  it('retries with domain-only scope when project match is empty', async () => {
    const fallbackResult = makeResult('fallback', [0, 1], 0.6)

    mockedHybridSearch.mockImplementation(async params => {
      if (params.project) {
        return []
      }
      if (params.vectorWeight === 0) {
        return [fallbackResult]
      }
      return []
    })

    const result = await retrieveContext(
      { prompt: 'look up memory', cwd: PROJECT_ROOT },
      DEFAULT_CONFIG,
      { projectRoot: PROJECT_ROOT }
    )

    expect(result.results).toHaveLength(1)
    expect(result.results[0].record.id).toBe('fallback')

    const fallbackCall = mockedHybridSearch.mock.calls.find(([params]) => !params.project)
    expect(fallbackCall?.[0].domain).toBe('node')
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
    mockedInitMilvus.mockImplementation(() => new Promise(() => {}))

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
