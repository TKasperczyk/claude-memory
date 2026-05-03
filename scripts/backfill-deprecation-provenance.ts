/**
 * Backfill deprecation provenance from maintenance run logs.
 *
 * Usage:
 *   pnpm tsx scripts/backfill-deprecation-provenance.ts [--apply] [--collection <name>]
 */

import { pathToFileURL } from 'url'
import path from 'path'
import { loadConfig } from '../src/lib/config.js'
import { JsonStore } from '../src/lib/file-store.js'
import { batchUpdateRecords, closeLanceDB, fetchRecordsByIds, initLanceDB } from '../src/lib/lancedb.js'
import type { Config, MemoryRecord } from '../src/lib/types.js'

const MERGE_OPERATIONS = new Set(['consolidation', 'cross-type-consolidation'])
const DIRECT_OPERATIONS = new Set(['stale-unused-deprecation', 'low-usage-deprecation', 'low-usage'])

type ProvenanceKind = 'merge' | 'direct'

export interface DeprecationProvenance {
  id: string
  kind: ProvenanceKind
  operation: string
  timestamp: number
  reason: string
  supersedingRecordId?: string
  runId?: string
}

export interface ProvenanceStats {
  runsRead: number
  mergeLogEntries: number
  directLogEntries: number
  duplicateLogEntries: number
  mergePrecedenceReplacements: number
  uniqueRecords: number
  uniqueMergeRecords: number
  uniqueDirectRecords: number
}

export interface ProvenanceParseResult {
  byId: Map<string, DeprecationProvenance>
  stats: ProvenanceStats
}

interface CliArgs {
  apply: boolean
  collection?: string
  help: boolean
}

interface LoadedRuns {
  runs: unknown[]
  runCount: number
  logDir: string
}

interface BackfillPlan {
  recordsToUpdate: MemoryRecord[]
  examples: DeprecationProvenance[]
  stats: {
    alreadyHadMetadata: number
    alreadyHadMetadataMerge: number
    alreadyHadMetadataDirect: number
    notDeprecated: number
    notFound: number
    toUpdate: number
    toUpdateMerge: number
    toUpdateDirect: number
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function asTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return Math.trunc(parsed)
  }
  return undefined
}

function firstString(record: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!record) return undefined
  for (const key of keys) {
    const value = asString(record[key])
    if (value) return value
  }
  return undefined
}

function stringArrayFrom(record: Record<string, unknown> | undefined, keys: string[]): string[] {
  if (!record) return []

  const values: string[] = []
  for (const key of keys) {
    const raw = record[key]
    if (Array.isArray(raw)) {
      for (const entry of raw) {
        const value = asString(entry)
        if (value) values.push(value)
      }
    } else {
      const value = asString(raw)
      if (value) values.push(value)
    }
  }

  return values
}

function idsFromDeprecatedRecords(record: Record<string, unknown> | undefined): string[] {
  if (!record) return []

  const ids: string[] = []
  for (const key of ['deprecatedRecords', 'deprecated_records']) {
    const raw = record[key]
    if (!Array.isArray(raw)) continue

    for (const entry of raw) {
      if (!isRecord(entry)) continue
      const id = asString(entry.id)
      if (id) ids.push(id)
    }
  }
  return ids
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(value => value.trim() !== '')))
}

function addProvenance(
  byId: Map<string, DeprecationProvenance>,
  candidate: DeprecationProvenance,
  stats: Pick<ProvenanceStats, 'duplicateLogEntries' | 'mergePrecedenceReplacements'>
): void {
  const existing = byId.get(candidate.id)
  if (!existing) {
    byId.set(candidate.id, candidate)
    return
  }

  stats.duplicateLogEntries += 1

  if (candidate.kind === 'merge' && existing.kind === 'direct') {
    byId.set(candidate.id, candidate)
    stats.mergePrecedenceReplacements += 1
    return
  }

  if (candidate.kind === existing.kind && candidate.timestamp < existing.timestamp) {
    byId.set(candidate.id, candidate)
  }
}

function parseMergeAction(
  operation: string,
  action: Record<string, unknown>,
  timestamp: number,
  runId: string | undefined
): DeprecationProvenance[] {
  const details = isRecord(action.details) ? action.details : undefined
  const keeperId = firstString(details, ['keptId', 'keeperId', 'kept_id', 'keeper_id'])
    ?? firstString(action, ['keptId', 'keeperId', 'kept_id', 'keeper_id', 'recordId'])
  if (!keeperId) return []

  const deprecatedIds = uniqueStrings([
    ...stringArrayFrom(details, ['deprecatedIds', 'deprecated_ids']),
    ...idsFromDeprecatedRecords(details),
    ...stringArrayFrom(action, ['deprecatedIds', 'deprecated_ids', 'deprecatedId', 'deprecated_id'])
  ]).filter(id => id !== keeperId)

  return deprecatedIds.map(id => ({
    id,
    kind: 'merge' as const,
    operation,
    timestamp,
    reason: `${operation}:merged-into:${keeperId}`,
    supersedingRecordId: keeperId,
    runId
  }))
}

function parseDirectAction(
  operation: string,
  action: Record<string, unknown>,
  timestamp: number,
  runId: string | undefined
): DeprecationProvenance | null {
  const deprecatedId = firstString(action, ['recordId', 'deprecatedId', 'deprecated_id', 'id'])
  if (!deprecatedId) return null

  const originalReason = asString(action.reason)
  return {
    id: deprecatedId,
    kind: 'direct',
    operation,
    timestamp,
    reason: originalReason ? `${operation}:${originalReason}` : operation,
    runId
  }
}

export function collectDeprecationProvenance(runs: unknown[]): ProvenanceParseResult {
  const byId = new Map<string, DeprecationProvenance>()
  const stats: ProvenanceStats = {
    runsRead: runs.length,
    mergeLogEntries: 0,
    directLogEntries: 0,
    duplicateLogEntries: 0,
    mergePrecedenceReplacements: 0,
    uniqueRecords: 0,
    uniqueMergeRecords: 0,
    uniqueDirectRecords: 0
  }

  const sortedRuns = runs
    .filter(isRecord)
    .map(run => ({ run, timestamp: asTimestamp(run.timestamp) }))
    .filter((entry): entry is { run: Record<string, unknown>; timestamp: number } => entry.timestamp !== undefined)
    .sort((a, b) => a.timestamp - b.timestamp)

  for (const { run, timestamp } of sortedRuns) {
    const runId = asString(run.runId)
    const results = Array.isArray(run.results) ? run.results : []

    for (const result of results) {
      if (!isRecord(result)) continue
      const operation = asString(result.operation)
      if (!operation) continue

      const actions = Array.isArray(result.actions) ? result.actions : []
      for (const rawAction of actions) {
        if (!isRecord(rawAction)) continue

        if (MERGE_OPERATIONS.has(operation)) {
          const provenances = parseMergeAction(operation, rawAction, timestamp, runId)
          for (const provenance of provenances) {
            stats.mergeLogEntries += 1
            addProvenance(byId, provenance, stats)
          }
        } else if (DIRECT_OPERATIONS.has(operation)) {
          const provenance = parseDirectAction(operation, rawAction, timestamp, runId)
          if (!provenance) continue

          stats.directLogEntries += 1
          addProvenance(byId, provenance, stats)
        }
      }
    }
  }

  const finalEntries = Array.from(byId.values())
  stats.uniqueRecords = finalEntries.length
  stats.uniqueMergeRecords = finalEntries.filter(entry => entry.kind === 'merge').length
  stats.uniqueDirectRecords = finalEntries.filter(entry => entry.kind === 'direct').length

  return { byId, stats }
}

function parseArgs(argv: string[]): CliArgs {
  const parsed: CliArgs = { apply: false, help: false }

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
    'Usage: pnpm tsx scripts/backfill-deprecation-provenance.ts [--apply] [--collection <name>]',
    '',
    'Default mode is dry-run. Pass --apply to write deprecatedAt/deprecatedReason metadata.'
  ].join('\n')
}

function loadMaintenanceRuns(collection: string): LoadedRuns {
  const store = new JsonStore('maintenance-runs')
  const keys = store.list({ collection }).sort()
  const runs: unknown[] = []

  for (const key of keys) {
    const run = store.read<unknown>(key, {
      collection,
      errorMessage: `[claude-memory] Failed to read maintenance run log ${key}:`,
      fallback: null
    })
    if (run !== null) runs.push(run)
  }

  return {
    runs,
    runCount: keys.length,
    logDir: store.getCollectionDir(collection)
  }
}

function sortedProvenanceEntries(byId: Map<string, DeprecationProvenance>): DeprecationProvenance[] {
  return Array.from(byId.values()).sort((a, b) => {
    const timestampDiff = a.timestamp - b.timestamp
    if (timestampDiff !== 0) return timestampDiff
    return a.id.localeCompare(b.id)
  })
}

async function buildBackfillPlan(
  byId: Map<string, DeprecationProvenance>,
  config: Config
): Promise<BackfillPlan> {
  const entries = sortedProvenanceEntries(byId)
  const records = await fetchRecordsByIds(entries.map(entry => entry.id), config, { includeEmbeddings: true })
  const recordsById = new Map(records.map(record => [record.id, record]))

  const recordsToUpdate: MemoryRecord[] = []
  const examples: DeprecationProvenance[] = []
  const stats = {
    alreadyHadMetadata: 0,
    alreadyHadMetadataMerge: 0,
    alreadyHadMetadataDirect: 0,
    notDeprecated: 0,
    notFound: 0,
    toUpdate: 0,
    toUpdateMerge: 0,
    toUpdateDirect: 0
  }

  for (const provenance of entries) {
    const record = recordsById.get(provenance.id)
    if (!record) {
      stats.notFound += 1
      continue
    }

    if (!record.deprecated) {
      stats.notDeprecated += 1
      continue
    }

    if (record.deprecatedAt !== undefined) {
      stats.alreadyHadMetadata += 1
      if (provenance.kind === 'merge') {
        stats.alreadyHadMetadataMerge += 1
      } else {
        stats.alreadyHadMetadataDirect += 1
      }
      continue
    }

    record.deprecatedAt = provenance.timestamp
    record.deprecatedReason = provenance.reason
    if (provenance.supersedingRecordId) {
      record.supersedingRecordId = provenance.supersedingRecordId
    }

    recordsToUpdate.push(record)
    examples.push(provenance)
    stats.toUpdate += 1
    if (provenance.kind === 'merge') {
      stats.toUpdateMerge += 1
    } else {
      stats.toUpdateDirect += 1
    }
  }

  return { recordsToUpdate, examples, stats }
}

function printStat(label: string, value: string | number): void {
  console.log(`${label.padEnd(48)} ${value}`)
}

function printSummary(
  provenanceStats: ProvenanceStats,
  plan: BackfillPlan,
  apply: boolean,
  writeResult?: { updated: number; failed: number }
): void {
  console.log('')
  console.log('Summary')
  printStat(
    'Records found in logs',
    `${provenanceStats.uniqueRecords} (merges: ${provenanceStats.uniqueMergeRecords}, direct: ${provenanceStats.uniqueDirectRecords})`
  )
  printStat('Merge log entries', provenanceStats.mergeLogEntries)
  printStat('Direct deprecation log entries', provenanceStats.directLogEntries)
  printStat(
    'Records already had metadata (skipped)',
    `${plan.stats.alreadyHadMetadata} (merges: ${plan.stats.alreadyHadMetadataMerge}, direct: ${plan.stats.alreadyHadMetadataDirect})`
  )
  printStat(
    apply ? 'Records updated' : 'Records updated (dry-run: would update)',
    `${writeResult?.updated ?? plan.stats.toUpdate} (merges: ${plan.stats.toUpdateMerge}, direct: ${plan.stats.toUpdateDirect})`
  )
  printStat('Records not found in DB', plan.stats.notFound)
  printStat('Records active in DB (skipped)', plan.stats.notDeprecated)
  if (writeResult && writeResult.failed > 0) {
    printStat('Records failed to update', writeResult.failed)
  }
  if (provenanceStats.duplicateLogEntries > 0) {
    printStat('Duplicate log entries resolved', provenanceStats.duplicateLogEntries)
  }
  if (provenanceStats.mergePrecedenceReplacements > 0) {
    printStat('Direct entries replaced by merge metadata', provenanceStats.mergePrecedenceReplacements)
  }
}

function printExamples(examples: DeprecationProvenance[]): void {
  console.log('')
  console.log('First 10 proposed updates')
  for (const example of examples.slice(0, 10)) {
    const superseding = example.supersedingRecordId ? ` supersedingRecordId=${example.supersedingRecordId}` : ''
    console.log(
      `- id=${example.id} deprecatedAt=${example.timestamp} (${new Date(example.timestamp).toISOString()}) reason=${example.reason}${superseding}`
    )
  }
  if (examples.length === 0) {
    console.log('- none')
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

  const loaded = loadMaintenanceRuns(collection)
  const provenance = collectDeprecationProvenance(loaded.runs)

  console.log(`Mode: ${args.apply ? 'apply' : 'dry-run'}`)
  console.log(`Collection: ${collection}`)
  console.log(`Maintenance log directory: ${loaded.logDir}`)
  console.log(`Maintenance run files read: ${loaded.runCount}`)

  await initLanceDB(config)
  try {
    const plan = await buildBackfillPlan(provenance.byId, config)

    let writeResult: { updated: number; failed: number } | undefined
    if (args.apply) {
      writeResult = await batchUpdateRecords(plan.recordsToUpdate, {}, config)
    }

    printSummary(provenance.stats, plan, args.apply, writeResult)
    if (!args.apply) {
      printExamples(plan.examples)
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
