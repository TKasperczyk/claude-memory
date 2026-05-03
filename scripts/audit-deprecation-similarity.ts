/**
 * Audit deprecated records without provenance by embedding similarity to active records.
 *
 * Usage:
 *   pnpm tsx scripts/audit-deprecation-similarity.ts [--apply] [--collection <name>] [--top-k 5] [--report <path>]
 */

import path from 'path'
import { homedir } from 'os'
import { pathToFileURL } from 'url'
import { JsonStore } from '../src/lib/file-store.js'
import { writeJsonFile } from '../src/lib/json.js'
import { loadConfig } from '../src/lib/config.js'
import { getPrimaryRecordText } from '../src/lib/record-fields.js'
import { batchUpdateRecords, closeLanceDB, escapeFilterValue, initLanceDB, iterateRecords, vectorSearchSimilar } from '../src/lib/lancedb.js'
import { buildRecordSnippet } from '../src/lib/shared.js'
import { EMBEDDING_DIM, type Config, type MemoryRecord, type RecordScope, type RecordType } from '../src/lib/types.js'

const DEFAULT_TOP_K = 5
const STRONG_SIMILARITY = 0.85
const WEAK_SIMILARITY = 0.65
const STRONG_MARGIN = 0.05

export type SimilarityTier =
  | 'strong-similar-active'
  | 'strong-similar-multi'
  | 'weak-similar-active'
  | 'no-similar-active'

type CandidateInput = {
  id: string
  similarity: number
}

export interface SimilarityTierResult {
  tier: SimilarityTier
  label: string
  margin: number | null
  topCandidateId?: string
  topSimilarity?: number
}

interface CliArgs {
  apply: boolean
  collection?: string
  help: boolean
  report?: string
  topK: number
}

interface CandidateReportEntry {
  id: string
  type: RecordType
  scope?: RecordScope
  project?: string
  similarity: number
  primaryText: string
}

interface TargetReportEntry {
  target: {
    id: string
    type: RecordType
    scope?: RecordScope
    project?: string
    primaryText: string
  }
  tierLabel: string
  tier: SimilarityTier
  margin: number | null
  candidates: CandidateReportEntry[]
}

interface AuditStats {
  auditTargets: number
  activePoolRecords: number
  skippedAlreadyHadMetadata: number
  recordsToUpdate: number
  tierCounts: Record<SimilarityTier, number>
}

interface AuditPlan {
  recordsToUpdate: MemoryRecord[]
  reportEntries: TargetReportEntry[]
  stats: AuditStats
}

interface AuditReport {
  generatedAt: string
  mode: 'apply' | 'dry-run'
  collection: string
  topK: number
  stats: AuditStats & {
    recordsUpdated?: number
    recordsFailed?: number
  }
  results: TargetReportEntry[]
}

function emptyTierCounts(): Record<SimilarityTier, number> {
  return {
    'strong-similar-active': 0,
    'strong-similar-multi': 0,
    'weak-similar-active': 0,
    'no-similar-active': 0
  }
}

function formatSimilarity(value: number): string {
  return value.toFixed(3)
}

function roundSimilarity(value: number): number {
  return Number(value.toFixed(6))
}

export function classifySimilarityTier(candidates: CandidateInput[]): SimilarityTierResult {
  const sorted = [...candidates]
    .filter(candidate => Number.isFinite(candidate.similarity))
    .sort((a, b) => b.similarity - a.similarity)
  const top1 = sorted[0]

  if (!top1 || top1.similarity < WEAK_SIMILARITY) {
    const top2 = sorted[1]
    return {
      tier: 'no-similar-active',
      label: 'audit:no-similar-active',
      margin: top1 ? roundSimilarity(top1.similarity - (top2?.similarity ?? 0)) : null,
      topCandidateId: top1?.id,
      topSimilarity: top1?.similarity
    }
  }

  const top2 = sorted[1]
  const margin = roundSimilarity(top1.similarity - (top2?.similarity ?? 0))

  if (top1.similarity >= STRONG_SIMILARITY) {
    if (margin >= STRONG_MARGIN) {
      return {
        tier: 'strong-similar-active',
        label: `audit:strong-similar-active:${top1.id}:${formatSimilarity(top1.similarity)}`,
        margin,
        topCandidateId: top1.id,
        topSimilarity: top1.similarity
      }
    }

    return {
      tier: 'strong-similar-multi',
      label: `audit:strong-similar-multi:${formatSimilarity(top1.similarity)}`,
      margin,
      topSimilarity: top1.similarity
    }
  }

  return {
    tier: 'weak-similar-active',
    label: `audit:weak-similar-active:${top1.id}:${formatSimilarity(top1.similarity)}`,
    margin,
    topCandidateId: top1.id,
    topSimilarity: top1.similarity
  }
}

function parseArgs(argv: string[]): CliArgs {
  const parsed: CliArgs = { apply: false, help: false, topK: DEFAULT_TOP_K }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]

    if (arg === '--apply') {
      parsed.apply = true
      continue
    }

    if (arg === '--collection') {
      const value = argv[i + 1]
      if (!value || value.startsWith('--')) {
        throw new Error('--collection requires a collection name')
      }
      parsed.collection = value
      i += 1
      continue
    }

    if (arg === '--top-k') {
      const value = argv[i + 1]
      if (!value || value.startsWith('--')) {
        throw new Error('--top-k requires a positive integer')
      }
      const parsedTopK = Number(value)
      if (!Number.isInteger(parsedTopK) || parsedTopK <= 0) {
        throw new Error('--top-k requires a positive integer')
      }
      parsed.topK = parsedTopK
      i += 1
      continue
    }

    if (arg === '--report') {
      const value = argv[i + 1]
      if (!value || value.startsWith('--')) {
        throw new Error('--report requires a path')
      }
      parsed.report = value
      i += 1
      continue
    }

    if (arg === '--help' || arg === '-h') {
      parsed.help = true
      continue
    }

    throw new Error(`Unknown argument: ${arg}`)
  }

  return parsed
}

function usage(): string {
  return [
    'Usage: pnpm tsx scripts/audit-deprecation-similarity.ts [--apply] [--collection <name>] [--top-k 5] [--report <path>]',
    '',
    'Default mode is dry-run. Pass --apply to write deprecatedAt/deprecatedReason metadata.',
    'The report defaults to ~/.claude-memory/audit-reports/audit-similarity-<timestamp>.json.'
  ].join('\n')
}

function timestampForPath(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-')
}

function resolveReportPath(reportPath: string | undefined): string {
  if (!reportPath) {
    const store = new JsonStore('audit-reports')
    return store.buildPath(`audit-similarity-${timestampForPath()}`, { legacy: true })
  }

  if (reportPath === '~') return homedir()
  if (reportPath.startsWith('~/')) return path.join(homedir(), reportPath.slice(2))
  if (path.isAbsolute(reportPath)) return reportPath
  return path.resolve(process.cwd(), reportPath)
}

function previewText(value: string, maxLength: number): string {
  const cleaned = value.replace(/\s+/g, ' ').trim()
  if (cleaned.length <= maxLength) return cleaned
  return cleaned.slice(0, maxLength)
}

function primaryText(record: MemoryRecord, maxLength: number): string {
  const text = getPrimaryRecordText(record) || buildRecordSnippet(record)
  return previewText(text, maxLength)
}

function hasDeprecatedReason(record: MemoryRecord): boolean {
  return typeof record.deprecatedReason === 'string' && record.deprecatedReason.trim() !== ''
}

function isValidEmbedding(embedding: unknown): embedding is number[] {
  return Array.isArray(embedding)
    && embedding.length === EMBEDDING_DIM
    && embedding.every(value => typeof value === 'number' && Number.isFinite(value))
}

async function loadRecords(filter: string, config: Config): Promise<MemoryRecord[]> {
  const records: MemoryRecord[] = []
  for await (const record of iterateRecords({ filter, includeEmbeddings: true }, config)) {
    records.push(record)
  }
  return records
}

function buildTargetFilter(): string {
  return 'deprecated = true AND deprecated_reason IS NULL'
}

function buildActiveFilter(): string {
  return 'deprecated = false'
}

function buildCandidateFilter(target: MemoryRecord): string {
  const activeFilter = buildActiveFilter()
  if (target.scope === 'global') return activeFilter

  const project = target.project ?? ''
  return `${activeFilter} AND (project = '${escapeFilterValue(project)}' OR scope = 'global')`
}

function toCandidateReportEntry(match: { record: MemoryRecord; similarity: number }): CandidateReportEntry {
  return {
    id: match.record.id,
    type: match.record.type,
    scope: match.record.scope,
    project: match.record.project,
    similarity: roundSimilarity(match.similarity),
    primaryText: primaryText(match.record, 100)
  }
}

function toTargetReportEntry(
  target: MemoryRecord,
  tierResult: SimilarityTierResult,
  candidates: Array<{ record: MemoryRecord; similarity: number }>
): TargetReportEntry {
  return {
    target: {
      id: target.id,
      type: target.type,
      scope: target.scope,
      project: target.project,
      primaryText: primaryText(target, 200)
    },
    tierLabel: tierResult.label,
    tier: tierResult.tier,
    margin: tierResult.margin,
    candidates: candidates.map(toCandidateReportEntry)
  }
}

async function buildAuditPlan(config: Config, topK: number): Promise<AuditPlan> {
  const activeRecords = await loadRecords(buildActiveFilter(), config)
  const loadedTargets = await loadRecords(buildTargetFilter(), config)
  const recordsToUpdate: MemoryRecord[] = []
  const reportEntries: TargetReportEntry[] = []
  const stats: AuditStats = {
    auditTargets: 0,
    activePoolRecords: activeRecords.length,
    skippedAlreadyHadMetadata: 0,
    recordsToUpdate: 0,
    tierCounts: emptyTierCounts()
  }

  for (const target of loadedTargets) {
    if (hasDeprecatedReason(target)) {
      stats.skippedAlreadyHadMetadata += 1
      continue
    }

    stats.auditTargets += 1

    const matches = isValidEmbedding(target.embedding)
      ? await vectorSearchSimilar(target.embedding, {
        filter: buildCandidateFilter(target),
        limit: topK
      }, config)
      : []

    const tierResult = classifySimilarityTier(matches.map(match => ({
      id: match.record.id,
      similarity: match.similarity
    })))

    stats.tierCounts[tierResult.tier] += 1

    target.deprecatedAt = 0
    target.deprecatedReason = tierResult.label
    recordsToUpdate.push(target)
    reportEntries.push(toTargetReportEntry(target, tierResult, matches))
  }

  stats.recordsToUpdate = recordsToUpdate.length

  return { recordsToUpdate, reportEntries, stats }
}

function printStat(label: string, value: string | number): void {
  console.log(`${label.padEnd(48)} ${value}`)
}

function printSummary(
  stats: AuditStats,
  apply: boolean,
  reportPath: string,
  writeResult?: { updated: number; failed: number }
): void {
  console.log('')
  console.log('Summary')
  printStat('Audit targets', stats.auditTargets)
  printStat('Active records loaded', stats.activePoolRecords)
  printStat('Tier strong-similar-active', stats.tierCounts['strong-similar-active'])
  printStat('Tier strong-similar-multi', stats.tierCounts['strong-similar-multi'])
  printStat('Tier weak-similar-active', stats.tierCounts['weak-similar-active'])
  printStat('Tier no-similar-active', stats.tierCounts['no-similar-active'])
  printStat(
    apply ? 'Records updated' : 'Records updated (dry-run: would update)',
    writeResult?.updated ?? stats.recordsToUpdate
  )
  if (writeResult && writeResult.failed > 0) {
    printStat('Records failed to update', writeResult.failed)
  }
  printStat('Skipped (already had metadata)', stats.skippedAlreadyHadMetadata)
  printStat('Sidecar report', reportPath)
}

function printExamples(entries: TargetReportEntry[]): void {
  const tiers: SimilarityTier[] = [
    'strong-similar-active',
    'strong-similar-multi',
    'weak-similar-active',
    'no-similar-active'
  ]

  console.log('')
  console.log('First 5 examples per tier')

  for (const tier of tiers) {
    const examples = entries.filter(entry => entry.tier === tier).slice(0, 5)
    console.log(`${tier}:`)
    if (examples.length === 0) {
      console.log('- none')
      continue
    }

    for (const example of examples) {
      const top = example.candidates[0]
      const candidate = top
        ? `${top.primaryText} (similarity ${formatSimilarity(top.similarity)})`
        : 'none'
      console.log(`- target: ${example.target.primaryText}`)
      console.log(`  top: ${candidate}`)
    }
  }
}

function buildReport(
  plan: AuditPlan,
  args: CliArgs,
  collection: string,
  writeResult?: { updated: number; failed: number }
): AuditReport {
  return {
    generatedAt: new Date().toISOString(),
    mode: args.apply ? 'apply' : 'dry-run',
    collection,
    topK: args.topK,
    stats: {
      ...plan.stats,
      recordsUpdated: writeResult?.updated,
      recordsFailed: writeResult?.failed
    },
    results: plan.reportEntries
  }
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv)
  if (args.help) {
    console.log(usage())
    return
  }

  const baseConfig = loadConfig(process.cwd())
  const collection = args.collection ?? baseConfig.lancedb.table
  const config: Config = {
    ...baseConfig,
    lancedb: {
      ...baseConfig.lancedb,
      table: collection
    }
  }
  const reportPath = resolveReportPath(args.report)

  console.log(`Mode: ${args.apply ? 'apply' : 'dry-run'}`)
  console.log(`Collection: ${collection}`)
  console.log(`Top-K: ${args.topK}`)
  console.log(`Report: ${reportPath}`)

  await initLanceDB(config)
  try {
    const plan = await buildAuditPlan(config, args.topK)

    let writeResult: { updated: number; failed: number } | undefined
    if (args.apply) {
      writeResult = await batchUpdateRecords(plan.recordsToUpdate, {}, config)
    }

    const report = buildReport(plan, args, collection, writeResult)
    writeJsonFile(reportPath, report, { ensureDir: true, pretty: 2 })

    printSummary(plan.stats, args.apply, reportPath, writeResult)
    if (!args.apply) {
      printExamples(plan.reportEntries)
    }
  } finally {
    await closeLanceDB()
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1]
  return Boolean(entry && import.meta.url === pathToFileURL(path.resolve(entry)).href)
}

if (isMainModule()) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
