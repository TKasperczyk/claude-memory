import fs from 'fs'
import path from 'path'
import {
  backfillSearchText,
  batchUpdateRecords,
  compactTable,
  fetchRecordsByIds,
  initLanceDB,
  iterateRecords,
  resolveDirectory
} from './lancedb.js'
import { acquireFileLock } from './lock.js'
import { migrateCatchAllScopeRecords } from './maintenance/runners/static-doc-runner.js'
import { toErrorMessage } from './maintenance/runners/shared.js'
import {
  clearCollectionMigrationState,
  getMigrationCollectionKey,
  getMigrationsLockPath,
  getMigrationsStatePath,
  loadMigrationsState,
  MIGRATIONS_LOCK_STALE_MS,
  saveMigrationsState,
  type AppliedMigrationEntry,
  type CollectionMigrationState,
  type MigrationsStateFile
} from './migrations-state.js'
import { canonicalizePath } from './paths.js'
import { DEFAULT_CONFIG, type Config, type MemoryRecord } from './types.js'

const CANONICAL_PATH_BATCH_SIZE = 200

export {
  clearCollectionMigrationState,
  getMigrationCollectionKey,
  getMigrationsLockPath,
  getMigrationsStatePath,
  loadMigrationsState,
  type AppliedMigrationEntry,
  type CollectionMigrationState,
  type MigrationsStateFile
}

export const MIGRATION_IDS = {
  CANONICAL_PATHS_AND_RESTORES: '2026-11-v0.2-canonical-paths-and-restores',
  BACKFILL_SEARCH_TEXT: '2026-11-v0.3-backfill-search-text',
  CATCHALL_SCOPE: '2026-11-v0.3-catchall-scope'
} as const

export type DataMigrationId = typeof MIGRATION_IDS[keyof typeof MIGRATION_IDS]

export interface DataMigrationStepOutcome {
  scanned: number
  updated: number
  details?: Record<string, number>
}

export interface DataMigrationDefinition {
  id: DataMigrationId
  description: string
  run: (config: Config) => Promise<DataMigrationStepOutcome>
}

export interface DataMigrationStepResult {
  id: DataMigrationId
  status: 'applied' | 'would-run' | 'failed'
  scanned: number
  updated: number
  details?: Record<string, number>
  error?: string
}

export type DataMigrationsStatus = 'up-to-date' | 'would-run' | 'applied' | 'skipped' | 'failed'
export type DataMigrationsSkipReason = 'locked' | 'table-not-found'

export interface DataMigrationsResult {
  status: DataMigrationsStatus
  skipReason?: DataMigrationsSkipReason
  collectionKey: string
  pendingIds: DataMigrationId[]
  steps: DataMigrationStepResult[]
  mutated: boolean
  compacted: boolean
  error?: string
}

export interface RunMigrationsOptions {
  dryRun?: boolean
  statePath?: string
  lockPath?: string
  migrations?: readonly DataMigrationDefinition[]
}

export interface CanonicalPathAndRestorePlan {
  id: string
  pathChanges: Array<{ field: 'project' | 'context.project' | 'context.cwd'; before: string; after: string }>
  clearStaleDeprecation: boolean
}

export interface CanonicalPathsAndRestoresResult {
  scanned: number
  updated: number
  pathFixCount: number
  staleDeprecationFixCount: number
  skippedMissingEmbedding: number
  failed: number
}

function lancedbTableExistsOnDisk(config: Config): boolean {
  const dir = resolveDirectory(config.lancedb.directory)
  return fs.existsSync(path.join(dir, `${config.lancedb.table}.lance`))
}

function canonicalizeIfAbsolute(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed || !path.isAbsolute(trimmed)) return undefined
  const canonical = canonicalizePath(trimmed)
  return canonical !== value ? canonical : undefined
}

export function inspectCanonicalPathAndRestoreRecord(record: MemoryRecord): CanonicalPathAndRestorePlan | null {
  const pathChanges: CanonicalPathAndRestorePlan['pathChanges'] = []

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

export function applyCanonicalPathAndRestorePlan(
  record: MemoryRecord,
  plan: CanonicalPathAndRestorePlan
): void {
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

/**
 * Canonicalize symlinked project/cwd paths and clear stale deprecation metadata
 * on active records without re-embedding.
 */
export async function migrateCanonicalPathsAndRestores(
  config: Config = DEFAULT_CONFIG,
  options: { dryRun?: boolean } = {}
): Promise<CanonicalPathsAndRestoresResult> {
  const plans: CanonicalPathAndRestorePlan[] = []
  let scanned = 0
  let pathFixCount = 0
  let staleDeprecationFixCount = 0

  for await (const record of iterateRecords({ includeEmbeddings: false }, config)) {
    scanned += 1
    const plan = inspectCanonicalPathAndRestoreRecord(record)
    if (!plan) continue
    plans.push(plan)
    if (plan.pathChanges.length > 0) pathFixCount += 1
    if (plan.clearStaleDeprecation) staleDeprecationFixCount += 1
  }

  if (options.dryRun || plans.length === 0) {
    return {
      scanned,
      updated: plans.length,
      pathFixCount,
      staleDeprecationFixCount,
      skippedMissingEmbedding: 0,
      failed: 0
    }
  }

  const planById = new Map(plans.map(plan => [plan.id, plan]))
  let updated = 0
  let skippedMissingEmbedding = 0
  let failed = 0

  for (let i = 0; i < plans.length; i += CANONICAL_PATH_BATCH_SIZE) {
    const chunkPlans = plans.slice(i, i + CANONICAL_PATH_BATCH_SIZE)
    const ids = chunkPlans.map(plan => plan.id)
    const hydrated = await fetchRecordsByIds(ids, config, { includeEmbeddings: true })
    const toPersist: MemoryRecord[] = []

    for (const record of hydrated) {
      const plan = planById.get(record.id)
      if (!plan) continue
      if (!record.embedding || record.embedding.length === 0) {
        skippedMissingEmbedding += 1
        continue
      }
      applyCanonicalPathAndRestorePlan(record, plan)
      toPersist.push(record)
    }

    if (toPersist.length === 0) continue
    const batchResult = await batchUpdateRecords(toPersist, {}, config)
    updated += batchResult.updated
    failed += batchResult.failed
  }

  return {
    scanned,
    updated,
    pathFixCount,
    staleDeprecationFixCount,
    skippedMissingEmbedding,
    failed
  }
}

export const DATA_MIGRATIONS: readonly DataMigrationDefinition[] = [
  {
    id: MIGRATION_IDS.CANONICAL_PATHS_AND_RESTORES,
    description: 'Canonicalize symlinked project/cwd paths and clear stale deprecation fields on active records',
    run: async (config) => {
      const result = await migrateCanonicalPathsAndRestores(config)
      if (result.failed > 0) {
        throw new Error(`Canonical paths & restores migration failed on ${result.failed} record(s)`)
      }
      return {
        scanned: result.scanned,
        updated: result.updated,
        details: {
          pathFixCount: result.pathFixCount,
          staleDeprecationFixCount: result.staleDeprecationFixCount,
          ...(result.skippedMissingEmbedding > 0
            ? { skippedMissingEmbedding: result.skippedMissingEmbedding }
            : {})
        }
      }
    }
  },
  {
    id: MIGRATION_IDS.BACKFILL_SEARCH_TEXT,
    description: 'Backfill expanded search_text column and rebuild LanceDB BM25 FTS index',
    run: async (config) => {
      const result = await backfillSearchText(config, { forceRebuildIndex: true })
      if (result.failed > 0) {
        throw new Error(`search_text backfill failed on ${result.failed} record(s)`)
      }
      if (!result.ftsRebuilt) {
        throw new Error('Failed to rebuild LanceDB BM25 FTS index on search_text')
      }
      return {
        scanned: result.scanned,
        updated: result.updated,
        details: {
          ftsRebuilt: 1
        }
      }
    }
  },
  {
    id: MIGRATION_IDS.CATCHALL_SCOPE,
    description: 'Re-attribute catch-all directory records to real git repos or promote workstation/infra rows to environment scope',
    run: async (config) => {
      const result = await migrateCatchAllScopeRecords(config)
      if (result.failed > 0) {
        throw new Error(`Catch-all scope migration failed on ${result.failed} record(s)`)
      }
      return {
        scanned: result.scanned,
        updated: result.migrated,
        details: {
          reattributedToProject: result.reattributedToProject,
          promotedToEnvironment: result.promotedToEnvironment,
          skippedUnclassified: result.skippedUnclassified
        }
      }
    }
  }
]

function computePendingMigrations(
  state: MigrationsStateFile,
  collectionKey: string,
  migrations: readonly DataMigrationDefinition[]
): DataMigrationDefinition[] {
  const applied = state.collections[collectionKey]?.applied ?? {}
  return migrations.filter(migration => !Object.prototype.hasOwnProperty.call(applied, migration.id))
}

/**
 * O(1) lock-free check returning pending migration IDs for a collection.
 */
export function getPendingMigrations(
  config: Config = DEFAULT_CONFIG,
  options: Pick<RunMigrationsOptions, 'statePath' | 'migrations'> = {}
): DataMigrationId[] {
  const statePath = options.statePath ?? getMigrationsStatePath()
  const migrations = options.migrations ?? DATA_MIGRATIONS
  const collectionKey = getMigrationCollectionKey(config)
  const state = loadMigrationsState(statePath)
  return computePendingMigrations(state, collectionKey, migrations).map(m => m.id)
}

/**
 * Run pending versioned data migrations for a collection.
 *
 * - O(1) fast-path skip (reads only migrations-state.json) once all migrations are applied.
 * - Skips cleanly when the LanceDB table does not yet exist on disk.
 * - Guards execution with an exclusive PID-aware lock file and double-checks state after locking.
 * - Persists each applied migration atomically immediately upon completion.
 * - Compacts the LanceDB table (and refreshes FTS index) if any migration mutated rows.
 */
export async function runPendingMigrations(
  config: Config = DEFAULT_CONFIG,
  options: RunMigrationsOptions = {}
): Promise<DataMigrationsResult> {
  const statePath = options.statePath ?? getMigrationsStatePath()
  const lockPath = options.lockPath ?? getMigrationsLockPath()
  const migrations = options.migrations ?? DATA_MIGRATIONS
  const dryRun = options.dryRun ?? false
  const collectionKey = getMigrationCollectionKey(config)

  // Fast path: O(1) JSON check without lock or LanceDB initialization.
  const initialState = loadMigrationsState(statePath)
  const initialPending = computePendingMigrations(initialState, collectionKey, migrations)
  if (initialPending.length === 0) {
    return {
      status: 'up-to-date',
      collectionKey,
      pendingIds: [],
      steps: [],
      mutated: false,
      compacted: false
    }
  }

  if (!lancedbTableExistsOnDisk(config)) {
    return {
      status: 'skipped',
      skipReason: 'table-not-found',
      collectionKey,
      pendingIds: initialPending.map(m => m.id),
      steps: [],
      mutated: false,
      compacted: false
    }
  }

  if (dryRun) {
    return {
      status: 'would-run',
      collectionKey,
      pendingIds: initialPending.map(m => m.id),
      steps: initialPending.map(m => ({
        id: m.id,
        status: 'would-run',
        scanned: 0,
        updated: 0
      })),
      mutated: false,
      compacted: false
    }
  }

  let lockHandle: ReturnType<typeof acquireFileLock>
  try {
    lockHandle = acquireFileLock(lockPath, {
      staleAfterMs: MIGRATIONS_LOCK_STALE_MS,
      staleStrategy: 'pid',
      ensureDir: true,
      proceedOnError: false,
      write: { data: () => `${process.pid}\n${Date.now()}` }
    })
  } catch (error) {
    return {
      status: 'failed',
      collectionKey,
      pendingIds: initialPending.map(m => m.id),
      steps: [],
      mutated: false,
      compacted: false,
      error: `Failed to acquire migrations lock: ${toErrorMessage(error)}`
    }
  }

  if (!lockHandle) {
    return {
      status: 'skipped',
      skipReason: 'locked',
      collectionKey,
      pendingIds: initialPending.map(m => m.id),
      steps: [],
      mutated: false,
      compacted: false
    }
  }

  try {
    // Double-check after acquiring lock in case another process finished first.
    const state = loadMigrationsState(statePath)
    const pending = computePendingMigrations(state, collectionKey, migrations)
    if (pending.length === 0) {
      return {
        status: 'up-to-date',
        collectionKey,
        pendingIds: [],
        steps: [],
        mutated: false,
        compacted: false
      }
    }

    await initLanceDB(config)

    const steps: DataMigrationStepResult[] = []
    let mutated = false
    let compacted = false
    let failureMessage: string | undefined

    for (const migration of pending) {
      try {
        const outcome = await migration.run(config)
        if (outcome.updated > 0) mutated = true

        const now = Date.now()
        const existingCollection = state.collections[collectionKey] ?? { applied: {}, updatedAt: now }
        existingCollection.applied[migration.id] = {
          appliedAt: now,
          scanned: outcome.scanned,
          updated: outcome.updated,
          ...(outcome.details && Object.keys(outcome.details).length > 0 ? { details: outcome.details } : {})
        }
        existingCollection.updatedAt = now
        state.collections[collectionKey] = existingCollection
        saveMigrationsState(state, statePath)

        steps.push({
          id: migration.id,
          status: 'applied',
          scanned: outcome.scanned,
          updated: outcome.updated,
          ...(outcome.details ? { details: outcome.details } : {})
        })
      } catch (error) {
        const message = toErrorMessage(error)
        failureMessage = `${migration.id}: ${message}`
        steps.push({
          id: migration.id,
          status: 'failed',
          scanned: 0,
          updated: 0,
          error: message
        })
        break
      }
    }

    if (mutated) {
      try {
        await compactTable(config)
        compacted = true
      } catch (error) {
        console.error('[claude-memory] LanceDB compaction after migrations failed:', error)
      }
    }

    if (failureMessage) {
      return {
        status: 'failed',
        collectionKey,
        pendingIds: pending.map(m => m.id),
        steps,
        mutated,
        compacted,
        error: failureMessage
      }
    }

    return {
      status: 'applied',
      collectionKey,
      pendingIds: pending.map(m => m.id),
      steps,
      mutated,
      compacted
    }
  } catch (error) {
    return {
      status: 'failed',
      collectionKey,
      pendingIds: initialPending.map(m => m.id),
      steps: [],
      mutated: false,
      compacted: false,
      error: toErrorMessage(error)
    }
  } finally {
    lockHandle.release()
  }
}
