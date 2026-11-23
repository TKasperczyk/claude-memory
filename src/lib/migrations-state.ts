import fs from 'fs'
import path from 'path'
import { readJsonFileSafe, writeJsonFile } from './json.js'
import { resolveDirectory } from './lancedb-client.js'
import { acquireFileLock } from './lock.js'
import { asInteger, isPlainObject } from './parsing.js'
import { canonicalizePath, CLAUDE_MEMORY_ROOT, LOCKS_DIR } from './paths.js'
import { DEFAULT_CONFIG, type Config } from './types.js'

export const MIGRATIONS_LOCK_STALE_MS = 15 * 60 * 1000
const CLEAR_STATE_LOCK_WAIT_MS = 5_000

export interface AppliedMigrationEntry {
  appliedAt: number
  scanned?: number
  updated?: number
  details?: Record<string, number>
}

export interface CollectionMigrationState {
  applied: Record<string, AppliedMigrationEntry>
  updatedAt: number
}

export interface MigrationsStateFile {
  version: 1
  collections: Record<string, CollectionMigrationState>
}

export function getMigrationsStatePath(): string {
  return path.join(CLAUDE_MEMORY_ROOT, 'migrations-state.json')
}

export function getMigrationsLockPath(): string {
  return path.join(LOCKS_DIR, 'migrations.lock')
}

export function getMigrationCollectionKey(config: Config = DEFAULT_CONFIG): string {
  const dir = canonicalizePath(resolveDirectory(config.lancedb.directory))
  return `${dir}::${config.lancedb.table}`
}

export function emptyMigrationsState(): MigrationsStateFile {
  return { version: 1, collections: {} }
}

function coerceAppliedEntry(value: unknown): AppliedMigrationEntry | null {
  if (!isPlainObject(value)) return null
  const appliedAt = asInteger(value.appliedAt)
  if (appliedAt === null) return null

  const entry: AppliedMigrationEntry = { appliedAt }
  const scanned = asInteger(value.scanned)
  if (scanned !== null) entry.scanned = scanned
  const updated = asInteger(value.updated)
  if (updated !== null) entry.updated = updated

  if (isPlainObject(value.details)) {
    const details: Record<string, number> = {}
    for (const [k, v] of Object.entries(value.details)) {
      const intVal = asInteger(v)
      if (intVal !== null) details[k] = intVal
    }
    if (Object.keys(details).length > 0) entry.details = details
  }

  return entry
}

function coerceCollectionState(value: unknown): CollectionMigrationState | null {
  if (!isPlainObject(value) || !isPlainObject(value.applied)) return null
  const applied: Record<string, AppliedMigrationEntry> = {}
  for (const [id, rawEntry] of Object.entries(value.applied)) {
    const coerced = coerceAppliedEntry(rawEntry)
    if (coerced) applied[id] = coerced
  }
  const updatedAt = asInteger(value.updatedAt) ?? 0
  return { applied, updatedAt }
}

function coerceMigrationsStateFile(value: unknown): MigrationsStateFile | null {
  if (!isPlainObject(value) || !isPlainObject(value.collections)) return null
  const collections: Record<string, CollectionMigrationState> = {}
  for (const [key, rawState] of Object.entries(value.collections)) {
    const coerced = coerceCollectionState(rawState)
    if (coerced) collections[key] = coerced
  }
  return { version: 1, collections }
}

export function loadMigrationsState(statePath: string = getMigrationsStatePath()): MigrationsStateFile {
  return readJsonFileSafe<MigrationsStateFile>(statePath, {
    fallback: emptyMigrationsState(),
    errorMessage: '[claude-memory] Failed to load migrations state:',
    coerce: coerceMigrationsStateFile
  }) ?? emptyMigrationsState()
}

export function saveMigrationsState(state: MigrationsStateFile, statePath: string): void {
  writeJsonFile(statePath, state, { ensureDir: true, pretty: 2 })
}

/**
 * Remove the recorded migration state for a single collection (e.g. after resetCollection),
 * preserving entries for all other collections. Acquires the migrations lock when the
 * state file exists so concurrent runners do not lose updates.
 */
export function clearCollectionMigrationState(
  config: Config = DEFAULT_CONFIG,
  options: { statePath?: string; lockPath?: string } = {}
): boolean {
  const statePath = options.statePath ?? getMigrationsStatePath()
  if (!fs.existsSync(statePath)) return false

  const lockPath = options.lockPath ?? getMigrationsLockPath()
  const collectionKey = getMigrationCollectionKey(config)
  const lockHandle = acquireFileLock(lockPath, {
    staleAfterMs: MIGRATIONS_LOCK_STALE_MS,
    staleStrategy: 'pid',
    ensureDir: true,
    proceedOnError: false,
    wait: { maxWaitMs: CLEAR_STATE_LOCK_WAIT_MS, retryDelayMs: 25 },
    write: { data: () => `${process.pid}\n${Date.now()}` }
  })
  if (!lockHandle) return false

  try {
    const state = loadMigrationsState(statePath)
    if (!Object.prototype.hasOwnProperty.call(state.collections, collectionKey)) {
      return false
    }
    delete state.collections[collectionKey]
    saveMigrationsState(state, statePath)
    return true
  } finally {
    lockHandle.release()
  }
}
