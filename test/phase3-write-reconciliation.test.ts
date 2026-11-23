import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, EMBEDDING_DIM, type DiscoveryRecord } from '../src/lib/types.js'
import { cleanupTempFiles, createMockDiscoveryRecord, createMockTranscript } from './helpers.js'

process.env.CC_MEMORIES_SETTING_EXTRACTION_MIN_TOKENS = '0'

vi.mock('../src/lib/extract.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/extract.js')>('../src/lib/extract.js')
  return {
    ...actual,
    extractRecords: vi.fn()
  }
})

vi.mock('../src/lib/embed.js', () => ({
  embedBatch: vi.fn()
}))

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

vi.mock('../src/lib/write-reconciliation.js', () => ({
  reconcileIncomingRecord: vi.fn()
}))

import { handlePostSession, buildUpdates } from '../src/hooks/post-session.js'
import { extractRecords } from '../src/lib/extract.js'
import { findSimilar, insertRecord, updateRecord } from '../src/lib/lancedb.js'
import { markDeprecated } from '../src/lib/maintenance/operations.js'
import { reconcileIncomingRecord } from '../src/lib/write-reconciliation.js'

const mockedExtract = vi.mocked(extractRecords)
const mockedFindSimilar = vi.mocked(findSimilar)
const mockedInsert = vi.mocked(insertRecord)
const mockedUpdate = vi.mocked(updateRecord)
const mockedDeprecate = vi.mocked(markDeprecated)
const mockedReconcile = vi.mocked(reconcileIncomingRecord)

function makeVec(axis: number): number[] {
  const v = new Array<number>(EMBEDDING_DIM).fill(0)
  v[axis] = 1
  return v
}

function makeTranscript(): string {
  return createMockTranscript([
    { type: 'user', message: { role: 'user', content: 'Update config details' } },
    { type: 'assistant', message: { role: 'assistant', content: 'Updated port from 3001 to 4001' } }
  ])
}

describe('Phase 3: Write-time reconciliation (ADD / NOOP / UPDATE / SUPERSEDE)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedInsert.mockResolvedValue(undefined)
    mockedUpdate.mockResolvedValue(true)
    mockedDeprecate.mockResolvedValue(true)
  })

  afterEach(() => {
    cleanupTempFiles()
  })

  it('handles ADD, NOOP, UPDATE, and SUPERSEDE verdicts from reconcileIncomingRecord', async () => {
    const incomingNoop = createMockDiscoveryRecord({
      id: 'inc-noop',
      what: 'Proxy listens on HTTPS 8443',
      where: 'config',
      evidence: 'checked config',
      project: '/srv/demo',
      embedding: makeVec(0)
    })
    const neighborNoop: DiscoveryRecord = createMockDiscoveryRecord({
      id: 'nbr-noop',
      what: 'The AI proxy runs on port 8443 over TLS',
      where: 'settings.json',
      evidence: 'observed',
      project: '/srv/demo',
      embedding: makeVec(0)
    })

    const incomingUpdate = createMockDiscoveryRecord({
      id: 'inc-update',
      what: 'LanceDB compaction drops old versions after 24h',
      where: 'lancedb-client.ts',
      evidence: 'also rebuilds FTS index',
      project: '/srv/demo',
      embedding: makeVec(1)
    })
    const neighborUpdate: DiscoveryRecord = createMockDiscoveryRecord({
      id: 'nbr-update',
      what: 'LanceDB compaction merges fragments',
      where: 'lancedb-client.ts',
      evidence: 'compactTable()',
      project: '/srv/demo',
      embedding: makeVec(1)
    })

    const incomingSupersede = createMockDiscoveryRecord({
      id: 'inc-supersede',
      what: 'Dashboard API moved to port 4001',
      where: 'dashboard/server',
      evidence: 'changed PORT default',
      project: '/srv/demo',
      embedding: makeVec(2)
    })
    const neighborOld: DiscoveryRecord = createMockDiscoveryRecord({
      id: 'nbr-old',
      what: 'Dashboard API listens on port 3001',
      where: 'dashboard/server',
      evidence: 'old config',
      project: '/srv/demo',
      embedding: makeVec(2)
    })

    const incomingAdd = createMockDiscoveryRecord({
      id: 'inc-add',
      what: 'Worker queues SessionEnd when PreCompact holds session lock',
      where: 'post-session-worker.ts',
      evidence: 'enqueuePendingPayload',
      project: '/srv/demo',
      embedding: makeVec(3)
    })
    const neighborDistinct: DiscoveryRecord = createMockDiscoveryRecord({
      id: 'nbr-distinct',
      what: 'Worker cleans lock files stale after 10 minutes',
      where: 'post-session-worker.ts',
      evidence: 'LOCK_STALE_MS',
      project: '/srv/demo',
      embedding: makeVec(3)
    })

    mockedExtract.mockResolvedValueOnce({
      records: [incomingNoop, incomingUpdate, incomingSupersede, incomingAdd],
      tokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }
    })

    mockedFindSimilar
      .mockResolvedValueOnce([{ record: neighborNoop, similarity: 0.78 }])
      .mockResolvedValueOnce([{ record: neighborUpdate, similarity: 0.76 }])
      .mockResolvedValueOnce([{ record: neighborOld, similarity: 0.81 }])
      .mockResolvedValueOnce([{ record: neighborDistinct, similarity: 0.73 }])

    mockedReconcile
      .mockResolvedValueOnce({
        action: 'NOOP',
        targetRecord: neighborNoop,
        targetSimilarity: 0.78,
        reason: 'already covered',
        model: 'claude-sonnet-5-5'
      })
      .mockResolvedValueOnce({
        action: 'UPDATE',
        targetRecord: neighborUpdate,
        targetSimilarity: 0.76,
        mergedUpdates: { what: 'LanceDB compaction merges fragments, prunes versions >24h, and rebuilds FTS index' },
        reason: 'adds FTS rebuild detail',
        model: 'claude-sonnet-5-5'
      })
      .mockResolvedValueOnce({
        action: 'SUPERSEDE',
        targetRecord: neighborOld,
        targetSimilarity: 0.81,
        reason: 'port changed from 3001 to 4001',
        model: 'claude-sonnet-5-5'
      })
      .mockResolvedValueOnce({
        action: 'ADD',
        reason: 'distinct locking mechanism',
        model: 'claude-sonnet-5-5'
      })

    const res = await handlePostSession({
      hook_event_name: 'SessionEnd',
      session_id: 'reconcile-sess',
      transcript_path: makeTranscript(),
      cwd: '/srv/demo',
      permission_mode: 'default',
      reason: 'prompt_input_exit'
    }, DEFAULT_CONFIG)

    expect(res.skipped).toBe(1) // NOOP
    expect(res.updated).toBe(1) // UPDATE
    expect(res.inserted).toBe(2) // SUPERSEDE + ADD
    expect(res.updatedIds).toEqual(['nbr-update'])
    expect(res.insertedIds).toEqual(['inc-supersede', 'inc-add'])
    expect(mockedUpdate).toHaveBeenCalledWith(
      'nbr-update',
      expect.objectContaining({
        what: 'LanceDB compaction merges fragments, prunes versions >24h, and rebuilds FTS index'
      }),
      DEFAULT_CONFIG,
      expect.any(Object)
    )
    expect(mockedDeprecate).toHaveBeenCalledWith(
      'nbr-old',
      DEFAULT_CONFIG,
      expect.objectContaining({ supersedingRecordId: 'inc-supersede' })
    )
  })

  it('does NOT fast-path NOOP procedures with updated steps or commands with flipped outcomes, accumulates reconcile tokens, and protects shared-scope projects', async () => {
    const existingProc = {
      id: 'proc-old',
      type: 'procedure' as const,
      name: 'Deploy API',
      steps: ['pnpm build', 'ssh old-host'],
      context: { project: '/srv/demo' },
      project: '/srv/demo',
      scope: 'project' as const,
      embedding: makeVec(4)
    }
    const updatedProc = {
      id: 'proc-new',
      type: 'procedure' as const,
      name: 'Deploy API',
      steps: ['pnpm build', 'ssh new-host'],
      context: { project: '/srv/demo' },
      project: '/srv/demo',
      scope: 'project' as const,
      embedding: makeVec(4)
    }
    const existingCmd = {
      id: 'cmd-old',
      type: 'command' as const,
      command: 'pnpm deploy',
      exitCode: 0,
      outcome: 'success' as const,
      context: { project: '/srv/demo', cwd: '/srv/demo', intent: 'deploy' },
      project: '/srv/demo',
      scope: 'project' as const,
      embedding: makeVec(5)
    }
    const failedCmd = {
      id: 'cmd-new',
      type: 'command' as const,
      command: 'pnpm deploy',
      exitCode: 1,
      outcome: 'failure' as const,
      resolution: 'Must pass --confirm flag now',
      context: { project: '/srv/demo', cwd: '/srv/demo', intent: 'deploy' },
      project: '/srv/demo',
      scope: 'project' as const,
      embedding: makeVec(5)
    }

    mockedExtract.mockResolvedValueOnce({
      records: [updatedProc, failedCmd],
      tokenUsage: { inputTokens: 100, outputTokens: 20, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }
    })
    mockedFindSimilar
      .mockResolvedValueOnce([{ record: existingProc, similarity: 0.95 }])
      .mockResolvedValueOnce([{ record: existingCmd, similarity: 0.96 }])
    mockedReconcile
      .mockResolvedValueOnce({
        action: 'UPDATE',
        targetRecord: existingProc,
        targetSimilarity: 0.95,
        mergedUpdates: { steps: ['pnpm build', 'ssh new-host'] },
        reason: 'host changed',
        model: 'claude-sonnet-5-5',
        tokenUsage: { inputTokens: 50, outputTokens: 15, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }
      })
      .mockResolvedValueOnce({
        action: 'SUPERSEDE',
        targetRecord: existingCmd,
        targetSimilarity: 0.96,
        reason: 'command now fails without --confirm',
        model: 'claude-sonnet-5-5',
        tokenUsage: { inputTokens: 60, outputTokens: 10, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }
      })

    const res = await handlePostSession({
      hook_event_name: 'SessionEnd',
      session_id: 'reconcile-steps-sess',
      transcript_path: makeTranscript(),
      cwd: '/srv/demo',
      permission_mode: 'default',
      reason: 'prompt_input_exit'
    }, DEFAULT_CONFIG)

    // Both MUST invoke reconcileIncomingRecord instead of fast-pathing!
    expect(mockedReconcile).toHaveBeenCalledTimes(2)
    expect(res.updated).toBe(1)
    expect(res.inserted).toBe(1)
    expect(res.tokenUsage?.inputTokens).toBe(210)
    expect(res.tokenUsage?.outputTokens).toBe(45)

    // buildUpdates must NOT attach incoming.project to environment-scoped records
    const envTarget = createMockDiscoveryRecord({ id: 'env-1', scope: 'environment', project: '' })
    const projIncoming = createMockDiscoveryRecord({ id: 'p-1', scope: 'project', project: '/srv/demo' })
    expect(buildUpdates(envTarget, projIncoming).project).toBeUndefined()
  })

  it('deprecates both explicit record.supersedes and a different reconciled SUPERSEDE target', async () => {
    const incoming = createMockDiscoveryRecord({
      id: 'inc-dual',
      what: 'API runs on port 5000',
      where: 'server.ts',
      evidence: 'updated',
      project: '/srv/demo',
      supersedes: 'old-explicit-id',
      embedding: makeVec(6)
    })
    const neighbor = createMockDiscoveryRecord({
      id: 'old-neighbor-id',
      what: 'API runs on port 4000',
      where: 'server.ts',
      evidence: 'stale',
      project: '/srv/demo',
      embedding: makeVec(6)
    })

    mockedExtract.mockResolvedValueOnce({
      records: [incoming],
      tokenUsage: { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }
    })
    mockedFindSimilar.mockResolvedValueOnce([{ record: neighbor, similarity: 0.88 }])
    mockedReconcile.mockResolvedValueOnce({
      action: 'SUPERSEDE',
      targetRecord: neighbor,
      targetSimilarity: 0.88,
      reason: 'obsolete port',
      model: 'claude-sonnet-5-5'
    })

    await handlePostSession({
      hook_event_name: 'SessionEnd',
      session_id: 'reconcile-dual-sup',
      transcript_path: makeTranscript(),
      cwd: '/srv/demo',
      permission_mode: 'default',
      reason: 'prompt_input_exit'
    }, DEFAULT_CONFIG)

    expect(mockedDeprecate).toHaveBeenCalledWith('old-explicit-id', DEFAULT_CONFIG, expect.anything())
    expect(mockedDeprecate).toHaveBeenCalledWith('old-neighbor-id', DEFAULT_CONFIG, expect.anything())
  })

  it('treats an UPDATE verdict with no substantive field changes as skipped instead of polluting updatedIds', async () => {
    const incoming = createMockDiscoveryRecord({
      id: 'inc-empty-update',
      what: 'Existing fact paraphrased',
      where: 'server.ts',
      evidence: 'checked',
      project: '/srv/demo',
      embedding: makeVec(7)
    })
    const crossTypeNeighbor = {
      id: 'warn-neighbor-id',
      type: 'warning' as const,
      avoid: 'Using old endpoint',
      useInstead: 'Use new endpoint',
      reason: 'deprecated',
      severity: 'warning' as const,
      project: '/srv/demo',
      scope: 'project' as const,
      embedding: makeVec(7)
    }

    mockedExtract.mockResolvedValueOnce({
      records: [incoming],
      tokenUsage: { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }
    })
    mockedFindSimilar.mockResolvedValueOnce([{ record: crossTypeNeighbor, similarity: 0.78 }])
    mockedReconcile.mockResolvedValueOnce({
      action: 'UPDATE',
      targetRecord: crossTypeNeighbor,
      targetSimilarity: 0.78,
      // No mergedUpdates (e.g. all invalid fields stripped) and cross-type -> baseUpdates is {}
      reason: 'covered by warning',
      model: 'claude-sonnet-5-5'
    })

    const res = await handlePostSession({
      hook_event_name: 'SessionEnd',
      session_id: 'reconcile-empty-upd',
      transcript_path: makeTranscript(),
      cwd: '/srv/demo',
      permission_mode: 'default',
      reason: 'prompt_input_exit'
    }, DEFAULT_CONFIG)

    expect(mockedUpdate).not.toHaveBeenCalled()
    expect(res.updated).toBe(0)
    expect(res.updatedIds).toEqual([])
    expect(res.skipped).toBe(1)
  })
})
