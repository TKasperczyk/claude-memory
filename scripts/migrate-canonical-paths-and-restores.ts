#!/usr/bin/env tsx
/**
 * Migrate LanceDB records to:
 * 1. Canonicalize symlinked project/cwd paths (e.g. /home/luthriel/Programming/... -> /mnt/Programming/...)
 * 2. Clear stale deprecation provenance (deprecatedAt, deprecatedReason, supersedingRecordId)
 *    left behind on active (deprecated = false) records by earlier restores.
 *
 * Defaults to --dry-run. Pass --apply to persist updates and compact the table.
 */
import path from 'path'
import { loadConfig } from '../src/lib/config.js'
import {
  batchUpdateRecords,
  closeLanceDB,
  countRecords,
  fetchRecordsByIds,
  initLanceDB,
  iterateRecords
} from '../src/lib/lancedb.js'
import { compactTableSafely } from '../src/lib/maintenance-api.js'
import { canonicalizePath } from '../src/lib/paths.js'
import { isProcessEntrypoint } from '../src/lib/shared.js'
import type { MemoryRecord } from '../src/lib/types.js'

const BATCH_SIZE = 200

function canonicalizeIfAbsolute(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed || !path.isAbsolute(trimmed)) return undefined
  const canonical = canonicalizePath(trimmed)
  return canonical !== value ? canonical : undefined
}

interface RecordMigrationPlan {
  id: string
  pathChanges: Array<{ field: string; before: string; after: string }>
  clearStaleDeprecation: boolean
}

function inspectRecord(record: MemoryRecord): RecordMigrationPlan | null {
  const pathChanges: Array<{ field: string; before: string; after: string }> = []

  const nextProject = canonicalizeIfAbsolute(record.project)
  if (nextProject && record.project) {
    pathChanges.push({ field: 'project', before: record.project, after: nextProject })
  }

  if ('context' in record && record.context && typeof record.context === 'object') {
    const ctx = record.context as Record<string, unknown>
    const nextCtxProject = canonicalizeIfAbsolute(ctx.project)
    if (nextCtxProject && typeof ctx.project === 'string') {
      pathChanges.push({ field: 'context.project', before: ctx.project, after: nextCtxProject })
    }
    const nextCtxCwd = canonicalizeIfAbsolute(ctx.cwd)
    if (nextCtxCwd && typeof ctx.cwd === 'string') {
      pathChanges.push({ field: 'context.cwd', before: ctx.cwd, after: nextCtxCwd })
    }
  }

  const clearStaleDeprecation = !record.deprecated && (
    record.deprecatedAt !== undefined
    || record.deprecatedReason !== undefined
    || record.supersedingRecordId !== undefined
  )

  if (pathChanges.length === 0 && !clearStaleDeprecation) return null
  return { id: record.id, pathChanges, clearStaleDeprecation }
}

function applyPlan(record: MemoryRecord, plan: RecordMigrationPlan): void {
  for (const change of plan.pathChanges) {
    if (change.field === 'project') {
      record.project = change.after
    } else if (change.field === 'context.project' && 'context' in record && record.context) {
      (record.context as Record<string, unknown>).project = change.after
    } else if (change.field === 'context.cwd' && 'context' in record && record.context) {
      (record.context as Record<string, unknown>).cwd = change.after
    }
  }

  if (plan.clearStaleDeprecation) {
    delete record.deprecatedAt
    delete record.deprecatedReason
    delete record.supersedingRecordId
  }
}

function parseArgs(argv: string[]): { apply: boolean; table?: string } {
  let apply = false
  let table: string | undefined
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--apply') apply = true
    else if (arg === '--dry-run') apply = false
    else if (arg === '--table' && argv[i + 1]) {
      table = argv[i + 1]
      i += 1
    }
  }
  return { apply, table }
}

async function main(): Promise<void> {
  const { apply, table } = parseArgs(process.argv.slice(2))
  const baseConfig = loadConfig(process.cwd())
  const config = table
    ? { ...baseConfig, lancedb: { ...baseConfig.lancedb, table } }
    : baseConfig

  await initLanceDB(config)
  try {
    const totalBefore = await countRecords({}, config)
    const plans: RecordMigrationPlan[] = []
    let scanned = 0
    let pathFixCount = 0
    let staleDeprecationFixCount = 0
    const pathRewriteSummary = new Map<string, number>()
    const staleDeprecationSamples: Array<{ id: string; deprecatedAt?: number; deprecatedReason?: string; supersedingRecordId?: string }> = []

    for await (const record of iterateRecords({ includeEmbeddings: false }, config)) {
      scanned += 1
      const plan = inspectRecord(record)
      if (!plan) continue
      plans.push(plan)
      if (plan.pathChanges.length > 0) {
        pathFixCount += 1
        for (const change of plan.pathChanges) {
          if (change.field === 'project') {
            const key = `${change.before} -> ${change.after}`
            pathRewriteSummary.set(key, (pathRewriteSummary.get(key) ?? 0) + 1)
          }
        }
      }
      if (plan.clearStaleDeprecation) {
        staleDeprecationFixCount += 1
        if (staleDeprecationSamples.length < 5) {
          staleDeprecationSamples.push({
            id: record.id,
            deprecatedAt: record.deprecatedAt,
            deprecatedReason: record.deprecatedReason,
            supersedingRecordId: record.supersedingRecordId
          })
        }
      }
    }

    console.log(`Table: ${config.lancedb.table}`)
    console.log(`Scanned: ${scanned} (countRecords=${totalBefore})`)
    console.log(`Records with symlinked paths: ${pathFixCount}`)
    console.log(`Active records with stale deprecation fields: ${staleDeprecationFixCount}`)
    console.log(`Total distinct records to update: ${plans.length}`)

    if (staleDeprecationSamples.length > 0) {
      console.log('\nSample active records with stale deprecation fields:')
      for (const sample of staleDeprecationSamples) {
        console.log(`  ${sample.id}: deprecatedAt=${sample.deprecatedAt}, reason=${sample.deprecatedReason ?? 'none'}, superseding=${sample.supersedingRecordId ?? 'none'}`)
      }
    }

    if (pathRewriteSummary.size > 0) {
      console.log('\nProject path rewrites:')
      for (const [mapping, count] of Array.from(pathRewriteSummary.entries()).sort((a, b) => b[1] - a[1])) {
        console.log(`  (${count}) ${mapping}`)
      }
    }

    if (!apply) {
      console.log('\nDry-run complete. Re-run with --apply to write changes and compact.')
      return
    }

    if (plans.length === 0) {
      console.log('\nNo changes needed.')
      return
    }

    const planById = new Map(plans.map(plan => [plan.id, plan]))
    let totalUpdated = 0
    let totalFailed = 0

    for (let i = 0; i < plans.length; i += BATCH_SIZE) {
      const chunkPlans = plans.slice(i, i + BATCH_SIZE)
      const ids = chunkPlans.map(plan => plan.id)
      const hydrated = await fetchRecordsByIds(ids, config, { includeEmbeddings: true })
      const toPersist: MemoryRecord[] = []

      for (const record of hydrated) {
        const plan = planById.get(record.id)
        if (!plan) continue
        applyPlan(record, plan)
        toPersist.push(record)
      }

      if (toPersist.length !== chunkPlans.length) {
        throw new Error(`Hydration count mismatch: expected ${chunkPlans.length}, got ${toPersist.length}`)
      }

      const result = await batchUpdateRecords(toPersist, {}, config)
      totalUpdated += result.updated
      totalFailed += result.failed
      console.log(`Batch ${Math.floor(i / BATCH_SIZE) + 1}: updated=${result.updated}, failed=${result.failed}`)
    }

    const totalAfter = await countRecords({}, config)
    console.log(`\nMigration complete: updated=${totalUpdated}, failed=${totalFailed}, countBefore=${totalBefore}, countAfter=${totalAfter}`)
    if (totalFailed > 0 || totalAfter !== totalBefore) {
      throw new Error(`Migration verification failed: failed=${totalFailed}, countBefore=${totalBefore}, countAfter=${totalAfter}`)
    }

    console.log('Compacting table...')
    await compactTableSafely(config)
    console.log('Compaction complete.')
  } finally {
    await closeLanceDB()
  }
}

if (isProcessEntrypoint(import.meta.url)) {
  main().catch(error => {
    console.error('Migration failed:', error)
    process.exit(1)
  })
}
