import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type MemoryRecord, type RetrievalSettings } from '../src/lib/types.js'
import { DEFAULT_SETTINGS } from '../src/lib/settings-schema.js'

vi.mock('../src/lib/lancedb.js', () => ({
  initLanceDB: vi.fn(),
  closeLanceDB: vi.fn(),
  hybridSearch: vi.fn(),
  fetchRecordsByIds: vi.fn(),
  iterateRecords: vi.fn()
}))

vi.mock('../src/lib/embed.js', () => ({
  embed: vi.fn()
}))

vi.mock('../src/lib/retrieval-query-generator.js', () => ({
  generateRetrievalQueryPlan: vi.fn()
}))

vi.mock('../src/lib/retrieval-reranker.js', () => ({
  rerankRetrievedCandidates: vi.fn()
}))

vi.mock('../src/lib/token-usage-events.js', () => ({
  recordTokenUsageEventsAsync: vi.fn()
}))

vi.mock('../src/lib/session-tracking.js', () => ({
  loadSessionTracking: vi.fn(),
  updateSessionPromptStateIfVersion: vi.fn(),
  updateSessionRetrievalState: vi.fn()
}))

import { retrieveContext } from '../src/lib/retrieval.js'
import { hybridSearch } from '../src/lib/lancedb.js'
import { embed } from '../src/lib/embed.js'
import { generateRetrievalQueryPlan } from '../src/lib/retrieval-query-generator.js'
import { rerankRetrievedCandidates } from '../src/lib/retrieval-reranker.js'
import { recordTokenUsageEventsAsync } from '../src/lib/token-usage-events.js'
import { loadSessionTracking } from '../src/lib/session-tracking.js'

const mockedHybridSearch = vi.mocked(hybridSearch)
const mockedEmbed = vi.mocked(embed)
const mockedGenerateQueryPlan = vi.mocked(generateRetrievalQueryPlan)
const mockedRerank = vi.mocked(rerankRetrievedCandidates)
const mockedRecordTokens = vi.mocked(recordTokenUsageEventsAsync)
const mockedLoadSession = vi.mocked(loadSessionTracking)

function makeRec(id: string, what: string, vecVal: number): MemoryRecord {
  return {
    id,
    type: 'discovery',
    what,
    where: 'src/app.ts',
    evidence: 'verified',
    confidence: 'verified',
    project: '/repo/demo',
    scope: 'project',
    timestamp: 1000,
    lastUsed: 1000,
    deprecated: false,
    embedding: [vecVal, 1 - vecVal]
  }
}

const STAGE2_SETTINGS: RetrievalSettings = {
  ...DEFAULT_SETTINGS,
  enablePostRetrievalRerank: true,
  enableHaikuRetrieval: true, // must be skipped when enablePostRetrievalRerank is true
  stage1MinSimilarity: 0.45,
  rerankCandidateLimit: 18,
  rerankMaxRecords: 3,
  enableTopicSuppression: true,
  suppressionMode: 'hard',
  topicChangeThreshold: 0,
  recentlyInjectedWindow: 200
}

describe('Phase 2: Flipped Stage-1 -> Stage-2 reranker & abstention gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedEmbed.mockResolvedValue([1, 0])
    mockedLoadSession.mockReturnValue(null)
  })

  it('skips pre-retrieval Haiku, runs Stage-1 BM25 + single vector, and injects Stage-2 selected records', async () => {
    const recA = makeRec('aaaa1111-1111-4111-8111-111111111111', 'Caddy requires explicit tls internal on localhost', 0.9)
    const recB = makeRec('bbbb2222-2222-4222-8222-222222222222', 'Unrelated notes about font rendering', 0.52)

    mockedHybridSearch.mockImplementation(async (params: any) => {
      if (params.vectorWeight === 0) {
        return [{ record: recA, score: 5.2, bm25Score: 5.2, similarity: 0, keywordMatch: true }]
      }
      return [
        { record: recA, score: 0.85, similarity: 0.85, keywordMatch: false },
        { record: recB, score: 0.52, similarity: 0.52, keywordMatch: false }
      ]
    })

    mockedRerank.mockImplementation(async (req) => ({
      selected: [req.candidates[0]],
      selectedIndices: [0],
      abstained: false,
      model: 'claude-haiku-5-5',
      durationMs: 320,
      tokenUsage: { inputTokens: 450, outputTokens: 20, cacheReadInputTokens: 300 }
    }))

    const res = await retrieveContext(
      { prompt: 'Why is caddy localhost TLS failing?', cwd: '/repo/demo', sessionId: 's1' },
      DEFAULT_CONFIG,
      { projectRoot: '/repo/demo', settingsOverride: STAGE2_SETTINGS, diagnostic: true }
    )

    expect(mockedGenerateQueryPlan).not.toHaveBeenCalled()
    expect(mockedEmbed).toHaveBeenCalledTimes(1)
    expect(mockedRerank).toHaveBeenCalledTimes(1)
    expect(res.injectedRecords.map(r => r.id)).toEqual([recA.id])
    expect(res.telemetry?.pipeline).toBe('stage2-rerank')
    expect(res.telemetry?.rerankerCalled).toBe(true)
    expect(res.telemetry?.rerankerAbstained).toBe(false)
    expect(res.diagnostics?.search.nearMisses.some(nm =>
      nm.record.record.id === recB.id && nm.exclusionReasons.some(e => e.reason === 'rerank_abstained')
    )).toBe(true)
    expect(mockedRecordTokens).toHaveBeenCalledWith(
      [expect.objectContaining({ source: 'rerank', model: 'claude-haiku-5-5' })],
      expect.any(Object)
    )
  })

  it('abstains cleanly with 0 injected records when Stage-2 reranker returns empty selection', async () => {
    const rec = makeRec('cccc3333-3333-4333-8333-333333333333', 'Tangential note', 0.55)
    mockedHybridSearch.mockImplementation(async (params: any) =>
      params.vectorWeight === 0 ? [] : [{ record: rec, score: 0.55, similarity: 0.55, keywordMatch: false }]
    )
    mockedRerank.mockResolvedValue({
      selected: [],
      selectedIndices: [],
      abstained: true,
      abstainReason: 'No materially helpful candidate',
      model: 'claude-haiku-5-5',
      durationMs: 250,
      tokenUsage: { inputTokens: 300, outputTokens: 15 }
    })

    const res = await retrieveContext(
      { prompt: 'Rename helper variable in utils.ts', cwd: '/repo/demo' },
      DEFAULT_CONFIG,
      { projectRoot: '/repo/demo', settingsOverride: STAGE2_SETTINGS }
    )

    expect(res.context).toBeNull()
    expect(res.injectedRecords).toEqual([])
    expect(res.telemetry?.rerankerAbstained).toBe(true)
    expect(res.telemetry?.abstainReason).toBe('No materially helpful candidate')
  })

  it('skips Stage-2 LLM call completely when hard session ledger already suppressed all Stage-1 candidates', async () => {
    const rec = makeRec('dddd4444-4444-4444-8444-444444444444', 'Already injected memory', 0.92)
    mockedLoadSession.mockReturnValue({
      sessionId: 's-repeat',
      cwd: '/repo/demo',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      memories: [],
      prompts: [],
      recentlyInjectedIds: [rec.id],
      retrievalStateVersion: 2
    })
    mockedHybridSearch.mockImplementation(async (params: any) =>
      params.vectorWeight === 0 ? [] : [{ record: rec, score: 0.92, similarity: 0.92, keywordMatch: false }]
    )

    const res = await retrieveContext(
      { prompt: 'Follow up on the same caddy config', cwd: '/repo/demo', sessionId: 's-repeat' },
      DEFAULT_CONFIG,
      { projectRoot: '/repo/demo', settingsOverride: STAGE2_SETTINGS }
    )

    expect(mockedRerank).not.toHaveBeenCalled()
    expect(res.injectedRecords).toEqual([])
    expect(res.telemetry?.suppressedCount).toBe(1)
    expect(res.telemetry?.abstainReason).toBe('all_candidates_suppressed')
  })

  it('falls back safely to strict local thresholds when Stage-2 reranker times out or returns null', async () => {
    const strongRec = makeRec('eeee5555-5555-4555-8555-555555555555', 'High confidence memory', 0.95)
    const weakRec = makeRec('ffff6666-6666-4666-8666-666666666666', 'Low similarity memory', 0.48)

    mockedHybridSearch.mockImplementation(async (params: any) =>
      params.vectorWeight === 0
        ? []
        : [
            { record: strongRec, score: 0.9, similarity: 0.9, keywordMatch: false },
            { record: weakRec, score: 0.48, similarity: 0.48, keywordMatch: false }
          ]
    )
    mockedRerank.mockResolvedValue(null)

    const res = await retrieveContext(
      { prompt: 'Check the TLS setup', cwd: '/repo/demo' },
      DEFAULT_CONFIG,
      { projectRoot: '/repo/demo', settingsOverride: STAGE2_SETTINGS }
    )

    expect(res.telemetry?.rerankerFallback).toBe(true)
    expect(res.injectedRecords.map(r => r.id)).toEqual([strongRec.id])
  })

  it('skips doomed Stage-2 network call and returns fast local fallback when remaining prePromptTimeoutMs budget is exhausted', async () => {
    const strongRec = makeRec('1111aaaa-5555-4555-8555-555555555555', 'Strong local match', 0.96)
    mockedEmbed.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 60))
      return [1, 0]
    })
    mockedHybridSearch.mockImplementation(async (params: any) =>
      params.vectorWeight === 0
        ? []
        : [{ record: strongRec, score: 0.92, similarity: 0.92, keywordMatch: false }]
    )
    mockedRerank.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 500))
      return null
    })

    const tightSettings: RetrievalSettings = {
      ...STAGE2_SETTINGS,
      prePromptTimeoutMs: 400
    }

    const res = await retrieveContext(
      { prompt: 'Check the TLS setup', cwd: '/repo/demo' },
      DEFAULT_CONFIG,
      { projectRoot: '/repo/demo', settingsOverride: tightSettings }
    )

    expect(res.timedOut).toBe(false)
    expect(mockedRerank).not.toHaveBeenCalled()
    expect(res.telemetry?.rerankerFallback).toBe(true)
    expect(res.injectedRecords.map(r => r.id)).toEqual([strongRec.id])
  })

  it('keeps 4500ms embedding cap at default 10s hook budget and scales up to 15s when prePromptTimeoutMs is raised', async () => {
    mockedHybridSearch.mockResolvedValue([])

    await retrieveContext(
      { prompt: 'Default hook timeout check', cwd: '/repo/demo' },
      DEFAULT_CONFIG,
      { projectRoot: '/repo/demo', settingsOverride: { ...STAGE2_SETTINGS, prePromptTimeoutMs: 10_000 } }
    )
    expect(mockedEmbed).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({ timeoutMs: 4500 })
    )

    await retrieveContext(
      { prompt: 'Long replay timeout check', cwd: '/repo/demo' },
      DEFAULT_CONFIG,
      { projectRoot: '/repo/demo', settingsOverride: { ...STAGE2_SETTINGS, prePromptTimeoutMs: 30_000 } }
    )
    expect(mockedEmbed).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({ timeoutMs: 15_000 })
    )
  })
})
