#!/usr/bin/env npx tsx
/**
 * Gold judge for the entity A/B eval: counterfactual, transcript-grounded.
 * For prompts whose original Claude Code transcript still exists, ask: given
 * what the session ACTUALLY did after this prompt, which of the candidate
 * memories (union of all arms' injections, blind-shuffled) would have been
 * useful had they been injected?
 *
 * Stronger signal than prompt-relevance (a memory can look relevant and be
 * useless for the real task), but only covers prompts with surviving
 * transcripts. Defaults to the review model.
 *
 * Verdicts cache to ~/.claude-memory/eval/judgments-gold-<runId>.jsonl.
 *
 * Usage:
 *   npx tsx scripts/eval-judge-gold.ts               # all transcript-covered prompts
 *   npx tsx scripts/eval-judge-gold.ts --limit 2     # smoke
 *   npx tsx scripts/eval-judge-gold.ts --dry-run     # show coverage + windows, no LLM
 *   npx tsx scripts/eval-judge-gold.ts --run-id my-run --model claude-sonnet-4-6
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { formatRecordSnippet } from '../src/lib/context.js'
import { formatTranscript } from '../src/lib/extract.js'
import { fetchRecordsByIds, initLanceDB } from '../src/lib/lancedb.js'
import { executeReview } from '../src/lib/review-framework.js'
import { loadSettings } from '../src/lib/settings.js'
import { buildRecordSnippet, truncateSnippet } from '../src/lib/shared.js'
import { parseTranscript, type Transcript, type TranscriptEvent } from '../src/lib/transcript.js'
import type { MemoryRecord } from '../src/lib/types.js'
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

const TRANSCRIPT_WINDOW_CHARS = 70_000
const GOLD_MAX_TOKENS = 2000

type ReplayLine = {
  promptKey: string
  sessionId: string
  cwd: string
  text: string
  timestamp: number
  arms: Record<string, { injected: Array<{ id: string }> }>
}

type GoldRow = {
  promptKey: string
  memoryId: string
  wouldHaveHelped: boolean
  model: string
  judgedAt: number
}

function findTranscriptPath(sessionId: string): string | null {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects')
  if (!fs.existsSync(projectsDir)) return null
  for (const dir of fs.readdirSync(projectsDir)) {
    const candidate = path.join(projectsDir, dir, `${sessionId}.jsonl`)
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Events from the judged prompt onward: what the session actually did with
 * (and after) this prompt. Falls back to the full transcript when the prompt
 * text can't be located (paraphrased/truncated stores).
 */
function windowFromPrompt(transcript: Transcript, promptText: string): TranscriptEvent[] {
  const needle = promptText.slice(0, 200)
  const startIndex = transcript.events.findIndex(event =>
    (event.type === 'user') && 'text' in event && typeof event.text === 'string' && event.text.startsWith(needle)
  )
  return startIndex === -1 ? transcript.events : transcript.events.slice(startIndex)
}

function shuffleDeterministic<T extends { id: string }>(items: T[], seed: string): T[] {
  return [...items].sort((a, b) => {
    const ha = createHash('sha256').update(`${seed}:${a.id}`).digest('hex')
    const hb = createHash('sha256').update(`${seed}:${b.id}`).digest('hex')
    return ha.localeCompare(hb)
  })
}

function buildGoldPrompt(input: {
  promptText: string
  transcriptText: string
  candidates: Array<{ id: string; snippet: string }>
}): string {
  const memories = input.candidates
    .map(candidate => `- [${candidate.id}] ${candidate.snippet}`)
    .join('\n')
  return `A Claude Code session received this user prompt:

"""
${input.promptText}
"""

Here is what the session actually did from that prompt onward:

"""
${input.transcriptText}
"""

Candidate memories that COULD have been injected alongside the prompt:

${memories}

Question: knowing what the session actually needed to do, which candidate memories WOULD have been genuinely useful had they been injected? Useful means the memory's content would have saved work, prevented an error, or answered something the session had to figure out. Judge each candidate on the transcript evidence alone — not on plausible-sounding relevance to the prompt wording.`
}

function coerceGoldPayload(raw: unknown): { helpfulIds: string[] } | null {
  if (!raw || typeof raw !== 'object') return null
  const ids = (raw as Record<string, unknown>).helpfulIds
  if (!Array.isArray(ids)) return null
  return { helpfulIds: ids.filter((id): id is string => typeof id === 'string') }
}

async function judgeGold() {
  const runId = argValue('--run-id') ?? 'main'
  const limit = argNumber('--limit') ?? Number.POSITIVE_INFINITY
  const dryRun = hasFlag('--dry-run')
  const prodConfig = loadProdConfig()
  const evalConfig = buildEvalConfig(prodConfig)
  const model = argValue('--model') ?? loadSettings().reviewModel

  const replayLines = readJsonLines<ReplayLine>(evalDataPath(`replay-${runId}.jsonl`))
  const latestByKey = new Map(replayLines.map(line => [line.promptKey, line]))
  if (latestByKey.size === 0) {
    throw new Error(`No replay data for run '${runId}'; run eval-retrieval first.`)
  }

  const goldPath = evalDataPath(`judgments-gold-${runId}.jsonl`)
  const cached = new Map<string, GoldRow>()
  for (const row of readJsonLines<GoldRow>(goldPath)) {
    cached.set(`${row.promptKey}:${row.memoryId}`, row)
  }

  // Transcript coverage first, so the log states the real gold-subset size.
  const covered: Array<{ line: ReplayLine; transcriptPath: string }> = []
  for (const line of latestByKey.values()) {
    const transcriptPath = findTranscriptPath(line.sessionId)
    if (transcriptPath) covered.push({ line, transcriptPath })
  }
  console.log(`[eval-gold] Run: ${runId} | transcript-covered prompts: ${covered.length}/${latestByKey.size} | model: ${model}`)
  if (dryRun) console.log('[eval-gold] DRY RUN - no LLM calls')

  await initLanceDB(evalConfig)

  let judged = 0
  let skipped = 0
  let failed = 0
  for (const { line, transcriptPath } of covered) {
    if (judged >= limit) break

    const unionIds = Array.from(new Set(
      Object.values(line.arms).flatMap(arm => arm.injected.map(entry => entry.id))
    ))
    if (unionIds.length === 0 || unionIds.every(id => cached.has(`${line.promptKey}:${id}`))) {
      skipped += 1
      continue
    }

    const records = await fetchRecordsByIds(unionIds, evalConfig)
    const candidates = shuffleDeterministic(
      records.map((record: MemoryRecord) => ({
        id: record.id,
        snippet: formatRecordSnippet(record) ?? truncateSnippet(buildRecordSnippet(record), 160)
      })),
      line.promptKey
    )

    const transcript = await parseTranscript(transcriptPath)
    const transcriptText = formatTranscript(windowFromPrompt(transcript, line.text), TRANSCRIPT_WINDOW_CHARS)

    if (dryRun) {
      console.log(`\n[eval-gold] ${line.promptKey}: "${line.text.slice(0, 60)}" | window ${transcriptText.length} chars | ${candidates.length} candidates`)
      judged += 1
      continue
    }

    try {
      const result = await executeReview(
        { promptText: line.text, transcriptText, candidates },
        {
          toolName: 'emit_counterfactual_usefulness',
          toolDescription: 'Submit the ids of candidate memories that would have been genuinely useful.',
          toolSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['helpfulIds'],
            properties: {
              helpfulIds: { type: 'array', items: { type: 'string' } }
            }
          },
          maxTokens: GOLD_MAX_TOKENS,
          systemPrompt: 'You evaluate memory-injection systems. Judge strictly on transcript evidence; an empty list is a valid answer.',
          buildPrompt: buildGoldPrompt,
          coercePayload: coerceGoldPayload,
          model,
          authErrorMessage: 'Anthropic auth unavailable for gold judging.'
        },
        evalConfig
      )
      const allowed = new Set(unionIds)
      const helpful = new Set(result.payload.helpfulIds.filter(id => allowed.has(id)))
      const judgedAt = Date.now()
      const rows: GoldRow[] = unionIds.map(memoryId => ({
        promptKey: line.promptKey,
        memoryId,
        wouldHaveHelped: helpful.has(memoryId),
        model: result.model,
        judgedAt
      }))
      appendJsonLines(goldPath, rows)
      for (const row of rows) cached.set(`${row.promptKey}:${row.memoryId}`, row)
      judged += 1
    } catch (error) {
      failed += 1
      console.error(`\n[eval-gold] Failed to judge ${line.promptKey}:`, error)
    }
    process.stdout.write(`\r[eval-gold] Judged ${judged} | skipped ${skipped} | failed ${failed}`)
  }

  console.log()
  console.log(`[eval-gold] Done. Judged ${judged}, skipped ${skipped}, failed ${failed} -> ${goldPath}`)
}

judgeGold().catch(error => {
  console.error('[eval-gold] Fatal error:', error)
  process.exit(1)
})
