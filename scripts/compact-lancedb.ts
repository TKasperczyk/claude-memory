#!/usr/bin/env -S npx tsx
/**
 * Inspect or explicitly optimize a local LanceDB table.
 *
 * Dry-run and compaction-only are the defaults. History pruning requires both
 * --apply, an explicit retention argument, and an interactive confirmation.
 * deleteUnverified is intentionally always false.
 *
 * Usage:
 *   pnpm storage:compact
 *   pnpm storage:compact -- --apply
 *   pnpm storage:compact -- --apply --prune-older-than-days 30
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { connect } from '@lancedb/lancedb'
import { loadConfig } from '../src/lib/config.js'
import { resolveDirectory } from '../src/lib/lancedb-client.js'
import { PROJECT_ROOT } from '../src/lib/paths.js'
import { isProcessEntrypoint } from '../src/lib/shared.js'
import type { Config } from '../src/lib/types.js'

const MIN_ADDITIONAL_HEADROOM_BYTES = 512n * 1024n * 1024n
const MIN_PRUNE_RETENTION_DAYS = 7
const PROCESS_CHECK_TIMEOUT_MS = 30_000
const PROCESS_CHECK_MAX_BUFFER_BYTES = 4 * 1024 * 1024
const COLLECTION_NAME_RE = /^[A-Za-z0-9_.-]+$/

export interface CompactCliArgs {
  apply: boolean
  collection?: string
  help: boolean
  pruneOlderThanDays?: number
}

type ProcessReference = {
  pid: number
  command: string
  source: 'lsof' | 'known-process'
}

type ProcessInspection = {
  available: boolean
  error?: string
  processes: ProcessReference[]
}

type LsofResult = {
  error?: Error
  status: number | null
  stderr: string
  stdout: string
}

type PreflightResult = {
  tablePath: string
  tableBytes: bigint
  availableBytes: bigint
  requiredFreeBytes: bigint
  diskHeadroomOk: boolean
  processChecksAvailable: boolean
  processes: ProcessReference[]
  errors: string[]
}

export function parseCompactArgs(argv: string[]): CompactCliArgs {
  const parsed: CompactCliArgs = { apply: false, help: false }
  let modeSeen: 'apply' | 'dry-run' | undefined

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--') continue
    if (arg === '--apply' || arg === '--dry-run') {
      const mode = arg === '--apply' ? 'apply' : 'dry-run'
      if (modeSeen && modeSeen !== mode) throw new Error('Choose either --apply or --dry-run, not both')
      modeSeen = mode
      parsed.apply = mode === 'apply'
      continue
    }

    if (arg === '--collection') {
      const value = argv[i + 1]
      if (!value || value.startsWith('--')) throw new Error('--collection requires a collection name')
      parsed.collection = value
      i += 1
      continue
    }

    if (arg === '--prune-older-than-days') {
      const raw = argv[i + 1]
      const days = raw === undefined ? Number.NaN : Number(raw)
      if (!Number.isInteger(days) || days < MIN_PRUNE_RETENTION_DAYS) {
        throw new Error(`--prune-older-than-days must be an integer of at least ${MIN_PRUNE_RETENTION_DAYS}`)
      }
      parsed.pruneOlderThanDays = days
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
  return `Usage: pnpm storage:compact -- [options]

Options:
  --dry-run                         Inspect only (default)
  --apply                           Run compaction
  --collection <name>               Override the configured collection
  --prune-older-than-days <days>     Also remove untagged history older than this cutoff (minimum 7)
  --help, -h                         Show this help

Safety:
  - Without --prune-older-than-days, history cleanup is disabled.
  - History pruning requires an exact interactive confirmation.
  - deleteUnverified is always false.
  - Apply mode refuses to run with open-handle/process hazards or insufficient disk headroom.`
}

export function requiredFreeBytes(tableBytes: bigint): bigint {
  return tableBytes + MIN_ADDITIONAL_HEADROOM_BYTES
}

function directorySizeBytes(directory: string): bigint {
  let total = 0n
  const visit = (entryPath: string): void => {
    const stats = fs.lstatSync(entryPath, { bigint: true })
    if (!stats.isDirectory()) {
      total += stats.size
      return
    }
    for (const entry of fs.readdirSync(entryPath, { withFileTypes: true })) {
      visit(path.join(entryPath, entry.name))
    }
  }
  visit(directory)
  return total
}

export function parseLsofProcesses(output: string): ProcessReference[] {
  const byPid = new Map<number, ProcessReference>()
  let currentPid: number | undefined

  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('p')) {
      const pid = Number(line.slice(1))
      currentPid = Number.isInteger(pid) ? pid : undefined
      if (currentPid !== undefined && currentPid !== process.pid) {
        byPid.set(currentPid, { pid: currentPid, command: 'unknown', source: 'lsof' })
      }
      continue
    }
    if (line.startsWith('c') && currentPid !== undefined && currentPid !== process.pid) {
      const existing = byPid.get(currentPid)
      if (existing) existing.command = line.slice(1) || 'unknown'
    }
  }

  return Array.from(byPid.values())
}

function containsPath(parentPath: string, childPath: string): boolean {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath))
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function hasOnlyUnrelatedLsofWarnings(stderr: string, tablePath: string): boolean {
  const lines = stderr.split(/\r?\n/).filter(line => line.trim().length > 0)
  if (lines.length === 0) return false

  for (let index = 0; index < lines.length; index += 2) {
    const warning = lines[index]
    const continuation = lines[index + 1]
    const match = warning?.match(/^lsof: WARNING: can't stat\(\) .+ file system (.+)$/)
    if (!match || continuation?.trim() !== 'Output information may be incomplete.') return false

    const warningPath = match[1].trim()
    if (!path.isAbsolute(warningPath)) return false
    if (containsPath(warningPath, tablePath) || containsPath(tablePath, warningPath)) return false
  }

  return true
}

export function classifyLsofResult(result: LsofResult, tablePath: string): ProcessInspection {
  if (result.error) {
    return { available: false, error: result.error.message, processes: [] }
  }

  const noMatches = result.status === 1
    && !result.stdout.trim()
    && (!result.stderr.trim() || hasOnlyUnrelatedLsofWarnings(result.stderr, tablePath))
  if (result.status !== 0 && !noMatches) {
    return {
      available: false,
      error: result.stderr.trim() || `lsof exited with status ${result.status ?? 'unknown'}`,
      processes: []
    }
  }
  return { available: true, processes: parseLsofProcesses(result.stdout) }
}

function inspectOpenHandles(tablePath: string): ProcessInspection {
  const result = spawnSync('lsof', ['-F', 'pc', '+D', tablePath], {
    encoding: 'utf-8',
    timeout: PROCESS_CHECK_TIMEOUT_MS,
    maxBuffer: PROCESS_CHECK_MAX_BUFFER_BYTES,
    stdio: ['ignore', 'pipe', 'pipe']
  })

  return classifyLsofResult(result, tablePath)
}

function inspectKnownClaudeMemoryProcesses(): ProcessInspection {
  const result = spawnSync('ps', ['-eo', 'pid=,args='], {
    encoding: 'utf-8',
    timeout: PROCESS_CHECK_TIMEOUT_MS,
    maxBuffer: PROCESS_CHECK_MAX_BUFFER_BYTES,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (result.error || result.status !== 0) {
    return {
      available: false,
      error: result.error?.message || result.stderr.trim() || `ps exited with status ${result.status ?? 'unknown'}`,
      processes: []
    }
  }

  const rootPrefix = `${PROJECT_ROOT}${path.sep}`
  const processes: ProcessReference[] = []
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/)
    if (!match) continue
    const pid = Number(match[1])
    const command = match[2]
    if (!Number.isInteger(pid) || pid === process.pid) continue

    const isKnownEntrypoint = command.includes(`${rootPrefix}dist${path.sep}mcp-server.js`)
      || command.includes(`${rootPrefix}src${path.sep}mcp-server.ts`)
      || command.includes(`${rootPrefix}dist${path.sep}maintenance.js`)
      || command.includes(`${rootPrefix}src${path.sep}maintenance.ts`)
      || command.includes(`${rootPrefix}dist${path.sep}hooks${path.sep}pre-prompt.js`)
      || command.includes(`${rootPrefix}dist${path.sep}hooks${path.sep}post-session-worker.js`)
      || command.includes(`${rootPrefix}src${path.sep}hooks${path.sep}pre-prompt`)
      || command.includes(`${rootPrefix}src${path.sep}hooks${path.sep}post-session-worker`)
      || command.includes(`${rootPrefix}dashboard${path.sep}server${path.sep}index.ts`)
    if (isKnownEntrypoint) {
      processes.push({ pid, command, source: 'known-process' })
    }
  }
  return { available: true, processes }
}

function mergeProcesses(...groups: ProcessReference[][]): ProcessReference[] {
  const byPid = new Map<number, ProcessReference>()
  for (const processGroup of groups) {
    for (const reference of processGroup) {
      const existing = byPid.get(reference.pid)
      if (!existing || existing.command === 'unknown') byPid.set(reference.pid, reference)
    }
  }
  return Array.from(byPid.values()).sort((left, right) => left.pid - right.pid)
}

function runPreflight(tablePath: string): PreflightResult {
  const tableBytes = directorySizeBytes(tablePath)
  const filesystem = fs.statfsSync(tablePath, { bigint: true })
  const availableBytes = filesystem.bavail * filesystem.bsize
  const required = requiredFreeBytes(tableBytes)
  const handleInspection = inspectOpenHandles(tablePath)
  const knownProcessInspection = inspectKnownClaudeMemoryProcesses()
  const errors = [handleInspection.error, knownProcessInspection.error]
    .filter((error): error is string => Boolean(error))

  return {
    tablePath,
    tableBytes,
    availableBytes,
    requiredFreeBytes: required,
    diskHeadroomOk: availableBytes >= required,
    processChecksAvailable: handleInspection.available && knownProcessInspection.available,
    processes: mergeProcesses(handleInspection.processes, knownProcessInspection.processes),
    errors
  }
}

function formatBytes(bytes: bigint): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let value = Number(bytes)
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`
}

function printPreflight(result: PreflightResult): void {
  console.log(`Table path: ${result.tablePath}`)
  console.log(`Table files: ${formatBytes(result.tableBytes)}`)
  console.log(`Available disk: ${formatBytes(result.availableBytes)}`)
  console.log(`Required free disk: ${formatBytes(result.requiredFreeBytes)}`)
  console.log(`Disk headroom: ${result.diskHeadroomOk ? 'PASS' : 'FAIL'}`)
  console.log(`Process checks: ${result.processChecksAvailable ? 'PASS' : 'UNAVAILABLE'}`)
  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(`Process check error: ${error}`)
  }
  if (result.processes.length === 0) {
    console.log('Other LanceDB/claude-memory processes: none detected')
  } else {
    console.error('Other LanceDB/claude-memory processes detected:')
    for (const reference of result.processes) {
      console.error(`  PID ${reference.pid} [${reference.source}] ${reference.command}`)
    }
  }
}

function assertSafeToApply(result: PreflightResult): void {
  if (!result.processChecksAvailable) {
    throw new Error('Cannot verify open handles and claude-memory processes; refusing apply mode')
  }
  if (result.processes.length > 0) {
    throw new Error('Stop the listed dashboard, MCP, hook, or database-handle processes before applying')
  }
  if (!result.diskHeadroomOk) {
    throw new Error('Insufficient disk headroom for compaction before old files can be removed')
  }
}

type CompactRuntime = {
  connect: typeof connect
  cwd: () => string
  inputIsTTY: () => boolean
  loadConfig: typeof loadConfig
  question: (prompt: string) => Promise<string>
  resolveLocalTablePath: typeof resolveLocalTablePath
  runPreflight: typeof runPreflight
  outputIsTTY: () => boolean
}

async function confirmHistoryPrune(
  collection: string,
  days: number,
  runtime: Pick<CompactRuntime, 'inputIsTTY' | 'outputIsTTY' | 'question'>
): Promise<boolean> {
  if (!runtime.inputIsTTY() || !runtime.outputIsTTY()) {
    throw new Error('History pruning requires an interactive terminal confirmation')
  }
  const phrase = `PRUNE ${collection}`
  const answer = await runtime.question(
    `This permanently removes untagged versions older than ${days} days. Confirm a backup exists, then type "${phrase}": `
  )
  return answer === phrase
}

function resolveLocalTablePath(config: Config): { directory: string; tablePath: string } {
  const directory = resolveDirectory(config.lancedb.directory)
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(directory)) {
    throw new Error('This safety wrapper supports local LanceDB directories only')
  }
  const tablePath = path.join(directory, `${config.lancedb.table}.lance`)
  if (!fs.existsSync(tablePath) || !fs.statSync(tablePath).isDirectory()) {
    throw new Error(`LanceDB table directory does not exist: ${tablePath}`)
  }
  return { directory, tablePath: fs.realpathSync(tablePath) }
}

async function askInteractiveQuestion(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await rl.question(prompt)
  } finally {
    rl.close()
  }
}

const DEFAULT_RUNTIME: CompactRuntime = {
  connect,
  cwd: () => process.cwd(),
  inputIsTTY: () => Boolean(process.stdin.isTTY),
  loadConfig,
  outputIsTTY: () => Boolean(process.stdout.isTTY),
  question: askInteractiveQuestion,
  resolveLocalTablePath,
  runPreflight
}

export async function main(
  argv = process.argv.slice(2),
  runtimeOverrides: Partial<CompactRuntime> = {}
): Promise<void> {
  const runtime = { ...DEFAULT_RUNTIME, ...runtimeOverrides }
  const args = parseCompactArgs(argv)
  if (args.help) {
    console.log(usage())
    return
  }

  const baseConfig = runtime.loadConfig(runtime.cwd())
  const collection = args.collection ?? baseConfig.lancedb.table
  if (!COLLECTION_NAME_RE.test(collection)) throw new Error(`Invalid collection name: ${collection}`)
  const config: Config = {
    ...baseConfig,
    lancedb: { ...baseConfig.lancedb, table: collection }
  }
  const { directory, tablePath } = runtime.resolveLocalTablePath(config)
  const operation = args.pruneOlderThanDays === undefined
    ? 'compact only; retain all existing history'
    : `compact and prune untagged history older than ${args.pruneOlderThanDays} days`

  console.log(`Mode: ${args.apply ? 'apply' : 'dry-run'}`)
  console.log(`Collection: ${collection}`)
  console.log(`Operation: ${operation}`)
  console.log('deleteUnverified: false')
  const initialPreflight = runtime.runPreflight(tablePath)
  printPreflight(initialPreflight)

  if (!args.apply) {
    console.log('Dry-run complete; no LanceDB connection was opened and no files were changed.')
    return
  }
  assertSafeToApply(initialPreflight)

  if (args.pruneOlderThanDays !== undefined) {
    const confirmed = await confirmHistoryPrune(collection, args.pruneOlderThanDays, runtime)
    if (!confirmed) {
      console.log('Cancelled; no files were changed.')
      return
    }
  }

  // Recheck after any confirmation delay to narrow the race with newly started hooks.
  const finalPreflight = runtime.runPreflight(tablePath)
  assertSafeToApply(finalPreflight)

  const connection = await runtime.connect(directory)
  let table: Awaited<ReturnType<typeof connection.openTable>> | undefined
  try {
    const tables = await connection.tableNames()
    if (!tables.includes(collection)) throw new Error(`Collection is not registered in LanceDB: ${collection}`)
    table = await connection.openTable(collection)
    const beforeRows = await table.countRows()
    const beforeVersion = await table.version()
    const beforeStats = await table.stats()
    // The JS SDK converts this cutoff date to a retention duration. Epoch means
    // "older than the age of the Unix epoch" and therefore retains all versions.
    const cleanupOlderThan = args.pruneOlderThanDays === undefined
      ? new Date(0)
      : new Date(Date.now() - args.pruneOlderThanDays * 24 * 60 * 60 * 1000)

    const result = await table.optimize({ cleanupOlderThan, deleteUnverified: false })
    await table.checkoutLatest()
    const afterRows = await table.countRows()
    const afterVersion = await table.version()
    const afterStats = await table.stats()
    if (afterRows !== beforeRows) {
      throw new Error(`Row-count verification failed: before=${beforeRows}, after=${afterRows}`)
    }

    console.log(`Rows verified: ${afterRows}`)
    console.log(`Version: ${beforeVersion} -> ${afterVersion}`)
    console.log(`Fragments: ${beforeStats.fragmentStats.numFragments} -> ${afterStats.fragmentStats.numFragments}`)
    console.log(`Small fragments: ${beforeStats.fragmentStats.numSmallFragments} -> ${afterStats.fragmentStats.numSmallFragments}`)
    console.log(`Compaction fragments removed/added: ${result.compaction.fragmentsRemoved}/${result.compaction.fragmentsAdded}`)
    console.log(`History versions removed: ${result.prune.oldVersionsRemoved}`)
    console.log(`History bytes removed: ${formatBytes(BigInt(result.prune.bytesRemoved))}`)
  } finally {
    table?.close()
    connection.close()
  }
}

if (isProcessEntrypoint(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
