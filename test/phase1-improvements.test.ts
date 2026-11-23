import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AUTO_MAINTENANCE_OPERATIONS } from '../src/lib/maintenance-api.js'
import { buildCacheControl } from '../src/lib/prompt-cache.js'
import { buildContext, extractSignals } from '../src/lib/context.js'
import { isTrivialPrompt } from '../src/hooks/pre-prompt.js'
import { computeSmoothedUsageRatio } from '../src/lib/lancedb-search.js'
import { computeUnifiedScore } from '../src/lib/ranked-search.js'
import { getDefaultSettings } from '../src/lib/settings.js'
import {
  loadCurrentnessNoChangeVerdict,
  saveCurrentnessNoChangeVerdict
} from '../src/lib/maintenance/currentness-verdicts.js'
import {
  enqueuePendingPayload,
  consumePendingPayload
} from '../src/hooks/post-session-worker.js'
import {
  appendSessionTracking,
  loadSessionTracking,
  markInjectedForSuppression,
  markSessionMemoriesRated,
  removeSessionTracking,
  resetSessionInjectionLedger
} from '../src/lib/session-tracking.js'
import { findTranscriptForSession, sweepIdleSessions } from '../src/lib/idle-session-sweep.js'
import { createConfig, type DiscoveryRecord, type WarningRecord } from '../src/lib/types.js'

describe('Phase 1 architectural improvements', () => {
  const originalCacheEnv = process.env.CC_PROMPT_CACHE_TTL

  afterEach(() => {
    if (originalCacheEnv === undefined) delete process.env.CC_PROMPT_CACHE_TTL
    else process.env.CC_PROMPT_CACHE_TTL = originalCacheEnv
  })

  it('removes stale-unused-deprecation, relation-discovery, and global-promotion from AUTO_MAINTENANCE_OPERATIONS', () => {
    expect(AUTO_MAINTENANCE_OPERATIONS).not.toContain('stale-unused-deprecation')
    expect(AUTO_MAINTENANCE_OPERATIONS).not.toContain('relation-discovery')
    expect(AUTO_MAINTENANCE_OPERATIONS).not.toContain('global-promotion')
    expect(AUTO_MAINTENANCE_OPERATIONS).toContain('consolidation')
    expect(AUTO_MAINTENANCE_OPERATIONS).toContain('currentness-check')
    expect(AUTO_MAINTENANCE_OPERATIONS).toContain('stale-check')
  })

  it('uses Phase 1 defaults for hard compaction ledger, fallback floor, smoothed nudge, and Sonnet maintenance model', () => {
    const defaults = getDefaultSettings()
    expect(defaults.suppressionMode).toBe('hard')
    expect(defaults.topicChangeThreshold).toBe(0)
    expect(defaults.recentlyInjectedWindow).toBe(200)
    expect(defaults.fallbackKeywordSemanticFloor).toBe(true)
    expect(defaults.usageRatioWeight).toBeLessThanOrEqual(0.1)
    expect(defaults.maintenanceModel).toBe('claude-sonnet-5-5')
    expect(defaults.currentnessNoChangeBackoffDays).toBe(90)
    expect(defaults.idleSessionSweepHours).toBe(6)
  })

  it('fixes ERROR_LINE_REGEX prose false positives while keeping genuine error signatures', () => {
    // False positives observed in real live sessions
    expect(extractSignals('check if anyone claimed the terrorist attack diverted attention', '/tmp').errors).toEqual([])
    expect(extractSignals('Live state looks healthy: 5 running sessions with no errors in varde.service', '/tmp').errors).toEqual([])
    expect(extractSignals('Can you review the error handling in this module?', '/tmp').errors).toEqual([])
    expect(extractSignals('The file was not found in the documentation', '/tmp').errors).toEqual([])

    // Genuine error signals still captured
    expect(extractSignals("TypeError: Cannot read properties of null (reading 'x')", '/tmp').errors.length).toBeGreaterThan(0)
    expect(extractSignals('14:25:43.893 Uncaught (in promise) Error: https://svelte.dev/e/effect_update_depth_exceeded', '/tmp').errors.length).toBeGreaterThan(0)
    expect(extractSignals('"state": "provider_error",', '/tmp').errors.length).toBeGreaterThan(0)
    expect(extractSignals('API error · Retrying in 0s · attempt 1/10', '/tmp').errors.length).toBeGreaterThan(0)
    expect(extractSignals('Error: ENOENT: no such file or directory', '/tmp').errors.length).toBeGreaterThan(0)
  })

  it('computes Empirical-Bayes smoothed utility and decouples relevance gating from usage/project nudges', () => {
    const base = { id: 'r', type: 'discovery' as const, what: 'x', where: 'y', evidence: 'z', confidence: 'verified' as const }
    const unseen = computeSmoothedUsageRatio({ ...base, retrievalCount: 0, usageCount: 0 })
    const lucky = computeSmoothedUsageRatio({ ...base, retrievalCount: 1, usageCount: 1 })
    const proven = computeSmoothedUsageRatio({ ...base, retrievalCount: 10, usageCount: 8 })
    const useless = computeSmoothedUsageRatio({ ...base, retrievalCount: 10, usageCount: 0 })

    expect(unseen).toBeCloseTo(0.1, 4)
    expect(lucky).toBeCloseTo(0.25, 4) // No longer rockets to 1.0!
    expect(proven).toBeGreaterThan(lucky)
    expect(useless).toBeLessThan(unseen)

    const lowSimScore = computeUnifiedScore({
      similarity: 0.4,
      keywordMatch: false,
      usageRatio: 1.0,
      projectMatch: true,
      settings: {
        keywordBonus: 0.08,
        minSemanticSimilarity: 0.65,
        usageRatioWeight: 0.2,
        projectMatchBonus: 0.05
      }
    })
    // Relevance stays 0.28 (< 0.45 minScore) even though total with boosts would be 0.53
    expect(lowSimScore.relevance).toBeCloseTo(0.28, 4)
    expect(lowSimScore.total).toBeGreaterThan(0.45)
  })

  it('skips trivial prompts deterministically while preserving short technical requests', () => {
    expect(isTrivialPrompt('yes')).toBe(true)
    expect(isTrivialPrompt('Ok go ahead')).toBe(true)
    expect(isTrivialPrompt('Yeah, do it')).toBe(true)
    expect(isTrivialPrompt('Sounds good, I agree with you, go ahead')).toBe(true)
    expect(isTrivialPrompt('Go ahead with 2 and 3')).toBe(true)
    expect(isTrivialPrompt('[Image #2]')).toBe(true)
    expect(isTrivialPrompt('/login')).toBe(true)

    expect(isTrivialPrompt('Yes, deploy')).toBe(false)
    expect(isTrivialPrompt('Merge')).toBe(false)
    expect(isTrivialPrompt('launch it')).toBe(false)
    expect(isTrivialPrompt('How does buildContext work?')).toBe(false)
    expect(isTrivialPrompt('Fix `src/lib/retrieval.ts`')).toBe(false)
    expect(isTrivialPrompt('Run pnpm test --watch')).toBe(false)
  })

  it('includes compact [project/scope | age] provenance on global records and warnings', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-10T12:00:00Z'))
    const now = Date.now()
    const globalWarning: WarningRecord = {
      id: '12345678-warning',
      type: 'warning',
      scope: 'global',
      timestamp: now - 5 * 24 * 60 * 60_000,
      avoid: 'running rm -rf /',
      useInstead: 'targeted paths',
      reason: 'destructive',
      severity: 'critical'
    }
    const projDiscovery: DiscoveryRecord = {
      id: '87654321-discovery',
      type: 'discovery',
      scope: 'project',
      project: '/mnt/Programming/claude-memory',
      timestamp: now - 3 * 60 * 60_000,
      what: 'Uses LanceDB',
      where: 'src/lib/lancedb.ts',
      evidence: 'package.json',
      confidence: 'verified'
    }

    const { context } = buildContext([globalWarning, projDiscovery], createConfig())
    expect(context).toContain("- 🚨 [global | 5d ago] Don't: running rm -rf /")
    expect(context).toContain('- [claude-memory | 3h ago] discovery: Uses LanceDB')
    vi.useRealTimers()
  })

  it('caches currentness no-change verdicts by cluster membership and durable content hash', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-curr-cache-'))
    try {
      const r1: DiscoveryRecord = {
        id: 'd1', type: 'discovery', project: '/p', scope: 'project', timestamp: 1000,
        what: 'Uses Node 22', where: 'Dockerfile', evidence: 'FROM node:22', confidence: 'verified'
      }
      const r2: DiscoveryRecord = {
        id: 'd2', type: 'discovery', project: '/p', scope: 'project', timestamp: 2000,
        what: 'Uses pnpm 10', where: 'package.json', evidence: 'packageManager', confidence: 'verified'
      }
      expect(loadCurrentnessNoChangeVerdict([r1, r2], { baseDir: tmpDir, backoffDays: 90 })).toBeNull()
      saveCurrentnessNoChangeVerdict([r1, r2], 'claude-sonnet-5-5', { baseDir: tmpDir, now: 5000 })
      const hit = loadCurrentnessNoChangeVerdict([r2, r1], { baseDir: tmpDir, backoffDays: 90, now: 6000 })
      expect(hit?.model).toBe('claude-sonnet-5-5')

      // Content edit invalidates cache immediately
      const edited = { ...r2, what: 'Uses pnpm 11' }
      expect(loadCurrentnessNoChangeVerdict([r1, edited], { baseDir: tmpDir, backoffDays: 90, now: 6000 })).toBeNull()
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('resets compaction-scoped session ledger on PreCompact while keeping memories and rated IDs', () => {
    const sid = `phase1-ledger-${Date.now()}`
    const col = 'phase1_test_col'
    try {
      appendSessionTracking(sid, [{ id: 'm1', snippet: 'fact 1', injectedAt: 100 }], '/p', 'prompt 1', 'injected', col)
      markInjectedForSuppression(sid, ['m1'], 200, col)
      expect(loadSessionTracking(sid, col)?.recentlyInjectedIds).toEqual(['m1'])

      markSessionMemoriesRated(sid, ['m1'], col, { countedMemoryCount: 1 })
      resetSessionInjectionLedger(sid, col)

      const after = loadSessionTracking(sid, col)
      expect(after?.recentlyInjectedIds).toEqual([])
      expect(after?.memories).toHaveLength(1)
      expect(after?.ratedMemoryIds).toEqual(['m1'])
      expect(after?.countedMemoryCount).toBe(1)

      // Post-compaction prompt advances retrievalStateVersion and adds m2 to the new epoch ledger.
      markInjectedForSuppression(sid, ['m2'], 200, col)
      const postCompactVersion = loadSessionTracking(sid, col)!.retrievalStateVersion!
      // A stale PreCompact worker finishing late with the old expectedVersion must NOT wipe m2.
      resetSessionInjectionLedger(sid, col, { expectedVersion: postCompactVersion - 1 })
      expect(loadSessionTracking(sid, col)?.recentlyInjectedIds).toEqual(['m2'])
    } finally {
      removeSessionTracking(sid, col)
    }
  })

  it('bounds PreCompact usefulness rating to pre-compaction snapshot and allows re-rating re-injected memories', async () => {
    const { processUsefulnessRating } = await import('../src/hooks/post-session-worker.js')
    const sid = `phase1-precompact-race-${Date.now()}`
    const col = 'phase1_race_col'
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-race-'))
    const config = createConfig({ lancedb: { directory: path.join(tmpDir, 'lancedb'), table: col } })
    try {
      // Epoch 1: m1 injected before PreCompact
      appendSessionTracking(sid, [{ id: 'm1', snippet: 'epoch 1 fact', injectedAt: 100 }], '/p', 'turn 1', 'injected', col)
      const beforeSnapshot = loadSessionTracking(sid, col)!
      const snapshotCount = beforeSnapshot.memories.length
      const snapshotVersion = beforeSnapshot.retrievalStateVersion ?? 0

      // Simulate launcher resetting ledger, then post-compaction prompt injecting m2 while worker is in-flight
      resetSessionInjectionLedger(sid, col)
      appendSessionTracking(sid, [{ id: 'm2', snippet: 'epoch 2 fact', injectedAt: 200 }], '/p', 'turn 2', 'injected', col)
      markInjectedForSuppression(sid, ['m2'], 200, col)

      // PreCompact worker finishes with merged usefulness result for epoch 1 (snapshotCount = 1)
      await processUsefulnessRating(
        {
          hook_event_name: 'PreCompact',
          trigger: 'auto',
          session_id: sid,
          transcript_path: '',
          cwd: '/p',
          permission_mode: 'default'
        },
        config,
        undefined,
        'run-1',
        {
          usefulnessRatedDuringExtraction: true,
          preRatedHelpfulIds: [],
          snapshotMemoryCount: snapshotCount,
          snapshotRetrievalStateVersion: snapshotVersion
        }
      )

      const after = loadSessionTracking(sid, col)!
      // m2 in the active post-compaction ledger MUST remain intact and unrated!
      expect(after.recentlyInjectedIds).toEqual(['m2'])
      expect(after.ratedMemoryCount).toBe(1)
      expect(after.ratedMemoryIds).toEqual(['m1'])
    } finally {
      removeSessionTracking(sid, col)
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('preserves SessionEnd over PreCompact in the pending lock handoff queue', () => {
    const sid = `phase1-handoff-${Date.now()}`
    const preCompact = {
      hook_event_name: 'PreCompact' as const,
      trigger: 'auto' as const,
      session_id: sid,
      transcript_path: '/tmp/t.jsonl',
      cwd: '/tmp',
      permission_mode: 'default'
    }
    const sessionEnd = {
      hook_event_name: 'SessionEnd' as const,
      reason: 'prompt_input_exit' as const,
      session_id: sid,
      transcript_path: '/tmp/t.jsonl',
      cwd: '/tmp',
      permission_mode: 'default'
    }

    expect(enqueuePendingPayload(sid, sessionEnd)).toBe(true)
    // A subsequent PreCompact must not overwrite a queued SessionEnd
    expect(enqueuePendingPayload(sid, preCompact)).toBe(true)
    const consumed = consumePendingPayload(sid)
    expect(consumed?.hook_event_name).toBe('SessionEnd')
    expect(consumePendingPayload(sid)).toBeNull()
  })

  it('builds 1h and 5m cache control blocks cleanly', () => {
    delete process.env.CC_PROMPT_CACHE_TTL
    expect(buildCacheControl('1h')).toEqual({ type: 'ephemeral', ttl: '1h' })
    expect(buildCacheControl('5m')).toEqual({ type: 'ephemeral' })
    process.env.CC_PROMPT_CACHE_TTL = '5m'
    expect(buildCacheControl('1h')).toEqual({ type: 'ephemeral' })
  })

  it('sweeps abandoned idle sessions while skipping recently active ones', async () => {
    const tmpProjects = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-idle-sweep-'))
    const col = `sweep_test_${Date.now()}`
    const idleSid = `idle-${Date.now()}`
    const activeSid = `active-${Date.now()}`
    try {
      const projDir = path.join(tmpProjects, '-tmp-proj')
      fs.mkdirSync(projDir, { recursive: true })
      const idleTranscript = path.join(projDir, `${idleSid}.jsonl`)
      const activeTranscript = path.join(projDir, `${activeSid}.jsonl`)
      fs.writeFileSync(idleTranscript, '{"type":"user","message":{"role":"user","content":"hello"}}\n')
      fs.writeFileSync(activeTranscript, '{"type":"user","message":{"role":"user","content":"active"}}\n')
      const oldTime = new Date(Date.now() - 10 * 60 * 60 * 1000)
      fs.utimesSync(idleTranscript, oldTime, oldTime)

      appendSessionTracking(idleSid, [{ id: 'm1', snippet: 'old', injectedAt: oldTime.getTime() }], '/tmp/proj', 'p', 'injected', col)
      // Backdate idle session lastActivity
      const idleRec = loadSessionTracking(idleSid, col)!
      const { saveSessionTracking } = await import('../src/lib/session-tracking.js')
      saveSessionTracking({ ...idleRec, lastActivity: oldTime.getTime() }, col)
      appendSessionTracking(activeSid, [{ id: 'm2', snippet: 'new', injectedAt: Date.now() }], '/tmp/proj', 'p', 'injected', col)

      expect(findTranscriptForSession(idleSid, tmpProjects)).toBe(idleTranscript)

      const recoveredIds: string[] = []
      const res = await sweepIdleSessions(createConfig({ lancedb: { directory: tmpProjects, table: col } }), {
        idleHours: 6,
        claudeProjectsDir: tmpProjects,
        onRecoverSession: async (payload) => {
          recoveredIds.push(payload.session_id)
        }
      })

      expect(recoveredIds).toEqual([idleSid])
      expect(res.recovered).toBe(1)
      expect(res.skippedActive).toBe(1)
    } finally {
      removeSessionTracking(idleSid, col)
      removeSessionTracking(activeSid, col)
      fs.rmSync(tmpProjects, { recursive: true, force: true })
    }
  })
})
