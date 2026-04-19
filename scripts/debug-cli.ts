/**
 * Debug CLI for claude-memory.
 *
 * Power-user tool for inspecting the memory database, debugging retrieval scoring,
 * dry-running maintenance phases, comparing records, and exporting data.
 *
 * Usage:
 *   pnpm debug <command> [options]
 *   pnpm debug help
 */

import { loadConfig } from '../src/lib/config.js'
import {
  initLanceDB,
  closeLanceDB,
  getRecord,
  findSimilar,
  iterateRecords,
  computeUsageRatio
} from '../src/lib/lancedb.js'
import { type Config, type MemoryRecord, type HybridSearchResult } from '../src/lib/types.js'
import { retrieveContext, cosineSimilarity, computeUnifiedScore } from '../src/lib/retrieval.js'
import { buildMemoryStats } from '../src/lib/memory-stats.js'
import { loadSettings, resolveMaintenanceSettings } from '../src/lib/settings.js'
import type { RetrievalSettings } from '../src/lib/settings.js'
import { RETRIEVAL_FIELDS, MAINTENANCE_FIELDS, MODEL_FIELDS } from '../src/lib/settings-schema.js'
import {
  runStaleCheck,
  runStaleUnusedDeprecation,
  runLowUsageDeprecation,
  runLowUsageCheck,
  runConsolidation,
  runCrossTypeConsolidation,
  runGlobalPromotion,
  type MaintenanceRunResult
} from '../src/lib/maintenance/runners/index.js'
import { embed } from '../src/lib/embed.js'
import { getRecordFieldView } from '../src/lib/record-fields.js'
import { getRecordSummary } from '../src/lib/record-summary.js'
import { dedupeInjectedMemories, listAllSessions, loadSessionTracking } from '../src/lib/session-tracking.js'
import { listInProgressExtractions } from '../src/lib/extraction-log.js'
import { paginateExtractionRuns, loadExtractionRunDetail } from '../src/lib/extraction-query.js'
import { getInjectionReview, saveInjectionReview, getReview, saveReview } from '../src/lib/review-storage.js'
import { reviewInjection, reviewInjectionStreaming } from '../src/lib/injection-review.js'
import { reviewExtraction, reviewExtractionStreaming } from '../src/lib/extraction-review.js'
import type { ExtractionReview, InjectionReview } from '../shared/types.js'

// ---------------------------------------------------------------------------
// ANSI color codes (same pattern as gemini-audit.ts)
// ---------------------------------------------------------------------------
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

// Flags that take a string value (everything else is boolean)
const VALUE_FLAGS = new Set([
  'cwd', 'max-records', 'min-score', 'mmr-lambda',
  'threshold', 'limit', 'format', 'filter',
  'search', 'project', 'since', 'session', 'offset'
])

const rawArgs = process.argv.slice(2)

function parseArgs(args: string[]): {
  command: string | undefined
  positionalArgs: string[]
  flags: Record<string, string | boolean>
} {
  const flags: Record<string, string | boolean> = {}
  const positional: string[] = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const key = arg.slice(2)
    // Handle --no-X as X = false
    if (key.startsWith('no-')) {
      flags[key.slice(3)] = false
      continue
    }
    // If this flag takes a value, consume the next arg
    if (VALUE_FLAGS.has(key)) {
      const next = args[i + 1]
      if (next !== undefined) {
        flags[key] = next
        i++
      } else {
        flags[key] = true // missing value, treat as boolean
      }
    } else {
      flags[key] = true
    }
  }

  return {
    command: positional[0],
    positionalArgs: positional.slice(1),
    flags
  }
}

const { command, positionalArgs, flags } = parseArgs(rawArgs)

function flagStr(key: string, fallback?: string): string | undefined {
  const v = flags[key]
  return typeof v === 'string' ? v : fallback
}

function flagNum(key: string): number | undefined {
  const v = flags[key]
  if (typeof v === 'string') {
    const n = parseFloat(v)
    return isNaN(n) ? undefined : n
  }
  return undefined
}

function flagBool(key: string): boolean | undefined {
  const v = flags[key]
  return typeof v === 'boolean' ? v : undefined
}

const jsonMode = flagBool('json') === true

// ---------------------------------------------------------------------------
// Formatting utilities
// ---------------------------------------------------------------------------
function printHeader(text: string): void {
  if (jsonMode) return
  console.log(`\n${c.bold}${c.cyan}=== ${text} ===${c.reset}\n`)
}

function printSection(text: string): void {
  if (jsonMode) return
  console.log(`  ${c.bold}${c.yellow}--- ${text} ---${c.reset}`)
}

function printStat(label: string, value: string | number, color: string = c.white): void {
  if (jsonMode) return
  const padded = label.padEnd(26)
  console.log(`  ${c.dim}${padded}${c.reset} ${color}${value}${c.reset}`)
}

function printScore(score: number): string {
  const s = score.toFixed(4)
  if (score >= 0.6) return `${c.green}${s}${c.reset}`
  if (score >= 0.45) return `${c.yellow}${s}${c.reset}`
  return `${c.red}${s}${c.reset}`
}

function formatAge(timestamp: number | undefined): string {
  if (!timestamp) return 'never'
  const diff = Date.now() - timestamp
  const days = Math.floor(diff / (24 * 60 * 60 * 1000))
  if (days > 0) return `${days}d ago`
  const hours = Math.floor(diff / (60 * 60 * 1000))
  if (hours > 0) return `${hours}h ago`
  const mins = Math.floor(diff / (60 * 1000))
  if (mins > 0) return `${mins}m ago`
  return 'just now'
}

function truncId(id: string): string {
  return id.length > 12 ? id.slice(0, 8) + '...' : id
}

function truncStr(text: string, maxLen: number = 80): string {
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen - 3) + '...'
}

function typeBadge(type: string): string {
  const badges: Record<string, string> = {
    command: `${c.blue}CMD${c.reset}`,
    error: `${c.red}ERR${c.reset}`,
    discovery: `${c.green}DIS${c.reset}`,
    procedure: `${c.magenta}PRO${c.reset}`,
    warning: `${c.yellow}WRN${c.reset}`,
  }
  return badges[type] ?? type
}

function printRecordLine(record: MemoryRecord, prefix: string = '  '): void {
  const summary = getRecordSummary(record) ?? '(no summary)'
  const scope = record.scope === 'global' ? `${c.cyan}global${c.reset}` : `${c.dim}project${c.reset}`
  console.log(`${prefix}${typeBadge(record.type)} ${scope} ${truncStr(summary, 70)}`)
}

function printTable(headers: string[], rows: string[][]): void {
  if (jsonMode) return
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map(r => stripAnsi(r[i] ?? '').length))
  )
  const sep = widths.map(w => '─'.repeat(w + 2)).join('┼')

  const headerLine = headers.map((h, i) =>
    ` ${c.bold}${h.padEnd(widths[i])}${c.reset} `
  ).join('│')
  console.log(`  ${headerLine}`)
  console.log(`  ${sep}`)

  for (const row of rows) {
    const line = row.map((cell, i) => {
      const stripped = stripAnsi(cell)
      const pad = widths[i] - stripped.length
      return ` ${cell}${' '.repeat(Math.max(0, pad))} `
    }).join('│')
    console.log(`  ${line}`)
  }
}

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '')
}

function jsonOutput(data: unknown): void {
  console.log(JSON.stringify(data, null, 2))
}

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------
type CommandHandler = (args: string[], flags: Record<string, string | boolean>) => Promise<void>

const COMMANDS: Record<string, CommandHandler> = {
  stats: cmdStats,
  search: cmdSearch,
  similar: cmdSimilar,
  consolidation: cmdConsolidation,
  deprecation: cmdDeprecation,
  promotion: cmdPromotion,
  record: cmdRecord,
  export: cmdExport,
  embedding: cmdEmbedding,
  compare: cmdCompare,
  settings: cmdSettings,
  sessions: cmdSessions,
  session: cmdSession,
  extractions: cmdExtractions,
  extraction: cmdExtraction,
  'review-session': cmdReviewSession,
  'review-extraction': cmdReviewExtraction,
}

const NO_DB_COMMANDS = new Set(['settings', 'help', 'embedding', 'sessions', 'session', 'extractions'])
// sessions/session/extractions read JSON file stores only; extraction (detail)
// and review-* fetch records from LanceDB so they go through the default path.

async function main(): Promise<void> {
  if (!command || command === 'help' || flags.help === true) {
    printUsage()
    return
  }

  const handler = COMMANDS[command]
  if (!handler) {
    console.error(`${c.red}Unknown command:${c.reset} ${command}`)
    printUsage()
    process.exit(1)
  }

  const config = loadConfig(process.cwd())
  if (!NO_DB_COMMANDS.has(command)) {
    await initLanceDB(config)
  }

  try {
    await handler(positionalArgs, flags)
  } finally {
    if (!NO_DB_COMMANDS.has(command)) {
      await closeLanceDB()
    }
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdStats(): Promise<void> {
  const config = loadConfig(process.cwd())
  const stats = await buildMemoryStats(config)

  if (jsonMode) {
    jsonOutput(stats)
    return
  }

  printHeader('MEMORY POOL STATISTICS')

  printStat('Total records', stats.total, c.bold)
  printStat('Active', stats.total - stats.deprecated, c.green)
  printStat('Deprecated', stats.deprecated, c.red)

  if (stats.total === 0) {
    console.log(`\n  ${c.dim}(empty collection)${c.reset}`)
    return
  }
  console.log()

  printSection('By Type')
  for (const [type, count] of Object.entries(stats.byType).sort((a, b) => b[1] - a[1])) {
    const pct = ((count / stats.total) * 100).toFixed(1)
    printStat(`  ${type}`, `${count} (${pct}%)`)
  }
  console.log()

  printSection('By Scope')
  for (const [scope, count] of Object.entries(stats.byScope).sort((a, b) => b[1] - a[1])) {
    const pct = ((count / stats.total) * 100).toFixed(1)
    printStat(`  ${scope}`, `${count} (${pct}%)`)
  }
  console.log()

  printSection('Usage Averages')
  printStat('Avg retrieval count', stats.avgRetrievalCount.toFixed(2))
  printStat('Avg usage count', stats.avgUsageCount.toFixed(2))
  printStat('Avg usage ratio', stats.avgUsageRatio.toFixed(4))
  console.log()
}

async function cmdSearch(args: string[]): Promise<void> {
  const query = args[0]
  if (!query) {
    console.error(`${c.red}Usage:${c.reset} pnpm debug search <query> [--cwd <path>] [--no-haiku] [--max-records <n>] [--min-score <n>] [--mmr-lambda <n>]`)
    process.exit(1)
  }

  const config = loadConfig(process.cwd())
  const cwd = flagStr('cwd', process.cwd())!
  const settingsOverride: Partial<RetrievalSettings> = {}

  if (flagBool('haiku') === false) {
    settingsOverride.enableHaikuRetrieval = false
  }
  const maxRecords = flagNum('max-records')
  if (maxRecords !== undefined) settingsOverride.maxRecords = maxRecords
  const minScore = flagNum('min-score')
  if (minScore !== undefined) settingsOverride.minScore = minScore
  const mmrLambda = flagNum('mmr-lambda')
  if (mmrLambda !== undefined) settingsOverride.mmrLambda = mmrLambda

  const result = await retrieveContext(
    { prompt: query, cwd },
    config,
    { diagnostic: true, settingsOverride }
  )

  if (jsonMode) {
    jsonOutput({
      signals: result.signals,
      diagnostics: result.diagnostics ? {
        queryInfo: result.diagnostics.search.queryInfo,
        qualified: result.diagnostics.search.qualified.map(serializeSearchResult),
        nearMisses: result.diagnostics.search.nearMisses.map(nm => ({
          record: serializeSearchResult(nm.record),
          exclusionReasons: nm.exclusionReasons
        })),
        contextExclusions: result.diagnostics.context.exclusions.map(nm => ({
          record: serializeSearchResult(nm.record),
          exclusionReasons: nm.exclusionReasons
        })),
        injected: result.diagnostics.context.injectedRecords.map(serializeSearchResult)
      } : null,
      context: result.context,
      timedOut: result.timedOut
    })
    return
  }

  // Signals
  printHeader('SIGNAL EXTRACTION')
  printStat('Errors', result.signals.errors.length > 0 ? result.signals.errors.join(', ') : '(none)')
  printStat('Commands', result.signals.commands.length > 0 ? result.signals.commands.join(', ') : '(none)')
  printStat('Project', result.signals.projectName ?? '(none)')
  printStat('Project root', result.signals.projectRoot ?? '(none)')

  if (!result.diagnostics) {
    console.log(`\n  ${c.yellow}No diagnostic data available (timed out: ${result.timedOut})${c.reset}`)
    return
  }

  const diag = result.diagnostics

  // Query info
  if (diag.search.queryInfo) {
    const qi = diag.search.queryInfo
    printHeader('QUERY PLAN')
    printStat('Effective prompt', truncStr(qi.effectivePrompt, 100))
    printStat('Semantic query', truncStr(qi.semanticQuery, 100))
    printStat('Keyword queries', qi.keywordQueries.length > 0 ? qi.keywordQueries.join(' | ') : '(none)')
    printStat('Haiku used', qi.haikuUsed ? `${c.green}yes${c.reset}` : 'no')
  }

  // Qualified results
  const qualified = diag.search.qualified
  printHeader(`QUALIFIED RESULTS (${qualified.length})`)
  if (qualified.length > 0) {
    const settings = loadSettings()
    const rows = qualified.map((sr, i) => {
      const r = sr.record
      const usageRatio = computeUsageRatio(r)
      const summary = getRecordSummary(r) ?? '(no summary)'
      return [
        String(i + 1),
        printScore(sr.score),
        sr.similarity.toFixed(4),
        sr.keywordMatch ? `${c.green}yes${c.reset}` : `${c.dim}no${c.reset}`,
        usageRatio.toFixed(2),
        typeBadge(r.type),
        truncStr(summary, 50)
      ]
    })
    printTable(['#', 'Score', 'Sim', 'KW', 'Usage', 'Type', 'Summary'], rows)

    // Score breakdown for top result
    if (qualified.length > 0) {
      const top = qualified[0]
      const usageRatio = computeUsageRatio(top.record)
      const projectMatch = Boolean(result.signals.projectName && top.record.project === result.signals.projectName)
      const breakdown = computeUnifiedScore({
        similarity: top.similarity,
        keywordMatch: top.keywordMatch,
        usageRatio,
        projectMatch,
        settings
      })
      console.log()
      printSection(`Score breakdown (#1)`)
      printStat('  semantic', `${top.similarity.toFixed(4)} * 0.7 = ${breakdown.semantic.toFixed(4)}`)
      printStat('  keyword bonus', `${breakdown.keywordBonus.toFixed(4)}${top.keywordMatch ? ' (scaled by similarity)' : ''}`)
      printStat('  usage ratio', `${usageRatio.toFixed(4)} * ${settings.usageRatioWeight} = ${breakdown.usage.toFixed(4)}`)
      printStat('  project boost', `${breakdown.projectBoost.toFixed(4)}${projectMatch ? '' : ' (no match)'}`)
      printStat('  computed total', breakdown.total.toFixed(4))
      printStat('  actual score', printScore(top.score))
    }
  }

  // Near misses
  const nearMisses = diag.search.nearMisses
  if (nearMisses.length > 0) {
    printHeader(`NEAR MISSES (${nearMisses.length})`)
    for (const nm of nearMisses.slice(0, 10)) {
      const r = nm.record.record
      const summary = getRecordSummary(r) ?? '(no summary)'
      const reasons = nm.exclusionReasons.map(er => {
        let detail = `${er.reason} (threshold: ${er.threshold.toFixed(4)}, actual: ${er.actual.toFixed(4)}, gap: ${er.gap.toFixed(4)})`
        if (er.similarTo) detail += ` similar to ${truncId(er.similarTo)}`
        return detail
      }).join('; ')
      console.log(`  ${c.dim}*${c.reset} ${typeBadge(r.type)} ${truncStr(summary, 50)}`)
      console.log(`    ${c.dim}score: ${nm.record.score.toFixed(4)}, sim: ${nm.record.similarity.toFixed(4)}${c.reset}`)
      console.log(`    ${c.red}${reasons}${c.reset}`)
    }
    if (nearMisses.length > 10) {
      console.log(`  ${c.dim}... and ${nearMisses.length - 10} more${c.reset}`)
    }
  }

  // Context exclusions
  const ctxExclusions = diag.context.exclusions
  if (ctxExclusions.length > 0) {
    printHeader(`CONTEXT EXCLUSIONS (${ctxExclusions.length})`)
    for (const ex of ctxExclusions) {
      const r = ex.record.record
      const summary = getRecordSummary(r) ?? '(no summary)'
      const reasons = ex.exclusionReasons.map(er => {
        let detail = `${er.reason}`
        if (er.rank !== undefined) detail += ` (rank: ${er.rank})`
        if (er.projectedTokens !== undefined) detail += ` (tokens: ${er.projectedTokens})`
        return detail
      }).join('; ')
      console.log(`  ${c.dim}*${c.reset} ${typeBadge(r.type)} ${truncStr(summary, 50)}`)
      console.log(`    ${c.yellow}${reasons}${c.reset}`)
    }
  }

  // Injected context
  printHeader('INJECTED CONTEXT')
  if (result.context) {
    const lines = result.context.split('\n')
    for (const line of lines) {
      console.log(`  ${c.dim}${line}${c.reset}`)
    }
  } else {
    console.log(`  ${c.dim}(no context injected)${c.reset}`)
  }
  console.log()
}

async function cmdSimilar(args: string[]): Promise<void> {
  const id = args[0]
  if (!id) {
    console.error(`${c.red}Usage:${c.reset} pnpm debug similar <id> [--threshold <n>] [--limit <n>]`)
    process.exit(1)
  }

  const config = loadConfig(process.cwd())
  const threshold = flagNum('threshold') ?? 0.5
  const limit = flagNum('limit') ?? 10

  const record = await getRecord(id, config, { includeEmbedding: true })
  if (!record) {
    console.error(`${c.red}Record not found:${c.reset} ${id}`)
    process.exit(1)
  }

  const matches = await findSimilar(record, threshold, limit, config)

  if (jsonMode) {
    jsonOutput({
      anchor: serializeRecord(record),
      threshold,
      matches: matches.map(m => ({
        similarity: m.similarity,
        record: serializeRecord(m.record)
      }))
    })
    return
  }

  printHeader('ANCHOR RECORD')
  printRecordDetail(record)

  printHeader(`SIMILAR RECORDS (${matches.length} found, threshold: ${threshold})`)
  if (matches.length === 0) {
    console.log(`  ${c.dim}No similar records found${c.reset}`)
    return
  }

  const rows = matches.map((m, i) => {
    const summary = getRecordSummary(m.record) ?? '(no summary)'
    return [
      String(i + 1),
      printScore(m.similarity),
      typeBadge(m.record.type),
      (m.record.scope ?? 'project') === 'global' ? `${c.cyan}global${c.reset}` : `${c.dim}project${c.reset}`,
      truncStr(summary, 50)
    ]
  })
  printTable(['#', 'Similarity', 'Type', 'Scope', 'Summary'], rows)
  console.log()
}

async function cmdConsolidation(): Promise<void> {
  const config = loadConfig(process.cwd())
  const settings = resolveMaintenanceSettings()

  console.error(`${c.dim}Running consolidation dry-run...${c.reset}`)
  const sameType = await runConsolidation(true, config, settings)
  console.error(`${c.dim}Running cross-type consolidation dry-run...${c.reset}`)
  const crossType = await runCrossTypeConsolidation(true, config, settings)

  if (jsonMode) {
    jsonOutput({ sameType, crossType })
    return
  }

  printMaintenanceResult('SAME-TYPE CONSOLIDATION', sameType)
  printMaintenanceResult('CROSS-TYPE CONSOLIDATION', crossType)
}

async function cmdDeprecation(): Promise<void> {
  const config = loadConfig(process.cwd())
  const settings = resolveMaintenanceSettings()

  console.error(`${c.dim}Running deprecation dry-runs...${c.reset}`)
  const stale = await runStaleCheck(true, config, settings)
  const staleUnused = await runStaleUnusedDeprecation(true, config, settings)
  const lowUsage = await runLowUsageDeprecation(true, config, settings)
  const lowUsageCheck = await runLowUsageCheck(true, config, settings)

  if (jsonMode) {
    jsonOutput({ stale, staleUnused, lowUsage, lowUsageCheck })
    return
  }

  printMaintenanceResult('STALE CHECK', stale)
  printMaintenanceResult('STALE UNUSED DEPRECATION', staleUnused)
  printMaintenanceResult('LOW USAGE (ZERO) DEPRECATION', lowUsage)
  printMaintenanceResult('LOW USAGE (RATIO) CHECK', lowUsageCheck)
}

async function cmdPromotion(): Promise<void> {
  const config = loadConfig(process.cwd())
  const settings = resolveMaintenanceSettings()

  console.error(`${c.dim}Running promotion dry-run...${c.reset}`)
  const result = await runGlobalPromotion(true, config, settings)

  if (jsonMode) {
    jsonOutput(result)
    return
  }

  printMaintenanceResult('GLOBAL PROMOTION', result)
}

async function cmdRecord(args: string[]): Promise<void> {
  const id = args[0]
  if (!id) {
    console.error(`${c.red}Usage:${c.reset} pnpm debug record <id>`)
    process.exit(1)
  }

  const config = loadConfig(process.cwd())
  const record = await getRecord(id, config, { includeEmbedding: true })
  if (!record) {
    console.error(`${c.red}Record not found:${c.reset} ${id}`)
    process.exit(1)
  }

  if (jsonMode) {
    jsonOutput(serializeRecord(record))
    return
  }

  printHeader(`RECORD: ${record.id}`)
  printRecordDetail(record)

  // Type-specific fields
  printSection('Type-specific Fields')
  const view = getRecordFieldView(record)
  for (const [key, value] of Object.entries(view.fields)) {
    if (value === undefined || value === null) continue
    const display = typeof value === 'object' ? JSON.stringify(value) : String(value)
    printStat(`  ${key}`, truncStr(display, 100))
  }
  console.log()

  // Usage metrics
  printSection('Usage Metrics')
  const usageRatio = computeUsageRatio(record)
  printStat('  Retrieval count', record.retrievalCount ?? 0)
  printStat('  Usage count', record.usageCount ?? 0)
  printStat('  Usage ratio', usageRatio.toFixed(4))
  printStat('  Success count', record.successCount ?? 0)
  printStat('  Failure count', record.failureCount ?? 0)
  printStat('  Last used', formatAge(record.lastUsed))
  console.log()

  // Timestamps
  printSection('Timestamps')
  printStat('  Created', record.timestamp ? `${formatAge(record.timestamp)} (${new Date(record.timestamp).toISOString()})` : 'unknown')
  printStat('  Last used', record.lastUsed ? `${formatAge(record.lastUsed)} (${new Date(record.lastUsed).toISOString()})` : 'never')
  console.log()

  // Embedding stats
  if (record.embedding && record.embedding.length > 0) {
    const emb = record.embedding
    printSection('Embedding')
    const norm = Math.sqrt(emb.reduce((s, v) => s + v * v, 0))
    let minVal = Infinity, maxVal = -Infinity, sum = 0
    for (const v of emb) {
      if (v < minVal) minVal = v
      if (v > maxVal) maxVal = v
      sum += v
    }
    const mean = sum / emb.length
    const variance = emb.reduce((s, v) => s + (v - mean) ** 2, 0) / emb.length
    const std = Math.sqrt(variance)

    printStat('  Dimension', emb.length)
    printStat('  L2 Norm', norm.toFixed(6))
    printStat('  Min', `${minVal.toFixed(6)}`)
    printStat('  Max', `${maxVal.toFixed(6)}`)
    printStat('  Mean', mean.toFixed(6))
    printStat('  Std', std.toFixed(6))
    console.log()
  }

  // Maintenance checks
  printSection('Maintenance Checks')
  const checkFields = [
    ['lastConsolidationCheck', 'Last consolidation'],
    ['lastGlobalCheck', 'Last global check'],
    ['lastConflictCheck', 'Last conflict check'],
    ['lastWarningSynthesisCheck', 'Last warning synthesis'],
    ['lastGeneralizationCheck', 'Last generalization'],
  ] as const
  for (const [field, label] of checkFields) {
    const val = (record as unknown as Record<string, unknown>)[field] as number | undefined
    printStat(`  ${label}`, formatAge(val))
  }
  console.log()
}

async function cmdExport(): Promise<void> {
  const config = loadConfig(process.cwd())
  const format = flagStr('format', 'json')
  const includeEmbeddings = flagBool('include-embeddings') === true
  const filter = flagStr('filter')

  const options: { filter?: string; includeEmbeddings?: boolean } = { includeEmbeddings }
  if (filter) options.filter = filter

  const records: MemoryRecord[] = []
  let count = 0
  for await (const record of iterateRecords(options, config)) {
    count++
    if (format === 'jsonl') {
      const output = includeEmbeddings ? record : stripEmbedding(record)
      process.stdout.write(JSON.stringify(output) + '\n')
    } else {
      records.push(includeEmbeddings ? record : stripEmbedding(record))
    }
  }

  if (format !== 'jsonl') {
    process.stdout.write(JSON.stringify(records, null, 2) + '\n')
  }

  console.error(`${c.dim}Exported ${count} records${c.reset}`)
}

async function cmdEmbedding(args: string[]): Promise<void> {
  const text = args[0]
  if (!text) {
    console.error(`${c.red}Usage:${c.reset} pnpm debug embedding <text>`)
    process.exit(1)
  }

  const config = loadConfig(process.cwd())
  const embedding = await embed(text, config)

  if (jsonMode) {
    const norm = Math.sqrt(embedding.reduce((s, v) => s + v * v, 0))
    jsonOutput({
      input: text,
      dimension: embedding.length,
      norm,
      embedding: flagBool('full') === true ? embedding : undefined
    })
    return
  }

  printHeader('EMBEDDING')
  printStat('Input', truncStr(text, 100))
  printStat('Dimension', embedding.length)

  const norm = Math.sqrt(embedding.reduce((s, v) => s + v * v, 0))
  let minVal = Infinity, maxVal = -Infinity, minIdx = 0, maxIdx = 0, sum = 0
  for (let i = 0; i < embedding.length; i++) {
    const v = embedding[i]
    if (v < minVal) { minVal = v; minIdx = i }
    if (v > maxVal) { maxVal = v; maxIdx = i }
    sum += v
  }
  const mean = sum / embedding.length
  const variance = embedding.reduce((s, v) => s + (v - mean) ** 2, 0) / embedding.length
  const std = Math.sqrt(variance)

  printStat('L2 Norm', norm.toFixed(6))
  printStat('Min', `${minVal.toFixed(6)} (index ${minIdx})`)
  printStat('Max', `${maxVal.toFixed(6)} (index ${maxIdx})`)
  printStat('Mean', mean.toFixed(6))
  printStat('Std', std.toFixed(6))
  printStat('First 5', `[${embedding.slice(0, 5).map(v => v.toFixed(4)).join(', ')}]`)
  printStat('Last 5', `[${embedding.slice(-5).map(v => v.toFixed(4)).join(', ')}]`)
  console.log()
}

async function cmdCompare(args: string[]): Promise<void> {
  const id1 = args[0]
  const id2 = args[1]
  if (!id1 || !id2) {
    console.error(`${c.red}Usage:${c.reset} pnpm debug compare <id1> <id2>`)
    process.exit(1)
  }

  const config = loadConfig(process.cwd())
  const [recordA, recordB] = await Promise.all([
    getRecord(id1, config, { includeEmbedding: true }),
    getRecord(id2, config, { includeEmbedding: true })
  ])

  if (!recordA) {
    console.error(`${c.red}Record A not found:${c.reset} ${id1}`)
    process.exit(1)
  }
  if (!recordB) {
    console.error(`${c.red}Record B not found:${c.reset} ${id2}`)
    process.exit(1)
  }

  const similarity = (recordA.embedding && recordB.embedding)
    ? cosineSimilarity(recordA.embedding, recordB.embedding)
    : null

  if (jsonMode) {
    jsonOutput({
      recordA: serializeRecord(recordA),
      recordB: serializeRecord(recordB),
      cosineSimilarity: similarity,
      usageRatioA: computeUsageRatio(recordA),
      usageRatioB: computeUsageRatio(recordB)
    })
    return
  }

  printHeader('COMPARE')

  const summaryA = getRecordSummary(recordA) ?? '(no summary)'
  const summaryB = getRecordSummary(recordB) ?? '(no summary)'
  console.log(`  ${c.bold}Record A:${c.reset} ${truncId(id1)} ${typeBadge(recordA.type)} ${truncStr(summaryA, 60)}`)
  console.log(`  ${c.bold}Record B:${c.reset} ${truncId(id2)} ${typeBadge(recordB.type)} ${truncStr(summaryB, 60)}`)
  console.log()

  if (similarity !== null) {
    printStat('Cosine similarity', printScore(similarity))
  } else {
    printStat('Cosine similarity', `${c.red}N/A (missing embeddings)${c.reset}`)
  }
  console.log()

  printSection('Metrics Comparison')
  const metrics: [string, (r: MemoryRecord) => string][] = [
    ['Type', r => r.type],
    ['Scope', r => r.scope ?? 'project'],
    ['Project', r => r.project ?? '(none)'],
    ['Retrieval count', r => String(r.retrievalCount ?? 0)],
    ['Usage count', r => String(r.usageCount ?? 0)],
    ['Usage ratio', r => computeUsageRatio(r).toFixed(4)],
    ['Success count', r => String(r.successCount ?? 0)],
    ['Failure count', r => String(r.failureCount ?? 0)],
    ['Last used', r => formatAge(r.lastUsed)],
    ['Age', r => formatAge(r.timestamp)],
    ['Deprecated', r => r.deprecated ? `${c.red}yes${c.reset}` : 'no'],
  ]

  const rows = metrics.map(([label, fn]) => [label, fn(recordA), fn(recordB)])
  printTable(['Metric', 'Record A', 'Record B'], rows)
  console.log()

  // Consolidation relevance
  if (similarity !== null) {
    const settings = loadSettings()
    const consThreshold = (settings as unknown as Record<string, unknown>).consolidationThreshold as number ?? 0.85
    const crossThreshold = (settings as unknown as Record<string, unknown>).crossTypeConsolidationThreshold as number ?? 0.93
    const isSameType = recordA.type === recordB.type

    printSection('Consolidation Relevance')
    if (isSameType && similarity >= consThreshold) {
      console.log(`  ${c.green}Above same-type consolidation threshold (${consThreshold})${c.reset}`)
      console.log(`  ${c.green}These would likely be consolidated in the next maintenance run.${c.reset}`)
    } else if (similarity >= crossThreshold) {
      console.log(`  ${c.green}Above cross-type consolidation threshold (${crossThreshold})${c.reset}`)
      console.log(`  ${c.green}These would likely be consolidated (cross-type) in the next maintenance run.${c.reset}`)
    } else if (isSameType && similarity >= consThreshold - 0.05) {
      console.log(`  ${c.yellow}Close to same-type consolidation threshold (${consThreshold}, gap: ${(consThreshold - similarity).toFixed(4)})${c.reset}`)
    } else {
      console.log(`  ${c.dim}Below consolidation thresholds (same-type: ${consThreshold}, cross-type: ${crossThreshold})${c.reset}`)
    }
    console.log()
  }
}

async function cmdSettings(): Promise<void> {
  const settings = loadSettings()
  const config = loadConfig(process.cwd())

  if (jsonMode) {
    jsonOutput({ settings, config })
    return
  }

  printHeader('RESOLVED SETTINGS')

  printSection('Retrieval')
  for (const field of RETRIEVAL_FIELDS) {
    const current = (settings as unknown as Record<string, unknown>)[field.key]
    const isDefault = current === field.default
    const override = isDefault ? '' : ` ${c.yellow}<- OVERRIDE${c.reset}`
    printStat(`  ${field.key}`, `${current} (default: ${field.default})${override}`)
  }
  console.log()

  printSection('Maintenance')
  for (const field of MAINTENANCE_FIELDS) {
    const current = (settings as unknown as Record<string, unknown>)[field.key]
    const isDefault = current === field.default
    const override = isDefault ? '' : ` ${c.yellow}<- OVERRIDE${c.reset}`
    printStat(`  ${field.key}`, `${current} (default: ${field.default})${override}`)
  }
  console.log()

  printSection('Models')
  for (const field of MODEL_FIELDS) {
    const current = (settings as unknown as Record<string, unknown>)[field.key]
    const isDefault = current === field.default
    const override = isDefault ? '' : ` ${c.yellow}<- OVERRIDE${c.reset}`
    printStat(`  ${field.key}`, `${current} (default: ${field.default})${override}`)
  }
  console.log()

  printHeader('CONFIG')
  printStat('lancedb.directory', config.lancedb.directory)
  printStat('lancedb.table', config.lancedb.table)
  printStat('embeddings.baseUrl', config.embeddings.baseUrl)
  printStat('embeddings.model', config.embeddings.model)
  printStat('extraction.model', config.extraction.model)
  printStat('injection.maxRecords', config.injection.maxRecords)
  printStat('injection.maxTokens', config.injection.maxTokens)
  console.log()
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

function parseSinceFlag(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const match = raw.match(/^(\d+)\s*(h|d)$/i)
  if (!match) return undefined
  const amount = parseInt(match[1], 10)
  const unit = match[2].toLowerCase()
  const ms = unit === 'h' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000
  return Date.now() - amount * ms
}

async function cmdSessions(): Promise<void> {
  const config = loadConfig(process.cwd())
  const search = flagStr('search')?.toLowerCase()
  const project = flagStr('project')
  const hasReviewFilter = flagBool('has-review')
  const sinceCutoff = parseSinceFlag(flagStr('since'))
  const limit = flagNum('limit') ?? 25

  let sessions = listAllSessions(config.lancedb.table).map(session => ({
    ...session,
    memoriesRaw: session.memories,
    memories: dedupeInjectedMemories(session.memories)
  }))

  if (search) {
    sessions = sessions.filter(s =>
      s.sessionId.toLowerCase().includes(search) ||
      (s.cwd?.toLowerCase().includes(search) ?? false) ||
      (s.prompts?.some(p => p.text.toLowerCase().includes(search)) ?? false)
    )
  }
  if (project) {
    sessions = sessions.filter(s => s.cwd?.endsWith(project) || s.cwd?.includes(`/${project}/`))
  }
  if (hasReviewFilter === true) sessions = sessions.filter(s => s.hasReview === true)
  if (hasReviewFilter === false) sessions = sessions.filter(s => !s.hasReview)
  if (sinceCutoff !== undefined) sessions = sessions.filter(s => s.lastActivity >= sinceCutoff)

  const total = sessions.length
  sessions = sessions.slice(0, limit)

  if (jsonMode) {
    jsonOutput({ total, count: sessions.length, sessions })
    return
  }

  printHeader(`SESSIONS (${sessions.length}/${total})`)
  if (sessions.length === 0) {
    console.log(`  ${c.dim}(no matching sessions)${c.reset}`)
    return
  }

  const rows = sessions.map(s => {
    const firstPrompt = s.prompts?.[0]?.text ?? ''
    return [
      truncId(s.sessionId),
      formatAge(s.lastActivity),
      String(s.memories.length),
      String(s.injectionCount ?? 0),
      s.hasReview ? `${c.green}yes${c.reset}` : `${c.dim}no${c.reset}`,
      truncStr(s.cwd ?? '(none)', 30),
      truncStr(firstPrompt, 40)
    ]
  })
  printTable(['Session', 'Last', 'Mem', 'Inj', 'Rev', 'cwd', 'First prompt'], rows)
  console.log()
}

async function cmdSession(args: string[]): Promise<void> {
  const sessionId = args[0]
  if (!sessionId) {
    console.error(`${c.red}Usage:${c.reset} pnpm debug session <sessionId>`)
    process.exit(1)
  }

  const config = loadConfig(process.cwd())
  const session = loadSessionTracking(sessionId, config.lancedb.table)
  if (!session) {
    console.error(`${c.red}Session not found:${c.reset} ${sessionId}`)
    process.exit(1)
  }

  const memories = dedupeInjectedMemories(session.memories)
  const review = getInjectionReview(sessionId, config.lancedb.table)

  if (jsonMode) {
    jsonOutput({ session: { ...session, memories }, review })
    return
  }

  printHeader(`SESSION: ${session.sessionId}`)
  printStat('Created', formatAge(session.createdAt))
  printStat('Last activity', formatAge(session.lastActivity))
  printStat('cwd', session.cwd ?? '(none)')
  printStat('Prompt count', session.promptCount ?? session.prompts?.length ?? 0)
  printStat('Injection count', session.injectionCount ?? 0)
  printStat('Last status', session.lastStatus ?? '(unknown)')
  printStat('Has review', session.hasReview ? `${c.green}yes${c.reset}` : 'no')
  console.log()

  printSection(`Injected memories (${memories.length})`)
  for (const m of memories) {
    console.log(`  ${typeBadge(m.type ?? 'discovery')} ${truncId(m.id)} ${truncStr(m.snippet, 70)}`)
    const parts: string[] = []
    if (m.similarity !== undefined) parts.push(`sim=${m.similarity.toFixed(3)}`)
    if (m.keywordMatch) parts.push('kw')
    if (m.score !== undefined) parts.push(`score=${m.score.toFixed(3)}`)
    parts.push(formatAge(m.injectedAt))
    console.log(`    ${c.dim}${parts.join(' | ')}${c.reset}`)
  }
  console.log()

  if (review) {
    printSection('Injection review')
    printStat('  Rating', review.overallRating)
    printStat('  Relevance score', review.relevanceScore.toFixed(3))
    printStat('  Model', review.model)
    printStat('  Reviewed', formatAge(review.reviewedAt))
    console.log(`\n  ${c.dim}${truncStr(review.summary, 200)}${c.reset}`)
    console.log()
  } else {
    console.log(`  ${c.dim}(no review stored; run \`pnpm debug review-session ${truncId(sessionId)}\`)${c.reset}\n`)
  }
}

// ---------------------------------------------------------------------------
// Extractions
// ---------------------------------------------------------------------------

async function cmdExtractions(): Promise<void> {
  if (flagBool('in-progress') === true) {
    const inProgress = listInProgressExtractions()
    if (jsonMode) {
      jsonOutput({ inProgress })
      return
    }
    printHeader(`IN-PROGRESS EXTRACTIONS (${inProgress.length})`)
    if (inProgress.length === 0) {
      console.log(`  ${c.dim}(none)${c.reset}\n`)
      return
    }
    const rows = inProgress.map(ip => [
      truncId(ip.sessionId),
      String(ip.pid),
      `${(ip.elapsedMs / 1000).toFixed(1)}s`
    ])
    printTable(['Session', 'PID', 'Elapsed'], rows)
    console.log()
    return
  }

  const config = loadConfig(process.cwd())
  const limit = flagNum('limit') ?? 25
  const offset = flagNum('offset') ?? 0
  const session = flagStr('session')
  const sinceCutoff = parseSinceFlag(flagStr('since'))

  let page = paginateExtractionRuns(config.lancedb.table, limit, offset, session)
  if (sinceCutoff !== undefined) {
    const filtered = page.runs.filter(r => r.timestamp >= sinceCutoff)
    page = { ...page, runs: filtered, count: filtered.length }
  }

  if (jsonMode) {
    jsonOutput(page)
    return
  }

  printHeader(`EXTRACTIONS (${page.count}/${page.total}, offset ${page.offset})`)
  if (page.runs.length === 0) {
    console.log(`  ${c.dim}(no matching runs)${c.reset}\n`)
    return
  }
  const rows = page.runs.map(r => [
    truncId(r.runId),
    truncId(r.sessionId),
    formatAge(r.timestamp),
    String(r.recordCount),
    `${(r.duration / 1000).toFixed(1)}s`,
    r.isIncremental ? `${c.cyan}inc${c.reset}` : '',
    r.skipReason ?? '',
  ])
  printTable(['Run', 'Session', 'When', 'Recs', 'Dur', 'Inc', 'Skip'], rows)
  console.log()
}

async function cmdExtraction(args: string[]): Promise<void> {
  const runId = args[0]
  if (!runId) {
    console.error(`${c.red}Usage:${c.reset} pnpm debug extraction <runId>`)
    process.exit(1)
  }

  const config = loadConfig(process.cwd())
  const detail = await loadExtractionRunDetail(runId, config, { includeRecords: true, includeReview: true })
  if (!detail) {
    console.error(`${c.red}Extraction run not found:${c.reset} ${runId}`)
    process.exit(1)
  }

  if (jsonMode) {
    jsonOutput(detail)
    return
  }

  const { run, records = [], review } = detail
  printHeader(`EXTRACTION: ${run.runId}`)
  printStat('Session', run.sessionId)
  printStat('Timestamp', `${formatAge(run.timestamp)} (${new Date(run.timestamp).toISOString()})`)
  printStat('Duration', `${(run.duration / 1000).toFixed(2)}s`)
  printStat('Records', run.recordCount)
  printStat('Inserted', (run.extractedRecordIds ?? []).length)
  printStat('Updated', (run.updatedRecordIds ?? []).length)
  printStat('Parse errors', run.parseErrorCount)
  printStat('Incremental', run.isIncremental ? `${c.cyan}yes${c.reset}` : 'no')
  if (run.skipReason) printStat('Skip reason', `${c.yellow}${run.skipReason}${c.reset}`)
  if (run.hasRememberMarker) printStat('Remember marker', `${c.cyan}yes${c.reset}`)
  if (run.tokenUsage) {
    printStat('Input tokens', run.tokenUsage.inputTokens ?? 0)
    printStat('Output tokens', run.tokenUsage.outputTokens ?? 0)
  }
  console.log()

  if (records.length > 0) {
    printSection(`Records (${records.length})`)
    for (const rec of records) {
      const summary = getRecordSummary(rec) ?? '(no summary)'
      console.log(`  ${typeBadge(rec.type)} ${truncId(rec.id)} ${truncStr(summary, 70)}`)
    }
    console.log()
  }

  if (review) {
    printSection('Extraction review')
    printStat('  Rating', review.overallRating)
    printStat('  Accuracy', review.accuracyScore.toFixed(1))
    printStat('  Issues', review.issues.length)
    printStat('  Model', review.model)
    printStat('  Reviewed', formatAge(review.reviewedAt))
    console.log(`\n  ${c.dim}${truncStr(review.summary, 200)}${c.reset}`)
    console.log()
  } else {
    console.log(`  ${c.dim}(no review stored; run \`pnpm debug review-extraction ${truncId(runId)}\`)${c.reset}\n`)
  }
}

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

function makeThinkingHandler(): (chunk: string) => void {
  if (jsonMode) return () => {}
  process.stderr.write(`${c.dim}`)
  return (chunk: string) => process.stderr.write(chunk)
}

function endThinking(): void {
  if (!jsonMode) process.stderr.write(`${c.reset}\n`)
}

async function cmdReviewSession(args: string[]): Promise<void> {
  const sessionId = args[0]
  if (!sessionId) {
    console.error(`${c.red}Usage:${c.reset} pnpm debug review-session <sessionId> [--force] [--no-stream]`)
    process.exit(1)
  }

  const config = loadConfig(process.cwd())
  const force = flagBool('force') === true
  const stream = flagBool('stream') !== false

  const existing = getInjectionReview(sessionId, config.lancedb.table)
  if (existing && !force) {
    if (jsonMode) {
      jsonOutput(existing)
      return
    }
    printHeader(`CACHED INJECTION REVIEW: ${sessionId}`)
    printInjectionReview(existing)
    console.log(`  ${c.dim}(cached; pass --force to re-run)${c.reset}\n`)
    return
  }

  if (!jsonMode) {
    console.error(`${c.dim}Running injection review for ${truncId(sessionId)}...${c.reset}`)
  }
  let review: InjectionReview
  if (stream) {
    const onThinking = makeThinkingHandler()
    try {
      review = await reviewInjectionStreaming(sessionId, config, onThinking)
    } finally {
      endThinking()
    }
  } else {
    review = await reviewInjection(sessionId, config)
  }
  saveInjectionReview(review, config.lancedb.table)

  if (jsonMode) {
    jsonOutput(review)
    return
  }
  printHeader(`INJECTION REVIEW: ${sessionId}`)
  printInjectionReview(review)
}

async function cmdReviewExtraction(args: string[]): Promise<void> {
  const runId = args[0]
  if (!runId) {
    console.error(`${c.red}Usage:${c.reset} pnpm debug review-extraction <runId> [--force] [--no-stream]`)
    process.exit(1)
  }

  const config = loadConfig(process.cwd())
  const force = flagBool('force') === true
  const stream = flagBool('stream') !== false

  const existing = getReview(runId, config.lancedb.table)
  if (existing && !force) {
    if (jsonMode) {
      jsonOutput(existing)
      return
    }
    printHeader(`CACHED EXTRACTION REVIEW: ${runId}`)
    printExtractionReview(existing)
    console.log(`  ${c.dim}(cached; pass --force to re-run)${c.reset}\n`)
    return
  }

  if (!jsonMode) {
    console.error(`${c.dim}Running extraction review for ${truncId(runId)}...${c.reset}`)
  }
  let review: ExtractionReview
  if (stream) {
    const onThinking = makeThinkingHandler()
    try {
      review = await reviewExtractionStreaming(runId, config, onThinking)
    } finally {
      endThinking()
    }
  } else {
    review = await reviewExtraction(runId, config)
  }
  saveReview(review, config.lancedb.table)

  if (jsonMode) {
    jsonOutput(review)
    return
  }
  printHeader(`EXTRACTION REVIEW: ${runId}`)
  printExtractionReview(review)
}

function printInjectionReview(review: InjectionReview): void {
  printStat('Rating', review.overallRating)
  printStat('Relevance score', review.relevanceScore.toFixed(3))
  printStat('Model', review.model)
  printStat('Duration', `${(review.durationMs / 1000).toFixed(1)}s`)
  console.log()

  if (review.injectedVerdicts.length > 0) {
    printSection(`Injected verdicts (${review.injectedVerdicts.length})`)
    for (const v of review.injectedVerdicts) {
      const color = v.verdict === 'relevant' ? c.green : v.verdict === 'irrelevant' ? c.red : c.yellow
      console.log(`  ${color}${v.verdict}${c.reset} ${truncId(v.id)} ${truncStr(v.snippet, 60)}`)
      console.log(`    ${c.dim}${truncStr(v.reason, 100)}${c.reset}`)
    }
    console.log()
  }

  if (review.missedMemories.length > 0) {
    printSection(`Missed memories (${review.missedMemories.length})`)
    for (const m of review.missedMemories) {
      console.log(`  ${c.yellow}*${c.reset} ${truncId(m.id)} ${truncStr(m.snippet, 60)}`)
      console.log(`    ${c.dim}${truncStr(m.reason, 100)}${c.reset}`)
    }
    console.log()
  }

  printSection('Summary')
  console.log(`  ${review.summary}\n`)
}

function printExtractionReview(review: ExtractionReview): void {
  printStat('Rating', review.overallRating)
  printStat('Accuracy score', review.accuracyScore.toFixed(1))
  printStat('Issues', review.issues.length)
  printStat('Model', review.model)
  printStat('Duration', `${(review.durationMs / 1000).toFixed(1)}s`)
  console.log()

  if (review.issues.length > 0) {
    printSection(`Issues (${review.issues.length})`)
    for (const issue of review.issues) {
      const sevColor = issue.severity === 'critical' ? c.red : issue.severity === 'major' ? c.yellow : c.dim
      const target = issue.recordId ? ` ${truncId(issue.recordId)}` : ''
      console.log(`  ${sevColor}[${issue.severity}]${c.reset} ${c.bold}${issue.type}${c.reset}${target}`)
      console.log(`    ${truncStr(issue.description, 120)}`)
      if (issue.evidence) console.log(`    ${c.dim}evidence: ${truncStr(issue.evidence, 100)}${c.reset}`)
      if (issue.suggestedFix) console.log(`    ${c.green}fix: ${truncStr(issue.suggestedFix, 100)}${c.reset}`)
    }
    console.log()
  }

  printSection('Summary')
  console.log(`  ${review.summary}\n`)
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function printRecordDetail(record: MemoryRecord): void {
  printStat('ID', record.id)
  printStat('Type', typeBadge(record.type))
  printStat('Scope', (record.scope ?? 'project') === 'global' ? `${c.cyan}global${c.reset}` : 'project')
  printStat('Project', record.project ?? '(none)')
  printStat('Deprecated', record.deprecated ? `${c.red}yes${c.reset}` : 'no')
  if (record.sourceSessionId) printStat('Source session', truncId(record.sourceSessionId))
  if (record.supersedes) printStat('Supersedes', record.supersedes)
  console.log()
}

function printMaintenanceResult(title: string, result: MaintenanceRunResult): void {
  printHeader(title)

  if (result.error) {
    console.log(`  ${c.red}Error: ${result.error}${c.reset}`)
  }

  // Summary metrics
  printSection('Summary')
  for (const [key, value] of Object.entries(result.summary)) {
    printStat(`  ${key}`, value)
  }
  console.log()

  // Candidate groups
  if (result.candidates.length > 0) {
    printSection(`Candidates (${result.candidates.length} groups)`)
    for (const group of result.candidates.slice(0, 20)) {
      console.log(`\n  ${c.bold}${group.label}${c.reset}${group.reason ? ` — ${c.dim}${group.reason}${c.reset}` : ''}`)
      for (const rec of group.records) {
        const details = rec.details
          ? Object.entries(rec.details).map(([k, v]) => `${k}=${typeof v === 'number' ? (v as number).toFixed(4) : v}`).join(', ')
          : ''
        console.log(`    ${c.dim}*${c.reset} ${truncId(rec.id)} ${typeBadge(rec.type)} ${truncStr(rec.snippet, 50)}`)
        if (details) console.log(`      ${c.dim}${details}${c.reset}`)
        if (rec.reason) console.log(`      ${c.yellow}${rec.reason}${c.reset}`)
      }
    }
    if (result.candidates.length > 20) {
      console.log(`\n  ${c.dim}... and ${result.candidates.length - 20} more groups${c.reset}`)
    }
    console.log()
  }

  // Actions
  if (result.actions.length > 0) {
    printSection(`Actions (${result.actions.length})`)
    for (const action of result.actions.slice(0, 30)) {
      const icon = action.type === 'deprecate' ? c.red
        : action.type === 'promote' ? c.green
        : action.type === 'merge' ? c.blue
        : c.yellow
      console.log(`  ${icon}${action.type}${c.reset} ${action.recordId ? truncId(action.recordId) : ''} ${truncStr(action.snippet, 60)}`)
      console.log(`    ${c.dim}${action.reason}${c.reset}`)
      if (action.details?.keptId) {
        console.log(`    ${c.dim}kept: ${truncId(action.details.keptId)}${c.reset}`)
      }
      if (action.details?.deprecatedIds) {
        console.log(`    ${c.dim}deprecated: ${action.details.deprecatedIds.map(truncId).join(', ')}${c.reset}`)
      }
    }
    if (result.actions.length > 30) {
      console.log(`\n  ${c.dim}... and ${result.actions.length - 30} more actions${c.reset}`)
    }
    console.log()
  }
}

function serializeRecord(record: MemoryRecord): Record<string, unknown> {
  const rec = record as unknown as Record<string, unknown>
  const { embedding, ...rest } = rec as Record<string, unknown> & { embedding?: number[] }
  return {
    ...rest,
    usageRatio: computeUsageRatio(record),
    hasEmbedding: Boolean(embedding && embedding.length > 0)
  }
}

function serializeSearchResult(sr: HybridSearchResult | { record: MemoryRecord; score: number; similarity: number; keywordMatch: boolean }): Record<string, unknown> {
  return {
    id: sr.record.id,
    type: sr.record.type,
    score: sr.score,
    similarity: sr.similarity,
    keywordMatch: sr.keywordMatch,
    usageRatio: computeUsageRatio(sr.record),
    summary: getRecordSummary(sr.record)
  }
}

function stripEmbedding(record: MemoryRecord): MemoryRecord {
  const rec = record as unknown as Record<string, unknown> & { embedding?: number[] }
  const { embedding, ...rest } = rec
  return rest as unknown as MemoryRecord
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.log(`
${c.bold}claude-memory debug CLI${c.reset}

${c.cyan}Usage:${c.reset} pnpm debug <command> [options]

${c.cyan}Memory pool:${c.reset}
  stats                     Memory pool statistics
  search <query>            Run retrieval with full diagnostics
  similar <id>              Find records similar to a given ID
  consolidation             Dry-run consolidation analysis
  deprecation               Dry-run all deprecation phases
  promotion                 Dry-run global promotion
  record <id>               Show full record details
  export                    Export all records
  embedding <text>          Generate embedding for text
  compare <id1> <id2>       Compare two records (cosine similarity)
  settings                  Show resolved settings and config

${c.cyan}Sessions:${c.reset}
  sessions                  List injection sessions
  session <sessionId>       Show session detail (memories + cached review)

${c.cyan}Extractions:${c.reset}
  extractions               List extraction runs (or --in-progress for live)
  extraction <runId>        Show extraction run detail (records + cached review)

${c.cyan}Reviews (opus):${c.reset}
  review-session <id>       Run injection review, stream thinking to stderr
  review-extraction <id>    Run extraction review, stream thinking to stderr

${c.cyan}Global Options:${c.reset}
  --json                    Machine-readable JSON output
  --help                    Show this help

${c.cyan}Search Options:${c.reset}
  --cwd <path>              Working directory (default: cwd)
  --no-haiku                Disable Haiku query planning
  --max-records <n>         Override maxRecords setting
  --min-score <n>           Override minScore setting
  --mmr-lambda <n>          Override mmrLambda setting

${c.cyan}Similar Options:${c.reset}
  --threshold <n>           Similarity threshold (default: 0.5)
  --limit <n>               Max results (default: 10)

${c.cyan}Sessions Options:${c.reset}
  --search <text>           Substring match on sessionId / cwd / prompts
  --project <name>          Filter by project name in cwd
  --has-review / --no-has-review   Filter by review presence
  --since <12h|7d>          Only sessions active within window
  --limit <n>               Max results (default: 25)

${c.cyan}Extractions Options:${c.reset}
  --session <id>            Server-side sessionId substring filter
  --since <12h|7d>          Only runs within window
  --limit <n>               Page size (default: 25)
  --offset <n>              Page offset (default: 0)
  --in-progress             Show live lock files instead of run history

${c.cyan}Review Options:${c.reset}
  --force                   Re-run even if cached review exists
  --no-stream               Disable thinking stream (faster non-interactive)

${c.cyan}Export Options:${c.reset}
  --format json|jsonl       Output format (default: json)
  --include-embeddings      Include embedding vectors
  --filter <expr>           SQL filter expression (DataFusion)

${c.cyan}Embedding Options:${c.reset}
  --full                    Include full vector in JSON output
`)
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
main().catch(error => {
  console.error(`${c.red}Fatal error:${c.reset}`, error.message ?? error)
  process.exit(1)
})
