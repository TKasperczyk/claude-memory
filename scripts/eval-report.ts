#!/usr/bin/env npx tsx
/**
 * Aggregate the entity A/B eval: replay captures + judge verdicts -> metrics
 * report (markdown + json) under ~/.claude-memory/eval/.
 *
 * Metrics per arm: judged precision (strict = 'relevant' only, lenient adds
 * 'partially_relevant'), B-only relevant discoveries vs arm A (split by
 * attribution: shares_entity expansion vs keyword-only match), displacement
 * harm (A-injected relevant memories a B arm dropped), Jaccard overlap,
 * entity-edge firing stats, timing percentiles, and the gold counterfactual
 * table where transcript judgments exist.
 *
 * Usage:
 *   npx tsx scripts/eval-report.ts                # report for run 'main'
 *   npx tsx scripts/eval-report.ts --run-id smoke
 */

import fs from 'node:fs'
import type { RelationKind } from '../src/lib/types.js'
import { argValue, evalDataPath, readJsonLines } from './eval-shared.js'

const BASELINE_ARM = 'A'
const TOP_DISCOVERIES_SHOWN = 10

type InjectedCapture = {
  id: string
  score?: number
  keywordMatch?: boolean
  via?: { parentId: string; kind: RelationKind; hop: number }
}

type ReplayLine = {
  promptKey: string
  sessionId: string
  cwd: string
  text: string
  timestamp: number
  arms: Record<string, { injected: InjectedCapture[]; durationMs: number }>
}

type JudgmentRow = {
  promptKey: string
  memoryId: string
  verdict: 'relevant' | 'partially_relevant' | 'irrelevant' | 'unknown'
  reason: string
}

type GoldRow = {
  promptKey: string
  memoryId: string
  wouldHaveHelped: boolean
}

type Discovery = {
  promptKey: string
  text: string
  memoryId: string
  arm: string
  verdict: string
  reason: string
  via?: InjectedCapture['via']
  keywordMatch?: boolean
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  let intersection = 0
  for (const id of a) if (b.has(id)) intersection += 1
  return intersection / (a.size + b.size - intersection)
}

function report() {
  const runId = argValue('--run-id') ?? 'main'
  const replayLines = readJsonLines<ReplayLine>(evalDataPath(`replay-${runId}.jsonl`))
  const lines = Array.from(new Map(replayLines.map(line => [line.promptKey, line])).values())
  if (lines.length === 0) {
    throw new Error(`No replay data for run '${runId}'.`)
  }

  const verdicts = new Map<string, JudgmentRow>()
  for (const row of readJsonLines<JudgmentRow>(evalDataPath(`judgments-${runId}.jsonl`))) {
    verdicts.set(`${row.promptKey}:${row.memoryId}`, row)
  }
  const gold = new Map<string, GoldRow>()
  for (const row of readJsonLines<GoldRow>(evalDataPath(`judgments-gold-${runId}.jsonl`))) {
    gold.set(`${row.promptKey}:${row.memoryId}`, row)
  }

  const armNames = Array.from(new Set(lines.flatMap(line => Object.keys(line.arms))))
  if (!armNames.includes(BASELINE_ARM)) {
    throw new Error(`Baseline arm '${BASELINE_ARM}' missing from replay data.`)
  }

  // ---- per-arm aggregates ----
  type ArmStats = {
    prompts: number
    injectedTotal: number
    judged: number
    relevant: number
    partial: number
    irrelevant: number
    entityEdgeInjections: number
    relatesToInjections: number
    durations: number[]
    goldJudged: number
    goldHelpful: number
  }
  const stats = new Map<string, ArmStats>(armNames.map(name => [name, {
    prompts: 0, injectedTotal: 0, judged: 0, relevant: 0, partial: 0, irrelevant: 0,
    entityEdgeInjections: 0, relatesToInjections: 0, durations: [], goldJudged: 0, goldHelpful: 0
  }]))

  const discoveries: Discovery[] = []
  const displacements = new Map<string, number>(armNames.map(name => [name, 0]))
  const goldDiscoveries = new Map<string, number>(armNames.map(name => [name, 0]))
  const overlaps = new Map<string, number[]>()

  for (const line of lines) {
    const injectedByArm = new Map<string, Set<string>>()
    for (const armName of armNames) {
      const capture = line.arms[armName]
      if (!capture) continue
      const armStats = stats.get(armName)!
      armStats.prompts += 1
      armStats.durations.push(capture.durationMs)
      injectedByArm.set(armName, new Set(capture.injected.map(entry => entry.id)))

      for (const entry of capture.injected) {
        armStats.injectedTotal += 1
        if (entry.via?.kind === 'shares_entity') armStats.entityEdgeInjections += 1
        if (entry.via?.kind === 'relates_to') armStats.relatesToInjections += 1

        const verdict = verdicts.get(`${line.promptKey}:${entry.id}`)
        if (verdict) {
          armStats.judged += 1
          if (verdict.verdict === 'relevant') armStats.relevant += 1
          else if (verdict.verdict === 'partially_relevant') armStats.partial += 1
          else if (verdict.verdict === 'irrelevant') armStats.irrelevant += 1
        }
        const goldRow = gold.get(`${line.promptKey}:${entry.id}`)
        if (goldRow) {
          armStats.goldJudged += 1
          if (goldRow.wouldHaveHelped) armStats.goldHelpful += 1
        }
      }
    }

    const baseline = injectedByArm.get(BASELINE_ARM)
    if (!baseline) continue

    for (const armName of armNames) {
      if (armName === BASELINE_ARM) continue
      const armSet = injectedByArm.get(armName)
      if (!armSet) continue

      const pairKey = `${BASELINE_ARM}/${armName}`
      const pairOverlaps = overlaps.get(pairKey) ?? []
      pairOverlaps.push(jaccard(baseline, armSet))
      overlaps.set(pairKey, pairOverlaps)

      // Discoveries: injected by this arm, relevant, absent from baseline.
      for (const entry of line.arms[armName].injected) {
        if (baseline.has(entry.id)) continue
        const verdict = verdicts.get(`${line.promptKey}:${entry.id}`)
        if (verdict && (verdict.verdict === 'relevant' || verdict.verdict === 'partially_relevant')) {
          discoveries.push({
            promptKey: line.promptKey,
            text: line.text,
            memoryId: entry.id,
            arm: armName,
            verdict: verdict.verdict,
            reason: verdict.reason,
            via: entry.via,
            keywordMatch: entry.keywordMatch
          })
        }
        const goldRow = gold.get(`${line.promptKey}:${entry.id}`)
        if (goldRow?.wouldHaveHelped) {
          goldDiscoveries.set(armName, (goldDiscoveries.get(armName) ?? 0) + 1)
        }
      }

      // Displacement: baseline-injected relevant memories this arm dropped.
      for (const id of baseline) {
        if (armSet.has(id)) continue
        const verdict = verdicts.get(`${line.promptKey}:${id}`)
        if (verdict?.verdict === 'relevant') {
          displacements.set(armName, (displacements.get(armName) ?? 0) + 1)
        }
      }
    }
  }

  // ---- render ----
  const promptCount = lines.length
  const per100 = (count: number, prompts: number) => prompts > 0 ? (100 * count / prompts).toFixed(1) : '0.0'
  const pct = (numerator: number, denominator: number) => denominator > 0 ? (100 * numerator / denominator).toFixed(1) + '%' : 'n/a'

  const md: string[] = []
  md.push(`# Entity A/B Eval Report — run '${runId}'`)
  md.push('')
  md.push(`Prompts replayed: ${promptCount} | judged verdict rows: ${verdicts.size} | gold rows: ${gold.size}`)
  md.push('')
  md.push('## Per-arm summary')
  md.push('')
  md.push('| Arm | Prompts | Injected | Judged | Precision (strict) | Precision (lenient) | shares_entity inj. | relates_to inj. | p50 ms | p95 ms |')
  md.push('|---|---|---|---|---|---|---|---|---|---|')
  for (const armName of armNames) {
    const s = stats.get(armName)!
    md.push(`| ${armName} | ${s.prompts} | ${s.injectedTotal} | ${s.judged} | ${pct(s.relevant, s.judged)} | ${pct(s.relevant + s.partial, s.judged)} | ${s.entityEdgeInjections} | ${s.relatesToInjections} | ${percentile(s.durations, 50)} | ${percentile(s.durations, 95)} |`)
  }
  md.push('')

  md.push(`## Discoveries vs baseline ${BASELINE_ARM} (judged relevant/partial, not injected by ${BASELINE_ARM})`)
  md.push('')
  md.push('| Arm | Discoveries | per 100 prompts | strict-relevant | via shares_entity | keyword-only | Displaced relevant | Net (strict disc − displaced) |')
  md.push('|---|---|---|---|---|---|---|---|')
  for (const armName of armNames) {
    if (armName === BASELINE_ARM) continue
    const armDiscoveries = discoveries.filter(discovery => discovery.arm === armName)
    const strict = armDiscoveries.filter(discovery => discovery.verdict === 'relevant')
    const viaEntity = armDiscoveries.filter(discovery => discovery.via?.kind === 'shares_entity')
    const keywordOnly = armDiscoveries.filter(discovery => !discovery.via && discovery.keywordMatch)
    const displaced = displacements.get(armName) ?? 0
    md.push(`| ${armName} | ${armDiscoveries.length} | ${per100(armDiscoveries.length, promptCount)} | ${strict.length} | ${viaEntity.length} | ${keywordOnly.length} | ${displaced} | ${strict.length - displaced} |`)
  }
  md.push('')

  md.push('## Arm overlap (mean per-prompt Jaccard vs baseline)')
  md.push('')
  for (const [pairKey, values] of overlaps) {
    const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)
    md.push(`- ${pairKey}: ${mean.toFixed(3)}`)
  }
  md.push('')

  if (gold.size > 0) {
    md.push('## Gold (counterfactual, transcript-grounded subset)')
    md.push('')
    md.push('| Arm | Gold-judged injections | Would-have-helped | Rate | Gold discoveries vs A |')
    md.push('|---|---|---|---|---|')
    for (const armName of armNames) {
      const s = stats.get(armName)!
      const extra = armName === BASELINE_ARM ? '—' : String(goldDiscoveries.get(armName) ?? 0)
      md.push(`| ${armName} | ${s.goldJudged} | ${s.goldHelpful} | ${pct(s.goldHelpful, s.goldJudged)} | ${extra} |`)
    }
    md.push('')
  }

  md.push(`## Top ${TOP_DISCOVERIES_SHOWN} discoveries (qualitative gut-check)`)
  md.push('')
  const topDiscoveries = discoveries
    .filter(discovery => discovery.verdict === 'relevant')
    .slice(0, TOP_DISCOVERIES_SHOWN)
  if (topDiscoveries.length === 0) md.push('_None._')
  for (const discovery of topDiscoveries) {
    const attribution = discovery.via
      ? `via ${discovery.via.kind} hop${discovery.via.hop}`
      : discovery.keywordMatch ? 'keyword match' : 'direct'
    md.push(`- **[${discovery.arm}, ${attribution}]** prompt: "${discovery.text.slice(0, 100)}"`)
    md.push(`  - memory ${discovery.memoryId}: ${discovery.reason.slice(0, 220)}`)
  }
  md.push('')

  const markdown = md.join('\n')
  const mdPath = evalDataPath(`report-${runId}.md`)
  const jsonPath = evalDataPath(`report-${runId}.json`)
  fs.writeFileSync(mdPath, markdown)
  fs.writeFileSync(jsonPath, JSON.stringify({
    runId,
    generatedAt: new Date().toISOString(),
    promptCount,
    arms: Object.fromEntries(Array.from(stats.entries()).map(([name, s]) => [name, {
      ...s,
      durations: undefined,
      p50: percentile(s.durations, 50),
      p95: percentile(s.durations, 95)
    }])),
    discoveries,
    displacements: Object.fromEntries(displacements),
    goldDiscoveries: Object.fromEntries(goldDiscoveries),
    overlaps: Object.fromEntries(Array.from(overlaps.entries()).map(([pairKey, values]) => [
      pairKey,
      values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)
    ]))
  }, null, 2))

  console.log(markdown)
  console.log(`\n[eval-report] Written: ${mdPath} and ${jsonPath}`)
}

report()
