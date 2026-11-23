#!/usr/bin/env npx tsx
/**
 * Replay historical prompts through retrieveContext under the eval arms and
 * capture what each arm would inject. Read-only against the eval table.
 *
 * Corpus: session tracking files (~/.claude-memory/sessions/<prod-table>/),
 * prompts with status 'injected', minus bare slash commands and sub-15-char
 * noise.
 *
 * Arms (see plan): A = frozen live settings; AF = A + minExpandedScore 0.25
 * (isolates the expansion-floor effect - at the live floor of 0.45 relation
 * expansion never survives for any edge kind); B1 = AF + entity edges;
 * B2 = B1 + entity keyword needles.
 *
 * Output: ~/.claude-memory/eval/replay-<runId>.jsonl (one line per prompt,
 * resumable) + replay-<runId>.meta.json (frozen arm settings for
 * reproducibility).
 *
 * Usage:
 *   npx tsx scripts/eval-retrieval.ts                     # full run, all arms
 *   npx tsx scripts/eval-retrieval.ts --limit 5           # smoke
 *   npx tsx scripts/eval-retrieval.ts --arms A,B1         # subset of arms
 *   npx tsx scripts/eval-retrieval.ts --prompt <key>      # single prompt
 *   npx tsx scripts/eval-retrieval.ts --run-id my-run     # named run (default: 'main')
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { isTrivialPrompt } from '../src/hooks/pre-prompt.js'
import { countRecords, initLanceDB } from '../src/lib/lancedb.js'
import { CLAUDE_MEMORY_ROOT } from '../src/lib/paths.js'
import { retrieveContext } from '../src/lib/retrieval.js'
import { loadSettings, type RetrievalSettings } from '../src/lib/settings.js'
import { markInjectedForSuppression, removeSessionTracking } from '../src/lib/session-tracking.js'
import type { RelationKind } from '../src/lib/types.js'
import {
  appendJsonLines,
  argNumber,
  argValue,
  buildEvalConfig,
  evalDataPath,
  loadProdConfig,
  readJsonLines
} from './eval-shared.js'

const MIN_PROMPT_LENGTH = 15
const BARE_SLASH_COMMAND = /^\/\S+$/
const TASK_NOTIFICATION_PREFIX = '<task-notification>'
const REPLAY_TIMEOUT_MS = 120_000
/** Workable expansion floor for the treatment arms (live floor filters everything). */
const TREATMENT_MIN_EXPANDED_SCORE = 0.25

type CorpusPrompt = {
  promptKey: string
  sessionId: string
  cwd: string
  text: string
  timestamp: number
  originalStatus: string
  originalInjectedCount: number
}

type ArmCapture = {
  injected: Array<{
    id: string
    score?: number
    similarity?: number
    bm25Score?: number
    keywordMatch?: boolean
    via?: { parentId: string; kind: RelationKind; hop: number }
  }>
  stage1Pool?: Array<{
    id: string
    similarity?: number
    bm25Score?: number
    keywordMatch?: boolean
  }>
  rerankerCalled?: boolean
  rerankerAbstained?: boolean
  abstainReason?: string
  durationMs: number
}

type ReplayLine = {
  promptKey: string
  sessionId: string
  cwd: string
  text: string
  timestamp: number
  originalStatus?: string
  originalInjectedCount: number
  causalEnforced: boolean
  arms: Record<string, ArmCapture>
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name)
}

function buildArms(): Record<string, RetrievalSettings> {
  // Frozen snapshot of live settings, captured once per run.
  const base: RetrievalSettings = {
    ...loadSettings(),
    enableTopicSuppression: false,
    enableHaikuRetrieval: false,
    enablePostRetrievalRerank: false,
    fallbackKeywordSemanticFloor: false,
    prePromptTimeoutMs: REPLAY_TIMEOUT_MS,
    enableEntityEdges: false,
    enableEntityKeywords: false
  }
  const floored = { ...base, minExpandedScore: TREATMENT_MIN_EXPANDED_SCORE }
  const hardLedger = {
    ...base,
    enableTopicSuppression: true,
    suppressionMode: 'hard' as const,
    topicChangeThreshold: 0,
    recentlyInjectedWindow: 200,
    fallbackKeywordSemanticFloor: true
  }
  return {
    A: base,
    AF: floored,
    B1: { ...floored, enableEntityEdges: true },
    B2: { ...floored, enableEntityEdges: true, enableEntityKeywords: true },
    // Phase 1 precision + hard ledger arm
    P1: hardLedger,
    // Legacy pre-retrieval Haiku arm (with Phase 1 precision & ledger)
    H1: { ...hardLedger, enableHaikuRetrieval: true, enablePostRetrievalRerank: false },
    // Phase 2 flipped Stage-1 BM25+embed -> Stage-2 Haiku reranker & abstention gate
    R2: {
      ...hardLedger,
      enableHaikuRetrieval: false,
      enablePostRetrievalRerank: true,
      stage1MinSimilarity: 0.45,
      rerankCandidateLimit: 18,
      rerankMaxRecords: 3,
      rerankTimeoutMs: 15_000
    }
  }
}

function buildCorpus(prodTable: string, options: { injectedOnly?: boolean } = {}): CorpusPrompt[] {
  const sessionsDir = path.join(CLAUDE_MEMORY_ROOT, 'sessions', prodTable)
  if (!fs.existsSync(sessionsDir)) {
    throw new Error(`Session tracking directory missing: ${sessionsDir}`)
  }

  const corpus: CorpusPrompt[] = []
  for (const fileName of fs.readdirSync(sessionsDir).sort()) {
    if (!fileName.endsWith('.json')) continue
    let session: {
      sessionId?: string
      cwd?: string
      prompts?: Array<{ text?: string; timestamp?: number; status?: string; memoryCount?: number }>
    }
    try {
      session = JSON.parse(fs.readFileSync(path.join(sessionsDir, fileName), 'utf-8'))
    } catch {
      continue
    }
    const sessionId = session.sessionId
    const cwd = session.cwd
    if (!sessionId || !cwd) continue

    for (const prompt of session.prompts ?? []) {
      const text = prompt.text?.trim()
      if (!text) continue
      const status = prompt.status ?? 'unknown'
      if (options.injectedOnly && status !== 'injected') continue
      if (status !== 'injected' && status !== 'no_matches') continue
      // Strip machine-generated task notifications, trivial fillers, and bare slash commands.
      if (text.startsWith(TASK_NOTIFICATION_PREFIX)) continue
      if (text.length < MIN_PROMPT_LENGTH || BARE_SLASH_COMMAND.test(text)) continue
      if (isTrivialPrompt(text)) continue
      const timestamp = prompt.timestamp ?? 0
      corpus.push({
        promptKey: createHash('sha256').update(`${sessionId}:${timestamp}:${text}`).digest('hex').slice(0, 16),
        sessionId,
        cwd,
        text,
        timestamp,
        originalStatus: status,
        originalInjectedCount: prompt.memoryCount ?? 0
      })
    }
  }
  // Group chronologically within each session (ordered by earliest prompt per session)
  // so multi-turn session suppression replays in real turn order.
  const sessionStart = new Map<string, number>()
  for (const item of corpus) {
    const prev = sessionStart.get(item.sessionId)
    if (prev === undefined || item.timestamp < prev) {
      sessionStart.set(item.sessionId, item.timestamp)
    }
  }
  return corpus.sort((a, b) => {
    const startDiff = (sessionStart.get(a.sessionId) ?? 0) - (sessionStart.get(b.sessionId) ?? 0)
    if (startDiff !== 0) return startDiff
    if (a.sessionId !== b.sessionId) return a.sessionId.localeCompare(b.sessionId)
    return a.timestamp - b.timestamp
  })
}

async function replay() {
  const runId = argValue('--run-id') ?? 'main'
  const limit = argNumber('--limit') ?? Number.POSITIVE_INFINITY
  const onlyPromptKey = argValue('--prompt')
  const stateless = hasFlag('--stateless')
  const injectedOnly = hasFlag('--injected-only')
  const disableCausal = hasFlag('--no-causal')
  const arms = buildArms()
  const armNames = (argValue('--arms')?.split(',') ?? ['A', 'P1', 'H1', 'R2']).map(name => name.trim())
  for (const name of armNames) {
    if (!arms[name]) throw new Error(`Unknown arm '${name}'. Available: ${Object.keys(arms).join(', ')}`)
  }

  const prodConfig = loadProdConfig()
  const evalConfig = buildEvalConfig(prodConfig)

  await initLanceDB(evalConfig)
  const tableCount = await countRecords({}, evalConfig)
  if (tableCount === 0) {
    throw new Error(`Eval table '${evalConfig.lancedb.table}' is empty; run eval-clone-table first.`)
  }

  const corpus = buildCorpus(prodConfig.lancedb.table, { injectedOnly })
  const linesPath = evalDataPath(`replay-${runId}.jsonl`)
  const metaPath = evalDataPath(`replay-${runId}.meta.json`)
  const done = new Map(readJsonLines<ReplayLine>(linesPath).map(line => [line.promptKey, line]))

  fs.writeFileSync(metaPath, JSON.stringify({
    runId,
    createdAt: new Date().toISOString(),
    evalTable: evalConfig.lancedb.table,
    tableCount,
    corpusSize: corpus.length,
    causalEnforced: !disableCausal,
    chronologicalSessionReplay: !stateless,
    injectedOnly,
    armSettings: arms
  }, null, 2))

  console.log(`[eval-replay] Table: ${evalConfig.lancedb.table} (${tableCount} records)`)
  console.log(`[eval-replay] Corpus: ${corpus.length} prompts | causal=${!disableCausal} | chronological=${!stateless} | arms: ${armNames.join(', ')} | already done: ${done.size}`)

  const initializedSessions = new Set<string>()
  let processed = 0
  let replayed = 0
  try {
    // Seed session ledgers from already-completed turns when resuming a run so
    // chronological multi-turn suppression stays identical across restarts.
    if (!stateless && done.size > 0) {
      for (const prompt of corpus) {
        const existing = done.get(prompt.promptKey)
        if (!existing) continue
        for (const armName of armNames) {
          const capture = existing.arms[armName]
          const armSettings = arms[armName]
          if (!capture || !armSettings.enableTopicSuppression) continue
          const evalSessionId = `eval-${runId}-${armName}-${prompt.sessionId}`
          if (!initializedSessions.has(evalSessionId)) {
            removeSessionTracking(evalSessionId, evalConfig.lancedb.table)
            initializedSessions.add(evalSessionId)
          }
          if (capture.injected.length > 0) {
            markInjectedForSuppression(
              evalSessionId,
              capture.injected.map(item => item.id),
              armSettings.recentlyInjectedWindow,
              evalConfig.lancedb.table
            )
          }
        }
      }
    }

    for (const prompt of corpus) {
      if (replayed >= limit) break
      if (onlyPromptKey && prompt.promptKey !== onlyPromptKey) continue
      processed += 1
      const existing = done.get(prompt.promptKey)
      if (existing && armNames.every(name => existing.arms[name])) continue

      const line: ReplayLine = existing ?? {
        promptKey: prompt.promptKey,
        sessionId: prompt.sessionId,
        cwd: prompt.cwd,
        text: prompt.text,
        timestamp: prompt.timestamp,
        originalStatus: prompt.originalStatus,
        originalInjectedCount: prompt.originalInjectedCount,
        causalEnforced: !disableCausal,
        arms: {}
      }

      for (const armName of armNames) {
        if (line.arms[armName]) continue
        const armSettings = arms[armName]
        const useSessionLedger = !stateless && armSettings.enableTopicSuppression
        const evalSessionId = useSessionLedger ? `eval-${runId}-${armName}-${prompt.sessionId}` : undefined
        if (evalSessionId && !initializedSessions.has(evalSessionId)) {
          removeSessionTracking(evalSessionId, evalConfig.lancedb.table)
          initializedSessions.add(evalSessionId)
        }

        const started = Date.now()
        const result = await retrieveContext(
          {
            prompt: prompt.text,
            cwd: prompt.cwd,
            ...(evalSessionId ? { sessionId: evalSessionId } : {}),
            skipSuppressionWriteback: !useSessionLedger,
            ...(!disableCausal && prompt.timestamp > 0 ? { maxTimestamp: prompt.timestamp } : {})
          },
          evalConfig,
          { settingsOverride: armSettings, diagnostic: true }
        )
        if (result.timedOut) {
          throw new Error(`Arm ${armName} timed out on prompt ${prompt.promptKey}; rerun to resume.`)
        }
        if (useSessionLedger && evalSessionId && result.injectedRecords.length > 0) {
          markInjectedForSuppression(
            evalSessionId,
            result.injectedRecords.map(r => r.id),
            armSettings.recentlyInjectedWindow,
            evalConfig.lancedb.table
          )
        }
        const resultsById = new Map(result.results.map(entry => [entry.record.id, entry]))
        line.arms[armName] = {
          injected: result.injectedRecords.map(record => {
            const scored = resultsById.get(record.id)
            return {
              id: record.id,
              score: scored?.score,
              similarity: scored?.similarity,
              ...(scored?.bm25Score !== undefined ? { bm25Score: scored.bm25Score } : {}),
              keywordMatch: scored?.keywordMatch,
              ...(scored?.via ? { via: scored.via } : {})
            }
          }),
          ...(result.stage1Candidates ? {
            stage1Pool: result.stage1Candidates.slice(0, 25).map(entry => ({
              id: entry.record.id,
              similarity: entry.similarity,
              ...(entry.bm25Score !== undefined ? { bm25Score: entry.bm25Score } : {}),
              keywordMatch: entry.keywordMatch
            }))
          } : {}),
          ...(result.telemetry ? {
            rerankerCalled: result.telemetry.rerankerCalled,
            rerankerAbstained: result.telemetry.rerankerAbstained,
            ...(result.telemetry.abstainReason ? { abstainReason: result.telemetry.abstainReason } : {})
          } : {}),
          durationMs: Date.now() - started
        }
      }

      // Rewrite-free resume: completed prompts append once, in full.
      appendJsonLines(linesPath, [line])
      done.set(prompt.promptKey, line)
      replayed += 1
      process.stdout.write(`\r[eval-replay] Replayed ${replayed} (scanned ${processed}/${corpus.length})`)
    }
  } finally {
    for (const evalSessionId of initializedSessions) {
      removeSessionTracking(evalSessionId, evalConfig.lancedb.table)
    }
  }

  console.log()
  console.log(`[eval-replay] Done. ${replayed} prompts replayed this run, ${done.size} total in ${linesPath}`)
}

replay().catch(error => {
  console.error('[eval-replay] Fatal error:', error)
  process.exit(1)
})
