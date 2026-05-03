/**
 * Repair deprecation metadata columns that were accidentally created as Arrow Null.
 *
 * Usage:
 *   pnpm tsx scripts/repair-deprecation-columns.ts [--apply] [--collection <name>]
 */

import { pathToFileURL } from 'url'
import path from 'path'
import { loadConfig } from '../src/lib/config.js'
import { batchUpdateRecords, closeLanceDB, escapeFilterValue, initLanceDB, iterateRecords } from '../src/lib/lancedb.js'
import { ensureClient } from '../src/lib/lancedb-client.js'
import { MIGRATION_COLUMNS } from '../src/lib/lancedb-schema.js'
import type { Config, MemoryRecord } from '../src/lib/types.js'

const REPAIR_COLUMN_NAMES = ['deprecated_at', 'deprecated_reason', 'superseding_record_id'] as const
const EXPECTED_TYPES: Record<RepairColumnName, string> = {
  deprecated_at: 'Int64',
  deprecated_reason: 'Utf8',
  superseding_record_id: 'Utf8'
}
const BATCH_SIZE = 200

type RepairColumnName = typeof REPAIR_COLUMN_NAMES[number]
type SchemaState = 'broken-null' | 'correct' | 'unexpected'

interface CliArgs {
  apply: boolean
  collection?: string
  help: boolean
}

interface FieldLike {
  name: string
  type?: unknown
}

interface TableLike {
  schema: () => Promise<{ fields: FieldLike[] }>
  countRows: (filter?: string) => Promise<number>
  dropColumns: (names: string[]) => Promise<unknown>
  addColumns: (cols: Array<{ name: string; valueSql: string }>) => Promise<unknown>
  query: () => QueryLike
  checkoutLatest?: () => Promise<unknown>
}

interface QueryLike {
  where: (filter: string) => QueryLike
  select: (fields: string[]) => QueryLike
  limit: (limit: number) => QueryLike
  toArray: () => Promise<unknown[]>
}

interface SchemaCheck {
  state: SchemaState
  types: Record<RepairColumnName, string>
}

interface MetadataBaseline {
  totalDeprecated: number
  deprecatedReasonInContent: number
  metadataInContent: number
}

interface BackfillStats {
  totalDeprecated: number
  recordsWithMetadataInContent: number
  recordsUpdated: number
  recordsSkippedNoMetadata: number
  failures: number
  spotCheckCandidates: MemoryRecord[]
}

interface VerificationStats {
  reasonColumnCount: number
  spotChecksPassed: number
}

export interface RepairResult {
  mode: 'dry-run' | 'apply'
  collection: string
  schema: SchemaCheck
  baseline: MetadataBaseline
  initialReasonColumnCount: number
  backfill?: BackfillStats
  verification?: VerificationStats
}

interface RepairOptions {
  apply: boolean
  collection: string
  config: Config
  preApplyDelayMs?: number
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
    'Usage: pnpm tsx scripts/repair-deprecation-columns.ts [--apply] [--collection <name>]',
    '',
    'Default mode is dry-run. Pass --apply to drop/re-add broken deprecation metadata columns and backfill them.'
  ].join('\n')
}

function phase(label: string): void {
  console.error('')
  console.error(`== ${label} ==`)
}

function printStat(label: string, value: string | number): void {
  console.log(`${label.padEnd(48)} ${value}`)
}

function typeName(field: FieldLike): string {
  const type = field.type
  if (type && typeof (type as { toString?: unknown }).toString === 'function') {
    return (type as { toString: () => string }).toString()
  }
  if (typeof type === 'string') return type
  return String(type)
}

function normalizeTypeName(name: string): string {
  return name.trim().toLowerCase()
}

async function checkSchema(table: TableLike): Promise<SchemaCheck> {
  const schema = await table.schema()
  const fieldsByName = new Map(schema.fields.map(field => [field.name, field]))
  const missing = REPAIR_COLUMN_NAMES.filter(name => !fieldsByName.has(name))

  if (missing.length > 0) {
    throw new Error(`Required deprecation columns are missing: ${missing.join(', ')}`)
  }

  const types = Object.fromEntries(REPAIR_COLUMN_NAMES.map(name => {
    const field = fieldsByName.get(name)
    return [name, field ? typeName(field) : 'missing']
  })) as Record<RepairColumnName, string>

  const allNull = REPAIR_COLUMN_NAMES.every(name => normalizeTypeName(types[name]) === 'null')
  const allExpected = REPAIR_COLUMN_NAMES.every(name =>
    normalizeTypeName(types[name]) === normalizeTypeName(EXPECTED_TYPES[name])
  )

  if (allNull) return { state: 'broken-null', types }
  if (allExpected) return { state: 'correct', types }
  return { state: 'unexpected', types }
}

function hasDeprecatedReason(record: MemoryRecord): boolean {
  return typeof record.deprecatedReason === 'string' && record.deprecatedReason.trim().length > 0
}

function hasAnyDeprecationMetadata(record: MemoryRecord): boolean {
  return record.deprecatedAt !== undefined
    || hasDeprecatedReason(record)
    || (typeof record.supersedingRecordId === 'string' && record.supersedingRecordId.trim().length > 0)
}

async function collectMetadataBaseline(config: Config): Promise<MetadataBaseline> {
  const baseline: MetadataBaseline = {
    totalDeprecated: 0,
    deprecatedReasonInContent: 0,
    metadataInContent: 0
  }

  for await (const record of iterateRecords({ filter: 'deprecated = true' }, config)) {
    baseline.totalDeprecated += 1
    if (hasDeprecatedReason(record)) baseline.deprecatedReasonInContent += 1
    if (hasAnyDeprecationMetadata(record)) baseline.metadataInContent += 1
  }

  return baseline
}

function migrationColumnsForRepair(): Array<{ name: string; valueSql: string }> {
  const columns = MIGRATION_COLUMNS.filter((column): column is { name: RepairColumnName; valueSql: string } =>
    REPAIR_COLUMN_NAMES.includes(column.name as RepairColumnName)
  )
  const found = new Set(columns.map(column => column.name))
  const missing = REPAIR_COLUMN_NAMES.filter(name => !found.has(name))
  if (missing.length > 0) {
    throw new Error(`MIGRATION_COLUMNS is missing repair definitions for: ${missing.join(', ')}`)
  }
  return columns
}

async function checkoutLatest(table: TableLike): Promise<void> {
  if (typeof table.checkoutLatest === 'function') {
    await table.checkoutLatest()
  }
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function repairSchema(table: TableLike, preApplyDelayMs: number): Promise<SchemaCheck> {
  phase('Phase B: schema repair')
  console.error('WARNING: This will drop and re-add deprecation metadata columns.')
  console.error('Any concurrent write to this LanceDB table during the next ~30s may cause schema conflicts.')
  console.error('Press Ctrl-C now if another claude-memory writer is active.')
  await sleep(preApplyDelayMs)

  await table.dropColumns([...REPAIR_COLUMN_NAMES])
  await table.addColumns(migrationColumnsForRepair())
  await checkoutLatest(table)

  const schema = await checkSchema(table)
  if (schema.state !== 'correct') {
    throw new Error(`Schema repair did not produce expected types: ${formatSchemaTypes(schema.types)}`)
  }

  console.error(`Schema repair verified: ${formatSchemaTypes(schema.types)}`)
  return schema
}

function batchRecords<T>(records: T[], batchSize: number): T[][] {
  const batches: T[][] = []
  for (let i = 0; i < records.length; i += batchSize) {
    batches.push(records.slice(i, i + batchSize))
  }
  return batches
}

async function backfillFromContent(config: Config): Promise<BackfillStats> {
  phase('Phase C: backfill from JSON content')

  const recordsToUpdate: MemoryRecord[] = []
  const stats: BackfillStats = {
    totalDeprecated: 0,
    recordsWithMetadataInContent: 0,
    recordsUpdated: 0,
    recordsSkippedNoMetadata: 0,
    failures: 0,
    spotCheckCandidates: []
  }

  for await (const record of iterateRecords({ filter: 'deprecated = true', includeEmbeddings: true }, config)) {
    stats.totalDeprecated += 1

    if (!hasAnyDeprecationMetadata(record)) {
      stats.recordsSkippedNoMetadata += 1
      continue
    }

    stats.recordsWithMetadataInContent += 1
    recordsToUpdate.push(record)
    if (stats.spotCheckCandidates.length < 3) {
      stats.spotCheckCandidates.push(record)
    }
  }

  for (const batch of batchRecords(recordsToUpdate, BATCH_SIZE)) {
    const result = await batchUpdateRecords(batch, {}, config)
    stats.recordsUpdated += result.updated
    stats.failures += result.failed
  }

  console.error(`Backfill complete: updated ${stats.recordsUpdated}, failures ${stats.failures}`)
  return stats
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function normalizeOptionalInt64(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return Math.trunc(parsed)
  }
  return undefined
}

function parseMetadataFromContent(content: unknown, id: string): Pick<MemoryRecord, 'deprecatedAt' | 'deprecatedReason' | 'supersedingRecordId'> {
  if (typeof content !== 'string') {
    throw new Error(`Spot-check failed for ${id}: raw content is not a JSON string`)
  }

  let parsed: Record<string, unknown>
  try {
    const value = JSON.parse(content)
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('content JSON is not an object')
    }
    parsed = value as Record<string, unknown>
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Spot-check failed for ${id}: could not parse raw content JSON: ${message}`)
  }

  return {
    deprecatedAt: normalizeOptionalInt64(parsed.deprecatedAt),
    deprecatedReason: normalizeOptionalString(parsed.deprecatedReason),
    supersedingRecordId: normalizeOptionalString(parsed.supersedingRecordId)
  }
}

async function readRawRecord(table: TableLike, id: string): Promise<Record<string, unknown> | null> {
  const rows = await table
    .query()
    .where(`id = '${escapeFilterValue(id)}'`)
    .select(['id', 'deprecated_at', 'deprecated_reason', 'superseding_record_id', 'content'])
    .limit(1)
    .toArray()

  if (!rows || rows.length === 0) return null
  return rows[0] as Record<string, unknown>
}

function assertRawColumnsMatch(record: MemoryRecord, raw: Record<string, unknown>): void {
  const contentMetadata = parseMetadataFromContent(raw.content, record.id)
  const rawDeprecatedAt = normalizeOptionalInt64(raw.deprecated_at)
  const rawReason = normalizeOptionalString(raw.deprecated_reason)
  const rawSupersedingId = normalizeOptionalString(raw.superseding_record_id)

  if (rawDeprecatedAt !== contentMetadata.deprecatedAt) {
    throw new Error(`Spot-check failed for ${record.id}: deprecated_at column ${rawDeprecatedAt} != JSON ${contentMetadata.deprecatedAt}`)
  }
  if (rawReason !== contentMetadata.deprecatedReason) {
    throw new Error(`Spot-check failed for ${record.id}: deprecated_reason column does not match JSON content`)
  }
  if (rawSupersedingId !== contentMetadata.supersedingRecordId) {
    throw new Error(`Spot-check failed for ${record.id}: superseding_record_id column does not match JSON content`)
  }
}

async function verifyRepair(
  table: TableLike,
  backfill: BackfillStats,
  baseline: MetadataBaseline
): Promise<VerificationStats> {
  phase('Phase D: verification')
  await checkoutLatest(table)

  const reasonColumnCount = await table.countRows('deprecated_reason IS NOT NULL')
  if (reasonColumnCount !== baseline.deprecatedReasonInContent) {
    throw new Error(
      `Verification failed: deprecated_reason IS NOT NULL returned ${reasonColumnCount}, expected ${baseline.deprecatedReasonInContent}`
    )
  }

  let spotChecksPassed = 0
  for (const record of backfill.spotCheckCandidates.slice(0, 3)) {
    const raw = await readRawRecord(table, record.id)
    if (!raw) {
      throw new Error(`Spot-check failed: record not found after backfill: ${record.id}`)
    }
    assertRawColumnsMatch(record, raw)
    spotChecksPassed += 1
  }

  console.error(`Verification complete: reason column count ${reasonColumnCount}, spot-checks passed ${spotChecksPassed}`)
  return { reasonColumnCount, spotChecksPassed }
}

function formatSchemaTypes(types: Record<RepairColumnName, string>): string {
  return REPAIR_COLUMN_NAMES.map(name => `${name}=${types[name]}`).join(', ')
}

function printSummary(result: RepairResult): void {
  console.log('')
  console.log('Summary')
  printStat('Mode', result.mode)
  printStat('Collection', result.collection)
  printStat('Schema state', result.schema.state)
  for (const name of REPAIR_COLUMN_NAMES) {
    printStat(`Schema ${name}`, result.schema.types[name])
  }
  printStat('Deprecated records scanned', result.baseline.totalDeprecated)
  printStat('Deprecated records with reason in JSON', result.baseline.deprecatedReasonInContent)
  printStat('Deprecated records with any metadata in JSON', result.baseline.metadataInContent)
  printStat('Rows where deprecated_reason IS NOT NULL', result.initialReasonColumnCount)

  if (result.backfill) {
    printStat('Backfill deprecated records scanned', result.backfill.totalDeprecated)
    printStat('Backfill records with metadata', result.backfill.recordsWithMetadataInContent)
    printStat('Backfill records updated', result.backfill.recordsUpdated)
    printStat('Backfill records skipped (no metadata)', result.backfill.recordsSkippedNoMetadata)
    printStat('Backfill failures', result.backfill.failures)
  }

  if (result.verification) {
    printStat('Verification reason column count', result.verification.reasonColumnCount)
    printStat('Verification spot-checks passed', result.verification.spotChecksPassed)
  }
}

export async function repairDeprecationColumns(options: RepairOptions): Promise<RepairResult> {
  const mode = options.apply ? 'apply' : 'dry-run'
  console.log(`Mode: ${mode}`)
  console.log(`Collection: ${options.collection}`)

  phase('Phase A: pre-check')
  await initLanceDB(options.config)
  const { table } = await ensureClient(options.config) as { table: TableLike }

  let schema = await checkSchema(table)
  console.error(`Schema types: ${formatSchemaTypes(schema.types)}`)

  const baseline = await collectMetadataBaseline(options.config)
  console.error(`Deprecated records with deprecatedReason in JSON content: ${baseline.deprecatedReasonInContent}`)

  const initialReasonColumnCount = await table.countRows('deprecated_reason IS NOT NULL')
  console.error(`Rows where deprecated_reason IS NOT NULL: ${initialReasonColumnCount}`)

  const result: RepairResult = {
    mode,
    collection: options.collection,
    schema,
    baseline,
    initialReasonColumnCount
  }

  if (schema.state === 'correct') {
    console.error('Schema already correct; skipping Phase B, Phase C, and Phase D.')
    printSummary(result)
    return result
  }

  if (schema.state !== 'broken-null') {
    throw new Error(`Unexpected deprecation column schema; refusing repair: ${formatSchemaTypes(schema.types)}`)
  }

  if (initialReasonColumnCount !== 0) {
    throw new Error(
      `Sanity check failed: deprecated_reason IS NOT NULL returned ${initialReasonColumnCount}, expected 0 for Null-typed column`
    )
  }

  if (!options.apply) {
    console.error('Dry-run only: no schema changes or backfill performed. Re-run with --apply after confirming no concurrent writers.')
    printSummary(result)
    return result
  }

  schema = await repairSchema(table, options.preApplyDelayMs ?? 3000)
  result.schema = schema

  const backfill = await backfillFromContent(options.config)
  result.backfill = backfill

  const verification = await verifyRepair(table, backfill, baseline)
  result.verification = verification

  printSummary(result)
  return result
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
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

  try {
    await repairDeprecationColumns({
      apply: args.apply,
      collection,
      config
    })
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
