#!/usr/bin/env npx tsx
/**
 * Primary judge for the entity A/B eval: per prompt, blind-rate the UNION of
 * memories injected by any arm against the prompt + cwd. Arm-identifying
 * signals (scores, similarity, keyword flags) are stripped and order is
 * shuffled deterministically, so the judge cannot favor an arm.
 *
 * Verdicts cache to ~/.claude-memory/eval/judgments-<runId>.jsonl keyed by
 * (promptKey, memoryId); a prompt whose union grew is re-judged in full so
 * its verdicts stay mutually consistent (newest rows win on read).
 *
 * Usage:
 *   npx tsx scripts/eval-judge.ts                       # judge all replayed prompts
 *   npx tsx scripts/eval-judge.ts --limit 5             # smoke
 *   npx tsx scripts/eval-judge.ts --dry-run             # print payloads, no LLM
 *   npx tsx scripts/eval-judge.ts --force <promptKey>   # re-judge one prompt
 *   npx tsx scripts/eval-judge.ts --run-id my-run --model claude-sonnet-4-6
 */

import { createHash } from 'node:crypto'
import { extractSignals, findGitRoot, formatRecordSnippet } from '../src/lib/context.js'
import { fetchRecordsByIds, initLanceDB } from '../src/lib/lancedb.js'
import { reviewInjectionInput, type InjectionReviewInput } from '../src/lib/injection-review.js'
import { loadSettings } from '../src/lib/settings.js'
import { buildRecordSnippet, truncateSnippet } from '../src/lib/shared.js'
import type { InjectedMemoryEntry, MemoryRecord } from '../src/lib/types.js'
import {
  appendJsonLines,
  argNumber,
  argValue,
  buildEvalConfig,
  evalDataPath,
  hasFlag,
  loadProdConfig,
  readJsonLines
} from './eval-shared.js'

type ReplayLine = {
  promptKey: string
  sessionId: string
  cwd: string
  text: string
  timestamp: number
  arms: Record<string, { injected: Array<{ id: string }> }>
}

type JudgmentRow = {
  promptKey: string
  memoryId: string
  verdict: 'relevant' | 'partially_relevant' | 'irrelevant' | 'unknown'
  reason: string
  model: string
  judgedAt: number
}

/** Deterministic per-prompt shuffle so payload order can't encode arm identity. */
function shuffleDeterministic<T extends { id: string }>(items: T[], seed: string): T[] {
  return [...items].sort((a, b) => {
    const ha = createHash('sha256').update(`${seed}:${a.id}`).digest('hex')
    const hb = createHash('sha256').update(`${seed}:${b.id}`).digest('hex')
    return ha.localeCompare(hb)
  })
}

function buildBlindPayload(records: MemoryRecord[], seed: string): Array<Record<string, unknown>> {
  const entries = records.map(record => ({
    id: record.id,
    // Full injected representation, same as what a session would have seen;
    // deliberately NO similarity/score/keywordMatch — those identify arms.
    snippet: formatRecordSnippet(record) ?? truncateSnippet(buildRecordSnippet(record), 160),
    type: record.type,
    scope: record.scope,
    recordSummary: truncateSnippet(buildRecordSnippet(record), 160)
  }))
  return shuffleDeterministic(entries, seed)
}

async function judge() {
  const runId = argValue('--run-id') ?? 'main'
  const limit = argNumber('--limit') ?? Number.POSITIVE_INFINITY
  const dryRun = hasFlag('--dry-run')
  const forceKey = argValue('--force')
  const prodConfig = loadProdConfig()
  const evalConfig = buildEvalConfig(prodConfig)
  // Prompt-relevance judging is high-volume and does not need the review
  // model tier; default to the extraction model.
  const model = argValue('--model') ?? loadSettings().extractionModel

  const replayLines = readJsonLines<ReplayLine>(evalDataPath(`replay-${runId}.jsonl`))
  const latestByKey = new Map(replayLines.map(line => [line.promptKey, line]))
  if (latestByKey.size === 0) {
    throw new Error(`No replay data for run '${runId}'; run eval-retrieval first.`)
  }

  const judgmentsPath = evalDataPath(`judgments-${runId}.jsonl`)
  const cached = new Map<string, JudgmentRow>()
  for (const row of readJsonLines<JudgmentRow>(judgmentsPath)) {
    cached.set(`${row.promptKey}:${row.memoryId}`, row)
  }

  console.log(`[eval-judge] Run: ${runId} | prompts: ${latestByKey.size} | model: ${model} | cached rows: ${cached.size}`)
  if (dryRun) console.log('[eval-judge] DRY RUN - no LLM calls')

  await initLanceDB(evalConfig)

  let judged = 0
  let skipped = 0
  let failed = 0
  for (const line of latestByKey.values()) {
    if (judged >= limit) break
    if (forceKey && line.promptKey !== forceKey) continue

    const unionIds = Array.from(new Set(
      Object.values(line.arms).flatMap(arm => arm.injected.map(entry => entry.id))
    ))
    if (unionIds.length === 0) {
      skipped += 1
      continue
    }

    const uncached = forceKey
      ? unionIds
      : unionIds.filter(id => !cached.has(`${line.promptKey}:${id}`))
    if (uncached.length === 0) {
      skipped += 1
      continue
    }

    const records = await fetchRecordsByIds(unionIds, evalConfig)
    const payload = buildBlindPayload(records, line.promptKey)

    if (dryRun) {
      console.log(`\n[eval-judge] ${line.promptKey}: "${line.text.slice(0, 80)}" -> ${payload.length} memories`)
      for (const entry of payload) console.log(`  - [${entry.type}] ${entry.snippet}`)
      judged += 1
      continue
    }

    const projectRoot = findGitRoot(line.cwd) ?? undefined
    const input: InjectionReviewInput = {
      sessionId: `eval:${line.promptKey}`,
      prompt: line.text,
      cwd: line.cwd,
      injectedAt: line.timestamp,
      signals: extractSignals(line.text, line.cwd, projectRoot),
      injectedPayload: payload,
      similarMemories: []
    }
    const entries: InjectedMemoryEntry[] = records.map(record => ({
      id: record.id,
      snippet: truncateSnippet(buildRecordSnippet(record), 160),
      type: record.type,
      injectedAt: line.timestamp
    }))

    try {
      const review = await reviewInjectionInput(input, entries, evalConfig, { model })
      const judgedAt = Date.now()
      const rows: JudgmentRow[] = review.injectedVerdicts.map(verdict => ({
        promptKey: line.promptKey,
        memoryId: verdict.id,
        verdict: verdict.verdict,
        reason: verdict.reason,
        model: review.model,
        judgedAt
      }))
      appendJsonLines(judgmentsPath, rows)
      for (const row of rows) cached.set(`${row.promptKey}:${row.memoryId}`, row)
      judged += 1
    } catch (error) {
      failed += 1
      console.error(`\n[eval-judge] Failed to judge ${line.promptKey}:`, error)
    }
    process.stdout.write(`\r[eval-judge] Judged ${judged} | cached-skip ${skipped} | failed ${failed}`)
  }

  console.log()
  console.log(`[eval-judge] Done. Judged ${judged}, skipped ${skipped}, failed ${failed} -> ${judgmentsPath}`)
}

judge().catch(error => {
  console.error('[eval-judge] Fatal error:', error)
  process.exit(1)
})
