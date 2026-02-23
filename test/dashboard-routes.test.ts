import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { DEFAULT_CONFIG, EMBEDDING_DIM } from '../src/lib/types.js'
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
  fetchRecordsByIds,
  getRecord,
  getRecordStats,
  hybridSearch,
  insertRecord,
  iterateRecords,
  queryRecords,
  resetCollection
} from '../src/lib/milvus.js'
import { ensureClient } from '../src/lib/milvus-client.js'
import { mergeNearMisses } from '../src/lib/diagnostics.js'
import { retrieveContext } from '../src/lib/retrieval.js'
import { getTokenUsageActivity } from '../src/lib/token-usage-events.js'
import { reviewInjection, reviewInjectionStreaming } from '../src/lib/injection-review.js'
import { getExtractionRun, listExtractionRuns } from '../src/lib/extraction-log.js'
import { reviewExtraction, reviewExtractionStreaming } from '../src/lib/extraction-review.js'
import {
  getInjectionReview,
  hasInjectionReview,
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
  insertRecord: vi.fn(),
  countRecords: vi.fn(),
  deleteRecord: vi.fn(),
  escapeFilterValue: vi.fn(),
  fetchRecordsByIds: vi.fn(),
  getRecord: vi.fn(),
  getRecordStats: vi.fn(),
  hybridSearch: vi.fn(),
  iterateRecords: vi.fn(),
  queryRecords: vi.fn(),
  resetCollection: vi.fn(),
  buildKeywordFilter: vi.fn()
}))

vi.mock('../src/lib/milvus-client.js', () => ({
  ensureClient: vi.fn()
}))

vi.mock('../src/lib/diagnostics.js', () => ({
  mergeNearMisses: vi.fn()
}))

vi.mock('../src/lib/retrieval.js', () => ({
  retrieveContext: vi.fn()
}))

vi.mock('../src/lib/token-usage-events.js', () => ({
  getTokenUsageActivity: vi.fn()
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
  hasInjectionReview: vi.fn(),
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
const mockedFetchRecordsByIds = vi.mocked(fetchRecordsByIds)
const mockedGetRecord = vi.mocked(getRecord)
const mockedDeleteRecord = vi.mocked(deleteRecord)
const mockedResetCollection = vi.mocked(resetCollection)
const mockedHybridSearch = vi.mocked(hybridSearch)
const mockedEnsureClient = vi.mocked(ensureClient)
const mockedInsertRecord = vi.mocked(insertRecord)
const mockedIterateRecords = vi.mocked(iterateRecords)
const mockedBuildKeywordFilter = vi.mocked(buildKeywordFilter)
const mockedEscapeFilterValue = vi.mocked(escapeFilterValue)
const mockedGetRecordStats = vi.mocked(getRecordStats)
const mockedMergeNearMisses = vi.mocked(mergeNearMisses)
const mockedRetrieveContext = vi.mocked(retrieveContext)
const mockedGetTokenUsageActivity = vi.mocked(getTokenUsageActivity)
const mockedReviewInjection = vi.mocked(reviewInjection)
const mockedReviewInjectionStreaming = vi.mocked(reviewInjectionStreaming)
const mockedListAllSessions = vi.mocked(listAllSessions)
const mockedLoadSessionTracking = vi.mocked(loadSessionTracking)
const mockedDedupeInjectedMemories = vi.mocked(dedupeInjectedMemories)
const mockedGetInjectionReview = vi.mocked(getInjectionReview)
const mockedHasInjectionReview = vi.mocked(hasInjectionReview)
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
}> = {}) => {
  const context = {
    configRoot: overrides.configRoot ?? '/tmp',
    config: overrides.config ?? DEFAULT_CONFIG,
    memoryTypes: overrides.memoryTypes ?? ['command', 'error'],
    suggestionAllowedRoots: overrides.suggestionAllowedRoots ?? ['/tmp'],
    claudeSettingsPath: overrides.claudeSettingsPath ?? '/tmp/settings.json'
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

const buildEditDiff = (target: string, contextLines: string[], addedLines: string[]): string => {
  const oldCount = contextLines.length
  const newCount = contextLines.length + addedLines.length
  return [
    `diff --git a/${target} b/${target}`,
    `--- a/${target}`,
    `+++ b/${target}`,
    `@@ -1,${oldCount} +1,${newCount} @@`,
    ...contextLines.map(line => ` ${line}`),
    ...addedLines.map(line => `+${line}`)
  ].join('\n')
}

const buildMemoryPayload = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  id: 'mem-1',
  timestamp: 1700000000000,
  sourceExcerpt: 'Excerpt evidence.',
  ...overrides
})

const ALL_MEMORY_TYPES = ['command', 'error', 'discovery', 'procedure', 'warning']

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
  mockedFetchRecordsByIds.mockResolvedValue([])
  mockedGetRecord.mockResolvedValue(null)
  mockedDeleteRecord.mockResolvedValue(undefined)
  mockedResetCollection.mockResolvedValue(undefined)
  mockedHybridSearch.mockResolvedValue([])
  mockedEnsureClient.mockResolvedValue({} as any)
  mockedInsertRecord.mockResolvedValue(undefined)
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
  mockedGetTokenUsageActivity.mockReturnValue({
    period: 'day',
    source: 'all',
    buckets: []
  })
  mockedReviewInjection.mockResolvedValue({ status: 'ok' })
  mockedReviewInjectionStreaming.mockResolvedValue({ status: 'ok' })
  mockedListAllSessions.mockReturnValue([])
  mockedLoadSessionTracking.mockReturnValue(null)
  mockedDedupeInjectedMemories.mockImplementation(memories => memories)
  mockedGetInjectionReview.mockReturnValue(null)
  mockedHasInjectionReview.mockResolvedValue(false)
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
  const insertCases = [
    {
      label: 'command',
      id: 'cmd-1',
      payload: buildMemoryPayload({
        id: 'cmd-1',
        type: 'command',
        command: 'ls -la',
        exitCode: '0',
        outcome: 'success',
        context: { project: 'proj', cwd: '/tmp', intent: 'list files' }
      }),
      expected: {
        id: 'cmd-1',
        type: 'command',
        exitCode: 0,
        outcome: 'success'
      }
    },
    {
      label: 'error',
      id: 'err-1',
      payload: buildMemoryPayload({
        id: 'err-1',
        type: 'error',
        errorText: 'boom',
        errorType: 'TypeError',
        resolution: 'restart',
        context: { project: 'proj' }
      }),
      expected: {
        id: 'err-1',
        type: 'error',
        errorText: 'boom'
      }
    },
    {
      label: 'discovery',
      id: 'disc-1',
      payload: buildMemoryPayload({
        id: 'disc-1',
        type: 'discovery',
        what: 'feature flag enabled',
        where: 'config',
        evidence: 'observed in logs',
        confidence: 'verified'
      }),
      expected: {
        id: 'disc-1',
        type: 'discovery',
        confidence: 'verified'
      }
    },
    {
      label: 'procedure',
      id: 'proc-1',
      payload: buildMemoryPayload({
        id: 'proc-1',
        type: 'procedure',
        name: 'Run checks',
        steps: ['npm test', 'npm run build'],
        context: { project: 'proj' }
      }),
      expected: {
        id: 'proc-1',
        type: 'procedure',
        name: 'Run checks'
      }
    },
    {
      label: 'warning',
      id: 'warn-1',
      payload: buildMemoryPayload({
        id: 'warn-1',
        type: 'warning',
        avoid: 'manual edits',
        useInstead: 'use the formatter',
        reason: 'ensures consistent output',
        severity: 'warning'
      }),
      expected: {
        id: 'warn-1',
        type: 'warning',
        severity: 'warning'
      }
    }
  ]

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

  it.each(insertCases)('inserts %s records', async ({ id, payload, expected }) => {
    const { app } = buildApp({ memoryTypes: ALL_MEMORY_TYPES })
    const res = await request(app).post('/api/memories').send(payload)

    expect(res.status).toBe(201)
    expect(res.body).toEqual({ id, success: true })
    expect(mockedInsertRecord).toHaveBeenCalledWith(expect.objectContaining(expected), expect.anything())
  })

  it('rejects missing sourceExcerpt', async () => {
    const { app } = buildApp()
    const res = await request(app)
      .post('/api/memories')
      .send({
        type: 'error',
        errorText: 'boom',
        errorType: 'TypeError',
        resolution: 'restart',
        context: { project: 'proj' }
      })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'sourceExcerpt required' })
  })

  it('rejects invalid types', async () => {
    const { app } = buildApp()
    const res = await request(app)
      .post('/api/memories')
      .send({ type: 'nope', sourceExcerpt: 'Excerpt evidence.' })

    expect(res.status).toBe(400)
    expect(res.body.error).toContain('Invalid or missing type')
  })

  it('rejects invalid embedding dimensions', async () => {
    const { app } = buildApp({ memoryTypes: ALL_MEMORY_TYPES })
    const res = await request(app)
      .post('/api/memories')
      .send({
        type: 'discovery',
        sourceExcerpt: 'Excerpt evidence.',
        embedding: [0.1, 0.2]
      })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: `embedding must be length ${EMBEDDING_DIM}` })
  })

  it('rejects invalid embedding payloads', async () => {
    const { app } = buildApp({ memoryTypes: ALL_MEMORY_TYPES })
    const res = await request(app)
      .post('/api/memories')
      .send({
        type: 'discovery',
        sourceExcerpt: 'Excerpt evidence.',
        embedding: 'nope'
      })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'embedding must be an array of numbers' })
  })

  it('honors collection override header for memories', async () => {
    const { app } = buildApp()
    const res = await request(app)
      .get('/api/memories')
      .set('X-Milvus-Collection', 'test-collection')

    expect(res.status).toBe(200)
    expect(mockedEnsureClient).toHaveBeenCalledTimes(1)
    expect(mockedEnsureClient.mock.calls[0]?.[0]).toMatchObject({
      milvus: { collection: 'test-collection' }
    })
  })

  it('honors collection override header for memory detail', async () => {
    mockedGetRecord.mockResolvedValueOnce({ id: 'mem-1', type: 'command' })

    const { app } = buildApp()
    const res = await request(app)
      .get('/api/memories/mem-1')
      .set('X-Milvus-Collection', 'test-collection')

    expect(res.status).toBe(200)
    expect(mockedEnsureClient).toHaveBeenCalledTimes(1)
    expect(mockedEnsureClient.mock.calls[0]?.[0]).toMatchObject({
      milvus: { collection: 'test-collection' }
    })
  })

  it('honors collection override header for memory deletes', async () => {
    mockedGetRecord.mockResolvedValueOnce({ id: 'mem-1' })

    const { app } = buildApp()
    const res = await request(app)
      .delete('/api/memories/mem-1')
      .set('X-Milvus-Collection', 'test-collection')

    expect(res.status).toBe(200)
    expect(mockedEnsureClient).toHaveBeenCalledTimes(1)
    expect(mockedEnsureClient.mock.calls[0]?.[0]).toMatchObject({
      milvus: { collection: 'test-collection' }
    })
  })

  it('honors collection override header for memory inserts', async () => {
    const { app } = buildApp({ memoryTypes: ALL_MEMORY_TYPES })
    const payload = buildMemoryPayload({
      type: 'discovery',
      what: 'feature flag enabled',
      where: 'config',
      evidence: 'observed in logs',
      confidence: 'verified'
    })
    const res = await request(app)
      .post('/api/memories')
      .set('X-Milvus-Collection', 'test-collection')
      .send(payload)

    expect(res.status).toBe(201)
    expect(mockedInsertRecord).toHaveBeenCalledTimes(1)
    expect(mockedInsertRecord.mock.calls[0]?.[1]).toMatchObject({
      milvus: { collection: 'test-collection' }
    })
  })

  it('honors collection override header for stats', async () => {
    const { app } = buildApp()
    const res = await request(app)
      .get('/api/stats')
      .set('X-Milvus-Collection', 'test-collection')

    expect(res.status).toBe(200)
    expect(mockedEnsureClient).toHaveBeenCalledTimes(1)
    expect(mockedEnsureClient.mock.calls[0]?.[0]).toMatchObject({
      milvus: { collection: 'test-collection' }
    })
  })

  it('returns token usage activity with default query params', async () => {
    const { app } = buildApp()
    const res = await request(app).get('/api/token-usage')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ period: 'day', source: 'all', buckets: [] })
    expect(mockedGetTokenUsageActivity).toHaveBeenCalledWith('day', {
      limit: 30,
      source: 'all',
      collection: DEFAULT_CONFIG.milvus.collection
    })
  })

  it('passes period, limit, and source query params to token usage activity', async () => {
    mockedGetTokenUsageActivity.mockReturnValueOnce({
      period: 'week',
      source: 'haiku-query',
      buckets: [{
        start: 1707091200000,
        end: 1707696000000,
        totalTokens: 24,
        inputTokens: 18,
        outputTokens: 6,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0
      }]
    })

    const { app } = buildApp()
    const res = await request(app)
      .get('/api/token-usage?period=week&limit=5&source=haiku-query')
      .set('X-Milvus-Collection', 'test-collection')

    expect(res.status).toBe(200)
    expect(res.body.period).toBe('week')
    expect(res.body.source).toBe('haiku-query')
    expect(mockedGetTokenUsageActivity).toHaveBeenLastCalledWith('week', {
      limit: 5,
      source: 'haiku-query',
      collection: 'test-collection'
    })
  })

  it('honors collection override header for search', async () => {
    const { app } = buildApp()
    const res = await request(app)
      .get('/api/search?q=check')
      .set('X-Milvus-Collection', 'test-collection')

    expect(res.status).toBe(200)
    expect(mockedEnsureClient).toHaveBeenCalledTimes(1)
    expect(mockedEnsureClient.mock.calls[0]?.[0]).toMatchObject({
      milvus: { collection: 'test-collection' }
    })
  })

  it('honors collection override header for reset collection', async () => {
    const { app } = buildApp()
    const res = await request(app)
      .post('/api/reset-collection')
      .set('X-Milvus-Collection', 'test-collection')

    expect(res.status).toBe(200)
    expect(mockedEnsureClient).toHaveBeenCalledTimes(1)
    expect(mockedEnsureClient.mock.calls[0]?.[0]).toMatchObject({
      milvus: { collection: 'test-collection' }
    })
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

  it('honors collection override header for preview', async () => {
    const { app } = buildApp()
    const res = await request(app)
      .post('/api/preview')
      .set('X-Milvus-Collection', 'test-collection')
      .send({ prompt: 'hello', cwd: '/tmp' })

    expect(res.status).toBe(200)
    expect(mockedEnsureClient).toHaveBeenCalledTimes(1)
    expect(mockedEnsureClient.mock.calls[0]?.[0]).toMatchObject({
      milvus: { collection: 'test-collection' }
    })
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

  it('honors collection override header for sessions', async () => {
    const { app } = buildApp()
    const res = await request(app)
      .get('/api/sessions')
      .set('X-Milvus-Collection', 'test-collection')

    expect(res.status).toBe(200)
    expect(mockedEnsureClient).toHaveBeenCalledTimes(1)
    expect(mockedEnsureClient.mock.calls[0]?.[0]).toMatchObject({
      milvus: { collection: 'test-collection' }
    })
  })

  it('honors collection override header for session reviews', async () => {
    mockedLoadSessionTracking.mockReturnValueOnce({ sessionId: 'session-1' })

    const { app } = buildApp()
    const res = await request(app)
      .post('/api/sessions/session-1/review')
      .set('X-Milvus-Collection', 'test-collection')
      .send({})

    expect(res.status).toBe(200)
    expect(mockedEnsureClient).toHaveBeenCalledTimes(1)
    expect(mockedEnsureClient.mock.calls[0]?.[0]).toMatchObject({
      milvus: { collection: 'test-collection' }
    })
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

  it('honors collection override header for extraction reviews', async () => {
    mockedGetExtractionRun.mockReturnValueOnce({
      runId: 'run-1',
      sessionId: 'session-1',
      transcriptPath: '/tmp/session.jsonl',
      timestamp: 0,
      recordCount: 0,
      parseErrorCount: 0,
      extractedRecordIds: [],
      duration: 0
    })

    const { app } = buildApp()
    const res = await request(app)
      .post('/api/extractions/run-1/review')
      .set('X-Milvus-Collection', 'test-collection')
      .send({})

    expect(res.status).toBe(200)
    expect(mockedEnsureClient).toHaveBeenCalledTimes(1)
    expect(mockedEnsureClient.mock.calls[0]?.[0]).toMatchObject({
      milvus: { collection: 'test-collection' }
    })
  })

  it('honors collection override header for extraction runs', async () => {
    mockedGetExtractionRun.mockReturnValueOnce({
      runId: 'run-1',
      extractedRecordIds: ['rec-1']
    })
    mockedFetchRecordsByIds.mockResolvedValueOnce([
      { id: 'rec-1', type: 'command' }
    ])

    const { app } = buildApp()
    const res = await request(app)
      .get('/api/extractions/run-1')
      .set('X-Milvus-Collection', 'test-collection')

    expect(res.status).toBe(200)
    expect(mockedEnsureClient).toHaveBeenCalledTimes(1)
    expect(mockedEnsureClient.mock.calls[0]?.[0]).toMatchObject({
      milvus: { collection: 'test-collection' }
    })
  })

  it('returns ordered extraction records', async () => {
    mockedGetExtractionRun.mockReturnValueOnce({
      runId: 'run-1',
      extractedRecordIds: ['b', 'a']
    })
    mockedFetchRecordsByIds.mockResolvedValueOnce([
      { id: 'b', type: 'error' },
      { id: 'a', type: 'command' }
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

  it('honors collection override header for maintenance reviews', async () => {
    const { app } = buildApp()
    const res = await request(app)
      .post('/api/maintenance/promotion-suggestions/review')
      .set('X-Milvus-Collection', 'test-collection')
      .send({ result: { operation: 'promotion-suggestions', actions: [], candidates: [] } })

    expect(res.status).toBe(200)
    expect(mockedEnsureClient).toHaveBeenCalledTimes(1)
    expect(mockedEnsureClient.mock.calls[0]?.[0]).toMatchObject({
      milvus: { collection: 'test-collection' }
    })
  })

  it('honors collection override header for maintenance run', async () => {
    const { app } = buildApp()
    const res = await request(app)
      .post('/api/maintenance/run')
      .set('X-Milvus-Collection', 'test-collection')
      .send({ operation: 'promotion-suggestions' })

    expect(res.status).toBe(200)
    expect(mockedEnsureClient).toHaveBeenCalledTimes(1)
    expect(mockedEnsureClient.mock.calls[0]?.[0]).toMatchObject({
      milvus: { collection: 'test-collection' }
    })
  })

  it('honors collection override header for maintenance run-all', async () => {
    const { app } = buildApp()
    const res = await request(app)
      .post('/api/maintenance/run-all')
      .set('X-Milvus-Collection', 'test-collection')
      .send({ dryRun: true })

    expect(res.status).toBe(200)
    expect(mockedEnsureClient).toHaveBeenCalledTimes(1)
    expect(mockedEnsureClient.mock.calls[0]?.[0]).toMatchObject({
      milvus: { collection: 'test-collection' }
    })
  })

  it('honors collection override header for maintenance stream', async () => {
    const { app } = buildApp()
    const res = await request(app)
      .get('/api/maintenance/stream')
      .set('X-Milvus-Collection', 'test-collection')

    expect(res.status).toBe(200)
    expect(mockedEnsureClient).toHaveBeenCalledTimes(1)
    expect(mockedEnsureClient.mock.calls[0]?.[0]).toMatchObject({
      milvus: { collection: 'test-collection' }
    })
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
      const editDiff = buildEditDiff(existingTarget, ['base'], ['appended'])
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
        ' unchanged line'
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

  it('rejects stale edit diffs when hunk context mismatches', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-memory-test-'))
    try {
      const { app } = buildApp({
        configRoot: tempRoot,
        suggestionAllowedRoots: [tempRoot]
      })

      const target = 'stale.txt'
      await fs.writeFile(path.join(tempRoot, target), 'current line\n', 'utf-8')
      const staleDiff = [
        `diff --git a/${target} b/${target}`,
        `--- a/${target}`,
        `+++ b/${target}`,
        '@@ -1,1 +1,2 @@',
        ' expected line',
        '+appended line'
      ].join('\n')

      const res = await request(app).post('/api/maintenance/suggestions/apply').send({
        recordId: 'rec-1',
        action: 'edit',
        targetFile: target,
        diff: staleDiff
      })

      expect(res.status).toBe(409)
      expect(res.body.error).toContain('context mismatch')
      const content = await fs.readFile(path.join(tempRoot, target), 'utf-8')
      expect(content).toBe('current line\n')
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true })
    }
  })
})
