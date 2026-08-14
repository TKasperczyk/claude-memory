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
import os from 'node:os'
import path from 'node:path'
import { countRecords, initLanceDB } from '../src/lib/lancedb.js'
import { retrieveContext } from '../src/lib/retrieval.js'
import { loadSettings, type RetrievalSettings } from '../src/lib/settings.js'
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
const REPLAY_TIMEOUT_MS = 120_000
/** Workable expansion floor for the treatment arms (live floor filters everything). */
const TREATMENT_MIN_EXPANDED_SCORE = 0.25

type CorpusPrompt = {
  promptKey: string
  sessionId: string
  cwd: string
  text: string
  timestamp: number
  originalInjectedCount: number
}

type ArmCapture = {
  injected: Array<{
    id: string
    score?: number
    similarity?: number
    keywordMatch?: boolean
    via?: { parentId: string; kind: RelationKind; hop: number }
  }>
  durationMs: number
}

type ReplayLine = {
  promptKey: string
  sessionId: string
  cwd: string
  text: string
  timestamp: number
  originalInjectedCount: number
  arms: Record<string, ArmCapture>
}

function buildArms(): Record<string, RetrievalSettings> {
  // Frozen snapshot of the LIVE settings, captured once per run: the eval
  // question is "does the mechanism improve Tom's tuned system", not the
  // defaults. Pins neutralize session state and nondeterminism.
  const base: RetrievalSettings = {
    ...loadSettings(),
    enableTopicSuppression: false,
    enableHaikuRetrieval: false,
    prePromptTimeoutMs: REPLAY_TIMEOUT_MS,
    enableEntityEdges: false,
    enableEntityKeywords: false
  }
  const floored = { ...base, minExpandedScore: TREATMENT_MIN_EXPANDED_SCORE }
  return {
    A: base,
    AF: floored,
    B1: { ...floored, enableEntityEdges: true },
    B2: { ...floored, enableEntityEdges: true, enableEntityKeywords: true }
  }
}

function buildCorpus(prodTable: string): CorpusPrompt[] {
  const sessionsDir = path.join(os.homedir(), '.claude-memory', 'sessions', prodTable)
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
      if (!text || prompt.status !== 'injected') continue
      if (text.length < MIN_PROMPT_LENGTH || BARE_SLASH_COMMAND.test(text)) continue
      const timestamp = prompt.timestamp ?? 0
      corpus.push({
        promptKey: createHash('sha256').update(`${sessionId}:${timestamp}:${text}`).digest('hex').slice(0, 16),
        sessionId,
        cwd,
        text,
        timestamp,
        originalInjectedCount: prompt.memoryCount ?? 0
      })
    }
  }
  return corpus.sort((a, b) => a.timestamp - b.timestamp)
}

async function replay() {
  const runId = argValue('--run-id') ?? 'main'
  const limit = argNumber('--limit') ?? Number.POSITIVE_INFINITY
  const onlyPromptKey = argValue('--prompt')
  const arms = buildArms()
  const armNames = (argValue('--arms')?.split(',') ?? Object.keys(arms)).map(name => name.trim())
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

  const corpus = buildCorpus(prodConfig.lancedb.table)
  const linesPath = evalDataPath(`replay-${runId}.jsonl`)
  const metaPath = evalDataPath(`replay-${runId}.meta.json`)
  const done = new Map(readJsonLines<ReplayLine>(linesPath).map(line => [line.promptKey, line]))

  fs.writeFileSync(metaPath, JSON.stringify({
    runId,
    createdAt: new Date().toISOString(),
    evalTable: evalConfig.lancedb.table,
    tableCount,
    corpusSize: corpus.length,
    armSettings: arms
  }, null, 2))

  console.log(`[eval-replay] Table: ${evalConfig.lancedb.table} (${tableCount} records)`)
  console.log(`[eval-replay] Corpus: ${corpus.length} prompts | arms: ${armNames.join(', ')} | already done: ${done.size}`)

  let processed = 0
  let replayed = 0
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
      originalInjectedCount: prompt.originalInjectedCount,
      arms: {}
    }

    for (const armName of armNames) {
      if (line.arms[armName]) continue
      const started = Date.now()
      const result = await retrieveContext(
        // No sessionId: keeps the topic-suppression path fully out of replay.
        { prompt: prompt.text, cwd: prompt.cwd, skipSuppressionWriteback: true },
        evalConfig,
        { settingsOverride: arms[armName], diagnostic: true }
      )
      if (result.timedOut) {
        // A timeout tears down the global LanceDB client cache and would
        // silently poison every subsequent capture — fail loudly instead.
        throw new Error(`Arm ${armName} timed out on prompt ${prompt.promptKey}; rerun to resume.`)
      }
      const resultsById = new Map(result.results.map(entry => [entry.record.id, entry]))
      line.arms[armName] = {
        injected: result.injectedRecords.map(record => {
          const scored = resultsById.get(record.id)
          return {
            id: record.id,
            score: scored?.score,
            similarity: scored?.similarity,
            keywordMatch: scored?.keywordMatch,
            ...(scored?.via ? { via: scored.via } : {})
          }
        }),
        durationMs: Date.now() - started
      }
    }

    // Rewrite-free resume: completed prompts append once, in full.
    appendJsonLines(linesPath, [line])
    done.set(prompt.promptKey, line)
    replayed += 1
    process.stdout.write(`\r[eval-replay] Replayed ${replayed} (scanned ${processed}/${corpus.length})`)
  }

  console.log()
  console.log(`[eval-replay] Done. ${replayed} prompts replayed this run, ${done.size} total in ${linesPath}`)
}

replay().catch(error => {
  console.error('[eval-replay] Fatal error:', error)
  process.exit(1)
})
