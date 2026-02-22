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
  initMilvus,
  closeMilvus,
  getRecord,
  findSimilar,
  iterateRecords,
  computeUsageRatio
} from '../src/lib/milvus.js'
import { type Config, type MemoryRecord, type HybridSearchResult } from '../src/lib/types.js'
import { retrieveContext } from '../src/lib/retrieval.js'
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
  'threshold', 'limit', 'format', 'filter'
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

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
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
}

const NO_MILVUS_COMMANDS = new Set(['settings', 'help', 'embedding'])

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
  if (!NO_MILVUS_COMMANDS.has(command)) {
    await initMilvus(config)
  }

  try {
    await handler(positionalArgs, flags)
  } finally {
    if (!NO_MILVUS_COMMANDS.has(command)) {
      await closeMilvus()
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

  printSection('By Domain')
  const domains = Object.entries(stats.byDomain).sort((a, b) => b[1] - a[1])
  for (const [domain, count] of domains.slice(0, 15)) {
    printStat(`  ${domain}`, count)
  }
  if (domains.length > 15) {
    console.log(`  ${c.dim}  ... and ${domains.length - 15} more${c.reset}`)
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
  printStat('Domain', result.signals.domain ?? '(none)')
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
      console.log()
      printSection(`Score breakdown (#1)`)
      const semanticComponent = top.similarity * 0.7
      const keywordComponent = top.keywordMatch ? (settings.keywordBonus ?? 0.08) : 0
      const usageComponent = usageRatio * (settings.usageRatioWeight ?? 0.2)
      printStat('  semantic', `${top.similarity.toFixed(4)} * 0.7 = ${semanticComponent.toFixed(4)}`)
      printStat('  keyword bonus', `${keywordComponent.toFixed(4)}`)
      printStat('  usage ratio', `${usageRatio.toFixed(4)} * ${settings.usageRatioWeight ?? 0.2} = ${usageComponent.toFixed(4)}`)
      printStat('  computed total', `${(semanticComponent + keywordComponent + usageComponent).toFixed(4)}`)
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
    ['Domain', r => r.domain ?? '(none)'],
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
  printStat('milvus.address', config.milvus.address)
  printStat('milvus.collection', config.milvus.collection)
  printStat('embeddings.baseUrl', config.embeddings.baseUrl)
  printStat('embeddings.model', config.embeddings.model)
  printStat('extraction.model', config.extraction.model)
  printStat('injection.maxRecords', config.injection.maxRecords)
  printStat('injection.maxTokens', config.injection.maxTokens)
  console.log()
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function printRecordDetail(record: MemoryRecord): void {
  printStat('ID', record.id)
  printStat('Type', typeBadge(record.type))
  printStat('Scope', (record.scope ?? 'project') === 'global' ? `${c.cyan}global${c.reset}` : 'project')
  printStat('Project', record.project ?? '(none)')
  printStat('Domain', record.domain ?? '(none)')
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

${c.cyan}Commands:${c.reset}
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

${c.cyan}Export Options:${c.reset}
  --format json|jsonl       Output format (default: json)
  --include-embeddings      Include embedding vectors
  --filter <expr>           Milvus filter expression

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
