import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { DEFAULT_CONFIG } from '../src/lib/types.js'
import { createExtractionsRouter } from '../dashboard/server/routes/extractions.js'
import { createInstallationRouter } from '../dashboard/server/routes/installation.js'
import { createMaintenanceRouter } from '../dashboard/server/routes/maintenance.js'
import { createMemoryRouter } from '../dashboard/server/routes/memory.js'
import { createPreviewRouter } from '../dashboard/server/routes/preview.js'
import { createSessionsRouter } from '../dashboard/server/routes/sessions.js'
import { createSettingsRouter } from '../dashboard/server/routes/settings.js'
import {
  coerceRetrievalSettings,
  getDefaultMaintenanceSettings,
  getDefaultSettings,
  loadSettings,
  resetSettings,
  saveSettings,
  validateSettingValue
} from '../src/lib/settings.js'
import {
  ClaudeSettingsError,
  getHookStatus,
  getInstallationStatus,
  installAll,
  installHooks,
  uninstallAll,
  uninstallHooks
} from '../src/lib/installer.js'
import {
  buildKeywordFilter,
  countRecords,
  deleteRecord,
  escapeFilterValue,
  getRecord,
  getRecordStats,
  hybridSearch,
  iterateRecords,
  queryRecords,
  resetCollection
} from '../src/lib/milvus.js'
import { mergeNearMisses } from '../src/lib/diagnostics.js'
import { retrieveContext } from '../src/lib/retrieval.js'
import { reviewInjection, reviewInjectionStreaming } from '../src/lib/injection-review.js'
import { getExtractionRun, listExtractionRuns } from '../src/lib/extraction-log.js'
import { reviewExtraction, reviewExtractionStreaming } from '../src/lib/extraction-review.js'
import {
  getInjectionReview,
  getMaintenanceReview,
  getReview,
  saveMaintenanceReview,
  saveReview
} from '../src/lib/review-storage.js'
import { dedupeInjectedMemories, listAllSessions, loadSessionTracking } from '../src/lib/session-tracking.js'
import { reviewMaintenanceResult, reviewMaintenanceResultStreaming } from '../src/lib/maintenance-review.js'
import {
  runAllMaintenance,
  runMaintenanceOperation
} from '../src/lib/maintenance-api.js'

vi.mock('../src/lib/settings.js', () => ({
  getDefaultMaintenanceSettings: vi.fn(),
  getDefaultSettings: vi.fn(),
  loadSettings: vi.fn(),
  resetSettings: vi.fn(),
  saveSettings: vi.fn(),
  validateSettingValue: vi.fn(),
  coerceRetrievalSettings: vi.fn()
}))

vi.mock('../src/lib/installer.js', () => {
  class ClaudeSettingsError extends Error {
    constructor(message: string) {
      super(message)
      this.name = 'ClaudeSettingsError'
    }
  }

  return {
    ClaudeSettingsError,
    getHookStatus: vi.fn(),
    getInstallationStatus: vi.fn(),
    installAll: vi.fn(),
    installHooks: vi.fn(),
    uninstallAll: vi.fn(),
    uninstallHooks: vi.fn()
  }
})

vi.mock('../src/lib/milvus.js', () => ({
  countRecords: vi.fn(),
  deleteRecord: vi.fn(),
  escapeFilterValue: vi.fn(),
  getRecord: vi.fn(),
  getRecordStats: vi.fn(),
  hybridSearch: vi.fn(),
  iterateRecords: vi.fn(),
  queryRecords: vi.fn(),
  resetCollection: vi.fn(),
  buildKeywordFilter: vi.fn()
}))

vi.mock('../src/lib/diagnostics.js', () => ({
  mergeNearMisses: vi.fn()
}))

vi.mock('../src/lib/retrieval.js', () => ({
  retrieveContext: vi.fn()
}))

vi.mock('../src/lib/injection-review.js', () => ({
  reviewInjection: vi.fn(),
  reviewInjectionStreaming: vi.fn()
}))

vi.mock('../src/lib/extraction-log.js', () => ({
  getExtractionRun: vi.fn(),
  listExtractionRuns: vi.fn()
}))

vi.mock('../src/lib/extraction-review.js', () => ({
  reviewExtraction: vi.fn(),
  reviewExtractionStreaming: vi.fn()
}))

vi.mock('../src/lib/review-storage.js', () => ({
  getInjectionReview: vi.fn(),
  getReview: vi.fn(),
  getMaintenanceReview: vi.fn(),
  saveInjectionReview: vi.fn(),
  saveReview: vi.fn(),
  saveMaintenanceReview: vi.fn()
}))

vi.mock('../src/lib/session-tracking.js', () => ({
  dedupeInjectedMemories: vi.fn(),
  listAllSessions: vi.fn(),
  loadSessionTracking: vi.fn()
}))

vi.mock('../src/lib/maintenance-review.js', () => ({
  reviewMaintenanceResult: vi.fn(),
  reviewMaintenanceResultStreaming: vi.fn()
}))

vi.mock('../src/lib/maintenance-api.js', () => ({
  MAINTENANCE_OPERATIONS: ['promotion-suggestions', 'cleanup'],
  MAINTENANCE_OPERATION_DEFINITIONS: [
    { id: 'promotion-suggestions', label: 'Promotion Suggestions' },
    { id: 'cleanup', label: 'Cleanup' }
  ],
  runAllMaintenance: vi.fn(),
  runMaintenanceOperation: vi.fn()
}))

const mockedLoadSettings = vi.mocked(loadSettings)
const mockedSaveSettings = vi.mocked(saveSettings)
const mockedResetSettings = vi.mocked(resetSettings)
const mockedGetDefaultSettings = vi.mocked(getDefaultSettings)
const mockedGetDefaultMaintenanceSettings = vi.mocked(getDefaultMaintenanceSettings)
const mockedValidateSettingValue = vi.mocked(validateSettingValue)
const mockedCoerceRetrievalSettings = vi.mocked(coerceRetrievalSettings)
const mockedGetInstallationStatus = vi.mocked(getInstallationStatus)
const mockedGetHookStatus = vi.mocked(getHookStatus)
const mockedInstallAll = vi.mocked(installAll)
const mockedInstallHooks = vi.mocked(installHooks)
const mockedUninstallAll = vi.mocked(uninstallAll)
const mockedUninstallHooks = vi.mocked(uninstallHooks)
const mockedCountRecords = vi.mocked(countRecords)
const mockedQueryRecords = vi.mocked(queryRecords)
const mockedGetRecord = vi.mocked(getRecord)
const mockedDeleteRecord = vi.mocked(deleteRecord)
const mockedResetCollection = vi.mocked(resetCollection)
const mockedHybridSearch = vi.mocked(hybridSearch)
const mockedIterateRecords = vi.mocked(iterateRecords)
const mockedBuildKeywordFilter = vi.mocked(buildKeywordFilter)
const mockedEscapeFilterValue = vi.mocked(escapeFilterValue)
const mockedGetRecordStats = vi.mocked(getRecordStats)
const mockedMergeNearMisses = vi.mocked(mergeNearMisses)
const mockedRetrieveContext = vi.mocked(retrieveContext)
const mockedReviewInjection = vi.mocked(reviewInjection)
const mockedReviewInjectionStreaming = vi.mocked(reviewInjectionStreaming)
const mockedListAllSessions = vi.mocked(listAllSessions)
const mockedLoadSessionTracking = vi.mocked(loadSessionTracking)
const mockedDedupeInjectedMemories = vi.mocked(dedupeInjectedMemories)
const mockedGetInjectionReview = vi.mocked(getInjectionReview)
const mockedGetExtractionRun = vi.mocked(getExtractionRun)
const mockedListExtractionRuns = vi.mocked(listExtractionRuns)
const mockedReviewExtraction = vi.mocked(reviewExtraction)
const mockedReviewExtractionStreaming = vi.mocked(reviewExtractionStreaming)
const mockedGetReview = vi.mocked(getReview)
const mockedSaveReview = vi.mocked(saveReview)
const mockedGetMaintenanceReview = vi.mocked(getMaintenanceReview)
const mockedSaveMaintenanceReview = vi.mocked(saveMaintenanceReview)
const mockedReviewMaintenanceResult = vi.mocked(reviewMaintenanceResult)
const mockedReviewMaintenanceResultStreaming = vi.mocked(reviewMaintenanceResultStreaming)
const mockedRunAllMaintenance = vi.mocked(runAllMaintenance)
const mockedRunMaintenanceOperation = vi.mocked(runMaintenanceOperation)

const DEFAULT_SETTINGS = { maxRecords: 5, includeDeprecated: false }
const DEFAULT_MAINTENANCE = { retentionDays: 7 }

const makeAsyncIterable = <T,>(items: T[]): AsyncIterable<T> => ({
  async *[Symbol.asyncIterator]() {
    for (const item of items) {
      yield item
    }
  }
})

const buildApp = (overrides: Partial<{
  configRoot: string
  config: typeof DEFAULT_CONFIG
  memoryTypes: string[]
  suggestionAllowedRoots: string[]
  claudeSettingsPath: string
  ensureInitialized: () => Promise<void>
}> = {}) => {
  const context = {
    configRoot: overrides.configRoot ?? '/tmp',
    config: overrides.config ?? DEFAULT_CONFIG,
    memoryTypes: overrides.memoryTypes ?? ['command', 'error'],
    suggestionAllowedRoots: overrides.suggestionAllowedRoots ?? ['/tmp'],
    claudeSettingsPath: overrides.claudeSettingsPath ?? '/tmp/settings.json',
    ensureInitialized: overrides.ensureInitialized ?? vi.fn().mockResolvedValue(undefined)
  }

  const app = express()
  app.use(express.json())
  app.use(createSettingsRouter())
  app.use(createInstallationRouter(context))
  app.use(createMemoryRouter(context))
  app.use(createPreviewRouter(context))
  app.use(createSessionsRouter(context))
  app.use(createExtractionsRouter(context))
  app.use(createMaintenanceRouter(context))

  return { app, context }
}

const buildNewFileDiff = (target: string, lines: string[]): string => {
  return [
    `diff --git a/${target} b/${target}`,
    '--- /dev/null',
    `+++ b/${target}`,
    '@@ -0,0 +1,0 @@',
    ...lines.map(line => `+${line}`)
  ].join('\n')
}

const buildEditDiff = (target: string, lines: string[]): string => {
  return [
    `diff --git a/${target} b/${target}`,
    `--- a/${target}`,
    `+++ b/${target}`,
    '@@ -1,0 +1,0 @@',
    ...lines.map(line => `+${line}`)
  ].join('\n')
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedLoadSettings.mockReturnValue({ ...DEFAULT_SETTINGS })
  mockedSaveSettings.mockResolvedValue(undefined)
  mockedResetSettings.mockResolvedValue(undefined)
  mockedGetDefaultSettings.mockReturnValue({ ...DEFAULT_SETTINGS })
  mockedGetDefaultMaintenanceSettings.mockReturnValue({ ...DEFAULT_MAINTENANCE })
  mockedValidateSettingValue.mockReturnValue({ ok: true, normalized: 8 })
  mockedCoerceRetrievalSettings.mockImplementation((override, base) => ({ ...base, ...override }))
  mockedGetInstallationStatus.mockReturnValue({ hooks: { ok: true }, commands: { ok: true } })
  mockedGetHookStatus.mockReturnValue({ prePrompt: true })
  mockedInstallAll.mockReturnValue({ hooks: { ok: true }, commands: { ok: true } })
  mockedInstallHooks.mockReturnValue({ prePrompt: true })
  mockedUninstallAll.mockReturnValue({ hooks: { ok: false }, commands: { ok: false } })
  mockedUninstallHooks.mockReturnValue({ prePrompt: false })
  mockedCountRecords.mockResolvedValue(0)
  mockedQueryRecords.mockResolvedValue([])
  mockedGetRecord.mockResolvedValue(null)
  mockedDeleteRecord.mockResolvedValue(undefined)
  mockedResetCollection.mockResolvedValue(undefined)
  mockedHybridSearch.mockResolvedValue([])
  mockedIterateRecords.mockReturnValue(makeAsyncIterable([]))
  mockedBuildKeywordFilter.mockImplementation((_query, baseFilter) => baseFilter)
  mockedEscapeFilterValue.mockImplementation(value => String(value))
  mockedGetRecordStats.mockResolvedValue(new Map())
  mockedMergeNearMisses.mockImplementation((target, incoming) => {
    for (const entry of incoming) {
      const id = entry?.record?.record?.id ?? entry?.record?.id ?? 'unknown'
      const existing = target.get(id)
      if (existing) {
        existing.exclusionReasons.push(...entry.exclusionReasons)
      } else {
        target.set(id, { record: entry.record, exclusionReasons: [...entry.exclusionReasons] })
      }
    }
  })
  mockedRetrieveContext.mockResolvedValue({
    context: null,
    signals: { commands: [], errors: [] },
    results: [],
    injectedRecords: [],
    timedOut: false
  })
  mockedReviewInjection.mockResolvedValue({ status: 'ok' })
  mockedReviewInjectionStreaming.mockResolvedValue({ status: 'ok' })
  mockedListAllSessions.mockReturnValue([])
  mockedLoadSessionTracking.mockReturnValue(null)
  mockedDedupeInjectedMemories.mockImplementation(memories => memories)
  mockedGetInjectionReview.mockReturnValue(null)
  mockedGetExtractionRun.mockReturnValue(null)
  mockedListExtractionRuns.mockReturnValue([])
  mockedReviewExtraction.mockResolvedValue({ status: 'ok' })
  mockedReviewExtractionStreaming.mockResolvedValue({ status: 'ok' })
  mockedGetReview.mockReturnValue(null)
  mockedSaveReview.mockResolvedValue(undefined)
  mockedGetMaintenanceReview.mockReturnValue(null)
  mockedSaveMaintenanceReview.mockResolvedValue(undefined)
  mockedReviewMaintenanceResult.mockResolvedValue({ status: 'ok' })
  mockedReviewMaintenanceResultStreaming.mockResolvedValue({ status: 'ok' })
  mockedRunAllMaintenance.mockResolvedValue([{ operation: 'promotion-suggestions', ok: true }])
  mockedRunMaintenanceOperation.mockResolvedValue({ operation: 'promotion-suggestions', ok: true })
})

describe('settings routes', () => {
  it('returns current settings and defaults', async () => {
    const { app } = buildApp()

    const settingsRes = await request(app).get('/api/settings')
    expect(settingsRes.status).toBe(200)
    expect(settingsRes.body).toEqual(DEFAULT_SETTINGS)

    const defaultsRes = await request(app).get('/api/settings/defaults')
    expect(defaultsRes.status).toBe(200)
    expect(defaultsRes.body).toEqual({
      settings: DEFAULT_SETTINGS,
      maintenance: DEFAULT_MAINTENANCE
    })
  })

  it('validates settings payloads', async () => {
    const { app } = buildApp()

    const badPut = await request(app).put('/api/settings').send(['nope'])
    expect(badPut.status).toBe(400)
    expect(badPut.body).toEqual({ error: 'Settings payload must be an object' })

    mockedValidateSettingValue.mockReturnValueOnce({ ok: false, error: 'Invalid value' })
    const badPatch = await request(app)
      .patch('/api/settings')
      .send({ setting: 'maxRecords', value: 'bad' })
    expect(badPatch.status).toBe(400)
    expect(badPatch.body).toEqual({ error: 'Invalid value' })
  })

  it('updates a single setting with normalization', async () => {
    mockedLoadSettings.mockReturnValueOnce({ maxRecords: 12 })
    mockedValidateSettingValue.mockReturnValueOnce({ ok: true, normalized: 12 })

    const { app } = buildApp()
    const res = await request(app)
      .patch('/api/settings')
      .send({ setting: 'maxRecords', value: '12' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ maxRecords: 12 })
    expect(mockedSaveSettings).toHaveBeenCalled()
  })
})

describe('installation routes', () => {
  it('returns permission errors with 403', async () => {
    const error = new Error('nope') as NodeJS.ErrnoException
    error.code = 'EACCES'
    mockedGetInstallationStatus.mockImplementationOnce(() => {
      throw error
    })

    const { app } = buildApp()
    const res = await request(app).get('/api/installation/status')

    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'Permission denied' })
  })

  it('surfaces installer errors without stack traces', async () => {
    mockedInstallHooks.mockImplementationOnce(() => {
      throw new ClaudeSettingsError('Bad settings')
    })

    const { app } = buildApp()
    const res = await request(app).post('/api/hooks/install')

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'Bad settings' })
  })
})

describe('memory routes', () => {
  it('coerces pagination parameters', async () => {
    const { app } = buildApp()
    const res = await request(app).get('/api/memories?limit=oops&offset=-10')

    expect(res.status).toBe(200)
    expect(res.body.limit).toBe(100)
    expect(res.body.offset).toBe(0)
  })

  it('returns 404 for unknown memory', async () => {
    const { app } = buildApp()
    const res = await request(app).get('/api/memories/missing')

    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'Memory not found' })
  })

  it('deletes memories when found', async () => {
    mockedGetRecord.mockResolvedValueOnce({ id: 'mem-1' })

    const { app } = buildApp()
    const res = await request(app).delete('/api/memories/mem-1')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true })
  })

  it('requires a query for search', async () => {
    const { app } = buildApp()
    const res = await request(app).get('/api/search')

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'Query required' })
  })

  it('returns search results with trimmed query', async () => {
    mockedCountRecords.mockResolvedValueOnce(1)
    mockedHybridSearch.mockResolvedValueOnce([
      {
        record: { id: 'rec-1', type: 'command' },
        score: 0.9,
        similarity: 0.92,
        keywordMatch: true
      }
    ])

    const { app } = buildApp()
    const res = await request(app).get('/api/search?q=%20find%20me%20')

    expect(res.status).toBe(200)
    expect(res.body.query).toBe('find me')
    expect(res.body.results).toHaveLength(1)
    expect(res.body.results[0]).toMatchObject({
      record: { id: 'rec-1', type: 'command' },
      score: 0.9,
      similarity: 0.92,
      keywordMatch: true
    })
  })

  it('returns a generic error when listing fails', async () => {
    mockedQueryRecords.mockRejectedValueOnce(new Error('milvus down'))

    const { app } = buildApp()
    const res = await request(app).get('/api/memories')

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'Failed to list memories' })
  })
})

describe('preview routes', () => {
  it('requires a prompt', async () => {
    const { app } = buildApp()
    const res = await request(app).post('/api/preview').send({ cwd: '/tmp' })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'Prompt required' })
  })

  it('includes diagnostics when requested', async () => {
    const scored = {
      record: { id: 'rec-1', type: 'command' },
      score: 0.8,
      similarity: 0.81,
      keywordMatch: true
    }
    const nearMiss = {
      record: scored,
      exclusionReasons: [{ reason: 'score', threshold: 0.9, actual: 0.8, gap: 0.1 }]
    }
    mockedRetrieveContext.mockResolvedValueOnce({
      context: 'ctx',
      signals: { commands: [], errors: [] },
      results: [scored],
      injectedRecords: [scored.record],
      timedOut: false,
      diagnostics: {
        search: { qualified: [], nearMisses: [nearMiss] },
        context: { context: 'ctx', injectedRecords: [scored], exclusions: [nearMiss] }
      }
    })

    const { app } = buildApp()
    const res = await request(app)
      .post('/api/preview?diagnostic=true')
      .send({ prompt: 'hello', cwd: '/tmp', settings: { maxRecords: 3 } })

    expect(res.status).toBe(200)
    expect(res.body.results).toHaveLength(1)
    expect(res.body.nearMisses).toHaveLength(1)
    expect(res.body.injected).toHaveLength(1)
  })
})

describe('sessions routes', () => {
  it('returns sessions with stats', async () => {
    mockedListAllSessions.mockReturnValueOnce([
      {
        sessionId: 'session-1',
        memories: [
          { id: 'mem-1', injectedAt: 1 },
          { id: 'mem-1', injectedAt: 2 }
        ]
      }
    ])
    mockedDedupeInjectedMemories.mockImplementationOnce(memories => [memories[memories.length - 1]])
    mockedGetRecordStats.mockResolvedValueOnce(new Map([['mem-1', { retrievalCount: 2 }]]))

    const { app } = buildApp()
    const res = await request(app).get('/api/sessions')

    expect(res.status).toBe(200)
    expect(res.body.sessions).toHaveLength(1)
    expect(res.body.sessions[0].memories[0].stats).toEqual({ retrievalCount: 2 })
  })

  it('streams injection review responses', async () => {
    mockedLoadSessionTracking.mockReturnValueOnce({ sessionId: 'session-1' })
    mockedReviewInjectionStreaming.mockImplementationOnce(async (_sessionId, _config, onThinking) => {
      onThinking('thinking...')
      return { sessionId: 'session-1', status: 'ok' }
    })

    const { app } = buildApp()
    const res = await request(app)
      .post('/api/sessions/session-1/review?stream=true')
      .send({})

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/event-stream')
    expect(res.text).toContain('data: {"thinking":"thinking..."}\n\n')
    expect(res.text).toContain('data: {"result":{"sessionId":"session-1","status":"ok"}}\n\n')
    expect(res.text).toContain('data: [DONE]\n\n')
  })

  it('closes streams on review errors', async () => {
    mockedLoadSessionTracking.mockReturnValueOnce({ sessionId: 'session-1' })
    mockedReviewInjectionStreaming.mockImplementationOnce(async () => {
      throw new Error('Review failed')
    })

    const { app } = buildApp()
    const res = await request(app)
      .post('/api/sessions/session-1/review?stream=true')
      .send({})

    expect(res.status).toBe(200)
    expect(res.text).toContain('data: {"error":"Review failed"}\n\n')
    expect(res.text).toContain('data: [DONE]\n\n')
  })
})

describe('extractions routes', () => {
  it('paginates extraction runs', async () => {
    mockedListExtractionRuns.mockReturnValueOnce([
      { runId: 'run-1', timestamp: 1 },
      { runId: 'run-2', timestamp: 2 },
      { runId: 'run-3', timestamp: 3 }
    ])

    const { app } = buildApp()
    const res = await request(app).get('/api/extractions?limit=1&offset=1')

    expect(res.status).toBe(200)
    expect(res.body.count).toBe(1)
    expect(res.body.total).toBe(3)
    expect(res.body.runs[0].runId).toBe('run-2')
  })

  it('returns ordered extraction records', async () => {
    mockedGetExtractionRun.mockReturnValueOnce({
      runId: 'run-1',
      extractedRecordIds: ['b', 'a']
    })
    mockedQueryRecords.mockResolvedValueOnce([
      { id: 'a', type: 'command' },
      { id: 'b', type: 'error' }
    ])

    const { app } = buildApp()
    const res = await request(app).get('/api/extractions/run-1')

    expect(res.status).toBe(200)
    expect(res.body.records.map((record: { id: string }) => record.id)).toEqual(['b', 'a'])
  })

  it('streams extraction reviews', async () => {
    mockedGetExtractionRun.mockReturnValueOnce({ runId: 'run-1' })
    mockedReviewExtractionStreaming.mockImplementationOnce(async (_runId, _config, onThinking) => {
      onThinking('reviewing')
      return { runId: 'run-1', status: 'ok' }
    })

    const { app } = buildApp()
    const res = await request(app)
      .post('/api/extractions/run-1/review?stream=true')
      .send({})

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/event-stream')
    expect(res.text).toContain('data: {"thinking":"reviewing"}\n\n')
    expect(res.text).toContain('data: {"result":{"runId":"run-1","status":"ok"}}\n\n')
    expect(res.text).toContain('data: [DONE]\n\n')
  })
})

describe('maintenance routes', () => {
  it('rejects unknown review operations', async () => {
    const { app } = buildApp()
    const res = await request(app)
      .post('/api/maintenance/unknown/review')
      .send({ result: { operation: 'unknown' } })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'Unknown operation' })
  })

  it('streams maintenance reviews', async () => {
    mockedReviewMaintenanceResultStreaming.mockImplementationOnce(async (_result, _config, onThinking) => {
      onThinking('reviewing')
      return { status: 'ok' }
    })

    const { app } = buildApp()
    const res = await request(app)
      .post('/api/maintenance/promotion-suggestions/review?stream=true')
      .send({ result: { operation: 'promotion-suggestions', actions: [], candidates: [] } })

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/event-stream')
    expect(res.text).toContain('data: {"thinking":"reviewing"}\n\n')
    expect(res.text).toContain('data: {"result":{"status":"ok"}}\n\n')
    expect(res.text).toContain('data: [DONE]\n\n')
  })

  it('streams maintenance run progress', async () => {
    mockedRunMaintenanceOperation.mockImplementation(async (operation, dryRun) => ({
      operation,
      dryRun,
      ok: true
    }))

    const { app } = buildApp()
    const res = await request(app).get('/api/maintenance/stream?dryRun=true')

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/event-stream')
    expect(res.text).toContain('event: start')
    expect(res.text).toContain('event: progress')
    expect(res.text).toContain('event: result')
    expect(res.text).toContain('event: complete')
    expect(res.text).toContain('data: {"success":true}\n\n')
  })

  it('validates suggestion apply payloads', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-memory-test-'))
    try {
      const { app } = buildApp({
        configRoot: tempRoot,
        suggestionAllowedRoots: [tempRoot]
      })
      const badPayload = await request(app).post('/api/maintenance/suggestions/apply').send([])
      expect(badPayload.status).toBe(400)
      expect(badPayload.body).toEqual({ error: 'Invalid payload' })

      const mismatch = await request(app).post('/api/maintenance/suggestions/apply').send({
        recordId: 'rec-1',
        action: 'new',
        targetFile: 'note.txt',
        diff: buildNewFileDiff('other.txt', ['hello'])
      })
      expect(mismatch.status).toBe(400)
      expect(mismatch.body).toEqual({ error: 'Diff target does not match targetFile' })

      const traversal = await request(app).post('/api/maintenance/suggestions/apply').send({
        recordId: 'rec-1',
        action: 'new',
        targetFile: '../hack.txt',
        diff: buildNewFileDiff('../hack.txt', ['hello'])
      })
      expect(traversal.status).toBe(400)
      expect(traversal.body).toEqual({ error: 'Invalid targetFile path' })
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('applies new and edit suggestions', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-memory-test-'))
    try {
      const { app } = buildApp({
        configRoot: tempRoot,
        suggestionAllowedRoots: [tempRoot]
      })

      const newTarget = 'notes/new.txt'
      const newDiff = buildNewFileDiff(newTarget, ['line one', 'line two'])
      const createRes = await request(app).post('/api/maintenance/suggestions/apply').send({
        recordId: 'rec-1',
        action: 'new',
        targetFile: newTarget,
        diff: newDiff
      })

      expect(createRes.status).toBe(200)
      expect(createRes.body.success).toBe(true)
      const createdContent = await fs.readFile(path.join(tempRoot, newTarget), 'utf-8')
      expect(createdContent).toBe('line one\nline two\n')

      const existingTarget = 'existing.txt'
      await fs.writeFile(path.join(tempRoot, existingTarget), 'base\n', 'utf-8')
      const editDiff = buildEditDiff(existingTarget, ['appended'])
      const editRes = await request(app).post('/api/maintenance/suggestions/apply').send({
        recordId: 'rec-2',
        action: 'edit',
        targetFile: existingTarget,
        diff: editDiff
      })

      expect(editRes.status).toBe(200)
      const updatedContent = await fs.readFile(path.join(tempRoot, existingTarget), 'utf-8')
      expect(updatedContent).toBe('base\nappended\n')
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('returns conflict for existing targets without overwrite', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-memory-test-'))
    try {
      const { app } = buildApp({
        configRoot: tempRoot,
        suggestionAllowedRoots: [tempRoot]
      })

      const target = 'exists.txt'
      await fs.writeFile(path.join(tempRoot, target), 'base\n', 'utf-8')
      const diff = buildNewFileDiff(target, ['line'])
      const res = await request(app).post('/api/maintenance/suggestions/apply').send({
        recordId: 'rec-1',
        action: 'new',
        targetFile: target,
        diff
      })

      expect(res.status).toBe(409)
      expect(res.body).toEqual({ error: 'Target file already exists' })
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('rejects invalid diff formats', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-memory-test-'))
    try {
      const { app } = buildApp({
        configRoot: tempRoot,
        suggestionAllowedRoots: [tempRoot]
      })

      const invalidDiff = [
        'diff --git a/file.txt b/file.txt',
        '--- a/file.txt',
        '+++ b/file.txt',
        '@@ -1,1 +1,1 @@',
        '-old line',
        '+new line'
      ].join('\n')

      const res = await request(app).post('/api/maintenance/suggestions/apply').send({
        recordId: 'rec-1',
        action: 'edit',
        targetFile: 'file.txt',
        diff: invalidDiff
      })

      expect(res.status).toBe(400)
      expect(res.body).toEqual({ error: 'Invalid diff format' })
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true })
    }
  })
})
