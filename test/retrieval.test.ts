import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type HybridSearchResult, type InjectionSessionRecord, type MemoryRecord, type NearMissRecord, type RetrievalSettings } from '../src/lib/types.js'
import { expandViaRelations, retrieveContext } from '../src/lib/retrieval.js'
import { createMockCommandRecord } from './helpers.js'
import { loadSettings } from '../src/lib/settings.js'
import { closeLanceDB, fetchRecordsByIds, hybridSearch, initLanceDB } from '../src/lib/lancedb.js'
import { embed } from '../src/lib/embed.js'
import { generateRetrievalQueryPlan } from '../src/lib/retrieval-query-generator.js'
import { recordTokenUsageEventsAsync } from '../src/lib/token-usage-events.js'
import { withTimeout } from '../src/lib/shared.js'
import {
  appendRecentlyInjectedIds,
  loadSessionTracking,
  updateSessionPromptStateIfVersion,
  updateSessionRetrievalState
} from '../src/lib/session-tracking.js'

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
    fetchRecordsByIds: vi.fn(),
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

vi.mock('../src/lib/session-tracking.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/session-tracking.js')>('../src/lib/session-tracking.js')
  return {
    ...actual,
    loadSessionTracking: vi.fn(),
    updateSessionPromptStateIfVersion: vi.fn(),
    updateSessionRetrievalState: vi.fn()
  }
})

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
  minExpandedScore: 0.45,
  minSemanticOnlyScore: 0.65,
  maxRecords: 5,
  maxTokens: 2000,
  mmrLambda: 0.7,
  usageRatioWeight: 0.2,
  keywordBonus: 0.08,
  projectMatchBonus: 0.05,
  enableTopicSuppression: true,
  topicChangeThreshold: 0.3,
  recentlyInjectedWindow: 20,
  suppressionMode: 'soft',
  suppressionPenalty: 0.5,
  enableHaikuRetrieval: false,
  haikuExpansionCount: 3,
  enableRelationExpansion: true,
  maxRelationHops: 1,
  maxRelationExpansions: 5,
  relationHopDecay: 0.6,
  maxRelationsPerRecord: 50,
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
const mockedFetchRecordsByIds = vi.mocked(fetchRecordsByIds)
const mockedEmbed = vi.mocked(embed)
const mockedGenerateRetrievalQueryPlan = vi.mocked(generateRetrievalQueryPlan)
const mockedRecordTokenUsageEventsAsync = vi.mocked(recordTokenUsageEventsAsync)
const mockedInitLanceDB = vi.mocked(initLanceDB)
const mockedCloseLanceDB = vi.mocked(closeLanceDB)
const mockedWithTimeout = vi.mocked(withTimeout)
const mockedLoadSessionTracking = vi.mocked(loadSessionTracking)
const mockedUpdateSessionPromptStateIfVersion = vi.mocked(updateSessionPromptStateIfVersion)
const mockedUpdateSessionRetrievalState = vi.mocked(updateSessionRetrievalState)

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

const makeRelation = (targetId: string, weight: number = 1, kind: 'relates_to' | 'supersedes' = 'relates_to') => ({
  targetId,
  kind,
  weight,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastReinforcedAt: '2026-01-01T00:00:00.000Z',
  reinforcementCount: 1
})

const makeSession = (overrides: Partial<InjectionSessionRecord> = {}): InjectionSessionRecord => ({
  sessionId: 'session-1',
  createdAt: Date.now(),
  lastActivity: Date.now(),
  memories: [],
  recentlyInjectedIds: [],
  previousPromptEmbedding: null,
  retrievalStateVersion: 0,
  ...overrides
})

beforeEach(async () => {
  vi.clearAllMocks()
  const actualShared = await vi.importActual<typeof import('../src/lib/shared.js')>('../src/lib/shared.js')
  mockedLoadSettings.mockReturnValue(makeSettings())
  mockedEmbed.mockResolvedValue([0.95, 0.05])
  mockedGenerateRetrievalQueryPlan.mockResolvedValue(null)
  mockedHybridSearch.mockResolvedValue([])
  mockedFetchRecordsByIds.mockResolvedValue([])
  mockedInitLanceDB.mockResolvedValue(undefined)
  mockedCloseLanceDB.mockResolvedValue(undefined)
  mockedWithTimeout.mockImplementation(actualShared.withTimeout)
  mockedLoadSessionTracking.mockReturnValue(null)
  mockedUpdateSessionPromptStateIfVersion.mockReturnValue(makeSession({ retrievalStateVersion: 1 }))
  mockedUpdateSessionRetrievalState.mockReturnValue(null)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Relation expansion', () => {
  it('adds related records with hop decay scoring and via metadata', async () => {
    const parent = makeResult('parent', [1, 0], 0.8, 0.7)
    parent.record.relations = [makeRelation('child', 0.5)]
    const child = createMockCommandRecord({
      id: 'child',
      command: 'child-command',
      embedding: [0, 1]
    })
    mockedFetchRecordsByIds.mockResolvedValue([child])

    const results = await expandViaRelations([parent], DEFAULT_CONFIG, makeSettings({
      maxRelationHops: 1,
      maxRelationExpansions: 5,
      relationHopDecay: 0.6
    }))

    expect(results.map(result => result.record.id)).toEqual(['parent', 'child'])
    expect(results[1].score).toBeCloseTo(0.8 * 0.5 * 0.6)
    expect(results[1].via).toEqual({ parentId: 'parent', kind: 'relates_to', hop: 1 })
    expect(mockedFetchRecordsByIds).toHaveBeenCalledWith(['child'], DEFAULT_CONFIG, { includeEmbeddings: true })
  })

  it('honors max expansion caps', async () => {
    const parent = makeResult('parent', [1, 0], 1.0, 0.8)
    parent.record.relations = [
      makeRelation('best', 0.9),
      makeRelation('second', 0.8)
    ]
    mockedFetchRecordsByIds.mockResolvedValue([
      createMockCommandRecord({ id: 'best', command: 'best', embedding: [0.9, 0.1] }),
      createMockCommandRecord({ id: 'second', command: 'second', embedding: [0.8, 0.2] })
    ])

    const results = await expandViaRelations([parent], DEFAULT_CONFIG, makeSettings({
      maxRelationHops: 1,
      maxRelationExpansions: 1,
      relationHopDecay: 0.6
    }))

    expect(results.map(result => result.record.id)).toEqual(['parent', 'best'])
  })

  it('honors max hop caps', async () => {
    const parent = makeResult('parent', [1, 0], 1.0, 0.8)
    parent.record.relations = [makeRelation('child', 1)]
    const child = createMockCommandRecord({
      id: 'child',
      command: 'child-command',
      embedding: [0.8, 0.2],
      relations: [makeRelation('grandchild', 1)]
    })
    const grandchild = createMockCommandRecord({
      id: 'grandchild',
      command: 'grandchild-command',
      embedding: [0.7, 0.3]
    })
    const recordsById: Record<string, MemoryRecord> = { child, grandchild }
    mockedFetchRecordsByIds.mockImplementation(async ids =>
      ids.map(id => recordsById[id]).filter((record): record is MemoryRecord => Boolean(record))
    )

    const oneHop = await expandViaRelations([parent], DEFAULT_CONFIG, makeSettings({
      maxRelationHops: 1,
      maxRelationExpansions: 5,
      relationHopDecay: 0.6
    }))
    expect(oneHop.map(result => result.record.id)).toEqual(['parent', 'child'])

    mockedFetchRecordsByIds.mockClear()
    const twoHops = await expandViaRelations([parent], DEFAULT_CONFIG, makeSettings({
      maxRelationHops: 2,
      maxRelationExpansions: 5,
      relationHopDecay: 0.6
    }))
    expect(twoHops.map(result => result.record.id)).toEqual(['parent', 'child', 'grandchild'])
    expect(twoHops[2].score).toBeCloseTo(1.0 * Math.pow(0.6, 2))
    expect(twoHops[2].via).toEqual({ parentId: 'child', kind: 'relates_to', hop: 2 })
  })

  it('terminates on relation cycles and returns each record at most once', async () => {
    const parent = makeResult('parent', [1, 0], 1.0, 0.8)
    parent.record.relations = [makeRelation('child', 1)]
    const child = createMockCommandRecord({
      id: 'child',
      command: 'child-command',
      embedding: [0.8, 0.2],
      relations: [makeRelation('parent', 1)]
    })
    mockedFetchRecordsByIds.mockResolvedValue([child])

    const results = await expandViaRelations([parent], DEFAULT_CONFIG, makeSettings({
      maxRelationHops: 2,
      maxRelationExpansions: 5,
      relationHopDecay: 0.6
    }))

    expect(results.map(result => result.record.id)).toEqual(['parent', 'child'])
    expect(new Set(results.map(result => result.record.id)).size).toBe(results.length)
    expect(mockedFetchRecordsByIds).toHaveBeenCalledTimes(1)
  })

  it('skips deprecated related records during expansion', async () => {
    const parent = makeResult('parent', [1, 0], 1.0, 0.8)
    parent.record.relations = [makeRelation('deprecated-child', 1)]
    const deprecatedChild = createMockCommandRecord({
      id: 'deprecated-child',
      command: 'deprecated-child-command',
      deprecated: true,
      embedding: [0.8, 0.2]
    })
    mockedFetchRecordsByIds.mockResolvedValue([deprecatedChild])

    const results = await expandViaRelations([parent], DEFAULT_CONFIG, makeSettings({
      maxRelationHops: 1,
      maxRelationExpansions: 5,
      relationHopDecay: 0.6
    }))

    expect(results.map(result => result.record.id)).toEqual(['parent'])
  })

  it('does not duplicate records already present in the initial hits', async () => {
    const parent = makeResult('parent', [1, 0], 1.0, 0.8)
    const child = makeResult('child', [0, 1], 0.9, 0.7)
    parent.record.relations = [makeRelation('child', 1)]

    const results = await expandViaRelations([parent, child], DEFAULT_CONFIG, makeSettings({
      maxRelationHops: 1,
      maxRelationExpansions: 5,
      relationHopDecay: 0.6
    }))

    expect(results.map(result => result.record.id)).toEqual(['parent', 'child'])
    expect(mockedFetchRecordsByIds).not.toHaveBeenCalled()
  })
})

describe('Topic suppression', () => {
  it('filters suppressed IDs in hard mode and reports diagnostics', async () => {
    mockedLoadSessionTracking.mockReturnValue(makeSession({
      sessionId: 'session-hard',
      recentlyInjectedIds: ['suppressed'],
      previousPromptEmbedding: [0.95, 0.05]
    }))
    const suppressed = makeResult('suppressed', [0.95, 0.05], 0.9, 0.9, false)
    const fresh = makeResult('fresh', [0.9, 0.1], 0.8, 0.8, false)
    mockedHybridSearch.mockImplementation(async params => {
      const qualified = params.vectorWeight === 1 ? [suppressed, fresh] : []
      return params.diagnostic ? { qualified, nearMisses: [] } : qualified
    })

    const result = await retrieveContext(
      { prompt: 'same topic', cwd: PROJECT_ROOT, sessionId: 'session-hard' },
      DEFAULT_CONFIG,
      {
        projectRoot: PROJECT_ROOT,
        diagnostic: true,
        settingsOverride: { suppressionMode: 'hard', minScore: 0.05 }
      }
    )

    expect(result.results.map(item => item.record.id)).toEqual(['fresh'])
    const suppressedNearMiss = result.diagnostics?.search.nearMisses.find(entry => entry.record.record.id === 'suppressed')
    expect(suppressedNearMiss?.record.suppression).toEqual({
      suppressed: true,
      mode: 'hard',
      originalScore: expect.any(Number)
    })
    expect(suppressedNearMiss?.exclusionReasons[0].reason).toBe('recently_injected_suppression')
    expect(mockedUpdateSessionPromptStateIfVersion.mock.calls.at(-1)?.[1]).toMatchObject({
      previousPromptEmbedding: [0.95, 0.05]
    })
    expect(mockedUpdateSessionRetrievalState).not.toHaveBeenCalled()
  })

  it('downweights suppressed IDs in soft mode', async () => {
    mockedLoadSessionTracking.mockReturnValue(makeSession({
      sessionId: 'session-soft',
      recentlyInjectedIds: ['suppressed'],
      previousPromptEmbedding: [0.95, 0.05]
    }))
    const suppressed = makeResult('suppressed', [0.95, 0.05], 0.9, 0.9, false)
    const fresh = makeResult('fresh', [0.9, 0.1], 0.8, 0.8, false)
    mockedHybridSearch.mockImplementation(async params => params.vectorWeight === 1 ? [suppressed, fresh] : [])

    const result = await retrieveContext(
      { prompt: 'same topic', cwd: PROJECT_ROOT, sessionId: 'session-soft' },
      DEFAULT_CONFIG,
      {
        projectRoot: PROJECT_ROOT,
        settingsOverride: { suppressionMode: 'soft', suppressionPenalty: 0.5, minScore: 0.05 }
      }
    )

    const suppressedResult = result.results.find(item => item.record.id === 'suppressed')
    expect(suppressedResult?.suppression).toEqual({
      suppressed: true,
      mode: 'soft',
      originalScore: expect.any(Number)
    })
    expect(suppressedResult?.score).toBeCloseTo(suppressedResult!.suppression!.originalScore * 0.5)
  })

  it('clears suppression on topic shift and lets suppressed IDs through', async () => {
    mockedEmbed.mockResolvedValue([1, 0])
    mockedUpdateSessionRetrievalState.mockReturnValueOnce(makeSession({ retrievalStateVersion: 1 }))
    mockedLoadSessionTracking.mockReturnValue(makeSession({
      sessionId: 'session-shift',
      recentlyInjectedIds: ['suppressed'],
      previousPromptEmbedding: [0, 1]
    }))
    const suppressed = makeResult('suppressed', [1, 0], 0.9, 0.9, false)
    mockedHybridSearch.mockImplementation(async params => params.vectorWeight === 1 ? [suppressed] : [])

    const result = await retrieveContext(
      { prompt: 'new topic', cwd: PROJECT_ROOT, sessionId: 'session-shift' },
      DEFAULT_CONFIG,
      {
        projectRoot: PROJECT_ROOT,
        settingsOverride: { suppressionMode: 'hard', topicChangeThreshold: 0.3, minScore: 0.05 }
      }
    )

    expect(result.results.map(item => item.record.id)).toEqual(['suppressed'])
    expect(mockedUpdateSessionRetrievalState.mock.calls[0][1]).toMatchObject({
      recentlyInjectedIds: []
    })
    expect(mockedUpdateSessionPromptStateIfVersion.mock.calls[0][1].expectedRetrievalStateVersion).toBe(1)
  })

  it('does not suppress on first prompt without a previous embedding', async () => {
    mockedLoadSessionTracking.mockReturnValue(makeSession({
      sessionId: 'session-first',
      recentlyInjectedIds: ['suppressed'],
      previousPromptEmbedding: null
    }))
    const suppressed = makeResult('suppressed', [0.95, 0.05], 0.9, 0.9, false)
    mockedHybridSearch.mockImplementation(async params => params.vectorWeight === 1 ? [suppressed] : [])

    const result = await retrieveContext(
      { prompt: 'first prompt', cwd: PROJECT_ROOT, sessionId: 'session-first' },
      DEFAULT_CONFIG,
      {
        projectRoot: PROJECT_ROOT,
        settingsOverride: { suppressionMode: 'hard', minScore: 0.05 }
      }
    )

    expect(result.results.map(item => item.record.id)).toEqual(['suppressed'])
    expect(mockedUpdateSessionPromptStateIfVersion).toHaveBeenCalledTimes(1)
    expect(mockedUpdateSessionPromptStateIfVersion.mock.calls[0][1]).toMatchObject({
      previousPromptEmbedding: [0.95, 0.05]
    })
    expect(mockedUpdateSessionRetrievalState).not.toHaveBeenCalled()
  })

  it('slides the recently injected ID window', () => {
    const existing = Array.from({ length: 20 }, (_, index) => `id-${index + 1}`)

    const next = appendRecentlyInjectedIds(existing, ['id-21'], 20)

    expect(next).toHaveLength(20)
    expect(next[0]).toBe('id-2')
    expect(next.at(-1)).toBe('id-21')
  })

  it('skips suppression writeback when requested by diagnostic callers', async () => {
    mockedEmbed.mockResolvedValue([1, 0])
    mockedLoadSessionTracking.mockReturnValue(makeSession({
      sessionId: 'session-preview',
      recentlyInjectedIds: ['suppressed'],
      previousPromptEmbedding: [0, 1]
    }))
    const fresh = makeResult('fresh', [0.95, 0.05], 0.9, 0.9, false)
    mockedHybridSearch.mockImplementation(async params => {
      const qualified = params.vectorWeight === 1 ? [fresh] : []
      return params.diagnostic ? { qualified, nearMisses: [] } : qualified
    })

    await retrieveContext(
      { prompt: 'dashboard preview', cwd: PROJECT_ROOT, sessionId: 'session-preview', skipSuppressionWriteback: true },
      DEFAULT_CONFIG,
      {
        projectRoot: PROJECT_ROOT,
        diagnostic: true,
        settingsOverride: { minScore: 0.05 }
      }
    )

    expect(mockedUpdateSessionRetrievalState).not.toHaveBeenCalled()
    expect(mockedUpdateSessionPromptStateIfVersion).not.toHaveBeenCalled()
  })

  it('suppresses relation-expanded records after expansion', async () => {
    mockedLoadSessionTracking.mockReturnValue(makeSession({
      sessionId: 'session-relation',
      recentlyInjectedIds: ['child'],
      previousPromptEmbedding: [0.95, 0.05]
    }))
    const parent = makeResult('parent', [0.95, 0.05], 0.9, 0.9, false)
    parent.record.relations = [makeRelation('child', 1)]
    const child = createMockCommandRecord({ id: 'child', command: 'child-command', embedding: [0.8, 0.2] })
    mockedHybridSearch.mockImplementation(async params => params.vectorWeight === 1 ? [parent] : [])
    mockedFetchRecordsByIds.mockResolvedValue([child])

    const result = await retrieveContext(
      { prompt: 'same topic with relation', cwd: PROJECT_ROOT, sessionId: 'session-relation' },
      DEFAULT_CONFIG,
      {
        projectRoot: PROJECT_ROOT,
        settingsOverride: { suppressionMode: 'hard', minScore: 0.05 }
      }
    )

    expect(result.results.map(item => item.record.id)).toEqual(['parent'])
    expect(mockedFetchRecordsByIds).toHaveBeenCalledWith(['child'], DEFAULT_CONFIG, { includeEmbeddings: true })
  })

  it('drops relation-expanded records below minExpandedScore', async () => {
    const parent = makeResult('parent', [0.95, 0.05], 0.9, 0.9, false)
    parent.record.relations = [makeRelation('weak-child', 0.1)]
    const child = createMockCommandRecord({ id: 'weak-child', command: 'weak-child-command', embedding: [0.8, 0.2] })
    mockedHybridSearch.mockImplementation(async params => {
      const qualified = params.vectorWeight === 1 ? [parent] : []
      return params.diagnostic ? { qualified, nearMisses: [] } : qualified
    })
    mockedFetchRecordsByIds.mockResolvedValue([child])

    const result = await retrieveContext(
      { prompt: 'relation floor', cwd: PROJECT_ROOT },
      DEFAULT_CONFIG,
      {
        projectRoot: PROJECT_ROOT,
        diagnostic: true,
        settingsOverride: { minScore: 0.05, minExpandedScore: 0.45 }
      }
    )

    expect(result.results.map(item => item.record.id)).toEqual(['parent'])
    const nearMiss = result.diagnostics?.search.nearMisses.find(entry => entry.record.record.id === 'weak-child')
    expect(nearMiss?.exclusionReasons[0]).toMatchObject({
      reason: 'score_below_threshold',
      threshold: 0.45
    })
  })
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
        semanticQueries: ['Build a Docker image for this project.']
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
      { projectRoot: PROJECT_ROOT, settingsOverride: { enableHaikuRetrieval: true, haikuExpansionCount: 1 } }
    )

    expect(mockedGenerateRetrievalQueryPlan).toHaveBeenCalledWith(
      'How do I build it?',
      '/tmp/fake-transcript.jsonl',
      expect.objectContaining({ expansionCount: 1 })
    )
    expect(mockedEmbed.mock.calls.map(([query]) => query)).toEqual(['Build a Docker image for this project.'])
    const semanticCalls = mockedHybridSearch.mock.calls.filter(([params]) => params.vectorWeight === 1)
    expect(semanticCalls).toHaveLength(1)
    const keywordCall = mockedHybridSearch.mock.calls.find(([params]) => params.vectorWeight === 0)
    expect(keywordCall?.[0].query).toBe('docker build')
  })

  it('embeds all Haiku semantic variants when expansion count is 3', async () => {
    const semanticQueries = [
      'ubiquiti gateway docker setup',
      'UniFi gateway controller container configuration',
      'docker exec MongoDB queries for UniFi gateway setup'
    ]
    mockedGenerateRetrievalQueryPlan.mockResolvedValue({
      plan: {
        resolvedQuery: 'Do you remember our ubiquiti gateway docker setup?',
        keywordQueries: ['ubiquiti', 'UniFi', 'docker', 'docker exec'],
        semanticQueries
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
      { prompt: 'Do you remember our ubiquiti gateway docker setup?', cwd: PROJECT_ROOT },
      DEFAULT_CONFIG,
      { projectRoot: PROJECT_ROOT, settingsOverride: { enableHaikuRetrieval: true, haikuExpansionCount: 3 } }
    )

    expect(mockedGenerateRetrievalQueryPlan).toHaveBeenCalledWith(
      'Do you remember our ubiquiti gateway docker setup?',
      undefined,
      expect.objectContaining({ expansionCount: 3 })
    )
    expect(mockedEmbed.mock.calls.map(([query]) => query)).toEqual(semanticQueries)
    expect(new Set(mockedEmbed.mock.calls.map(([query]) => query)).size).toBe(3)
    const semanticCalls = mockedHybridSearch.mock.calls.filter(([params]) => params.vectorWeight === 1)
    expect(semanticCalls).toHaveLength(3)
  })

  it('dedupes semantic expansion candidates by id and keeps max similarity', async () => {
    mockedGenerateRetrievalQueryPlan.mockResolvedValue({
      plan: {
        resolvedQuery: 'Do you remember our ubiquiti gateway docker setup?',
        keywordQueries: ['ubiquiti', 'docker'],
        semanticQueries: [
          'ubiquiti gateway docker setup',
          'UniFi gateway controller container setup',
          'docker exec MongoDB query for UniFi controller'
        ]
      },
      tokenUsage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0
      },
      model: 'claude-haiku-4-5-20251001'
    })
    mockedEmbed.mockImplementation(async query => {
      if (query === 'ubiquiti gateway docker setup') return [1, 0]
      if (query === 'UniFi gateway controller container setup') return [2, 0]
      return [3, 0]
    })

    const sharedLow = makeResult('shared', [1, 0], 0.62, 0.62, false)
    const sharedHigh = makeResult('shared', [1, 0], 0.82, 0.82, false)
    const onlyThird = makeResult('only-third', [1, 0], 0.76, 0.76, false)

    mockedHybridSearch.mockImplementation(async params => {
      if (params.vectorWeight === 0) return []
      if (params.embedding?.[0] === 1) return [sharedLow]
      if (params.embedding?.[0] === 2) return [sharedHigh]
      if (params.embedding?.[0] === 3) return [onlyThird]
      return []
    })

    const result = await retrieveContext(
      { prompt: 'Do you remember our ubiquiti gateway docker setup?', cwd: PROJECT_ROOT },
      DEFAULT_CONFIG,
      {
        projectRoot: PROJECT_ROOT,
        settingsOverride: {
          enableHaikuRetrieval: true,
          haikuExpansionCount: 3,
          minScore: 0.05,
          semanticAnchorThreshold: 0
        }
      }
    )

    const sharedResults = result.results.filter(item => item.record.id === 'shared')
    expect(sharedResults).toHaveLength(1)
    expect(sharedResults[0].similarity).toBe(0.82)
    expect(result.results.map(item => item.record.id)).toContain('only-third')
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
        semanticQueries: ['Deployment workflow']
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
        semanticQueries: ['p4 brain configuration']
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
        semanticQueries: ['Find a Jira issue about Grafana statistics']
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
        semanticQueries: ['Configure Redis cluster settings']
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
        semanticQueries: ['Configure AWS S3 bucket policy']
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
