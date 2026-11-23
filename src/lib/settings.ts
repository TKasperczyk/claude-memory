import fs from 'fs'
import path from 'path'
import { isPlainObject } from './parsing.js'
import { acquireFileLock } from './lock.js'
import type { MaintenanceSettings, ModelSettings, RetrievalSettings, Settings } from '../../shared/types.js'
import { CLAUDE_MEMORY_ROOT } from './paths.js'
import {
  ALL_SETTINGS_FIELDS,
  CURRENT_SETTINGS_VERSION,
  DEFAULT_MAINTENANCE_SETTINGS,
  DEFAULT_MODEL_SETTINGS,
  DEFAULT_RETRIEVAL_SETTINGS,
  DEFAULT_SETTINGS,
  HISTORICAL_DEFAULT_SETTINGS,
  MAINTENANCE_FIELDS,
  MODEL_FIELDS,
  RETRIEVAL_FIELDS,
  SETTING_RULES,
  type NumericSettingRule,
  type SettingsFieldDefinition
} from './settings-schema.js'

export type { MaintenanceSettings, ModelSettings, RetrievalSettings, Settings } from '../../shared/types.js'
export { CURRENT_SETTINGS_VERSION, HISTORICAL_DEFAULT_SETTINGS } from './settings-schema.js'

const SETTINGS_DIR = CLAUDE_MEMORY_ROOT
const SETTINGS_PATH = path.join(SETTINGS_DIR, 'settings.json')
const SETTINGS_LOCK_PATH = path.join(SETTINGS_DIR, 'locks', 'settings.lock')
const SETTINGS_LOCK_STALE_MS = 60_000
const SETTINGS_LOCK_WAIT_MS = 2_000
const MAX_SYMLINK_DEPTH = 16

const KNOWN_SETTING_KEYS = new Set<string>(ALL_SETTINGS_FIELDS.map(field => field.key))
const SECTION_SETTING_KEYS: Record<string, ReadonlySet<string>> = {
  retrieval: new Set<string>(RETRIEVAL_FIELDS.map(field => field.key)),
  maintenance: new Set<string>(MAINTENANCE_FIELDS.map(field => field.key)),
  models: new Set<string>(MODEL_FIELDS.map(field => field.key))
}

export type PersistedSettingsFile = {
  settingsVersion: number
} & Partial<Settings>

export interface SettingsFileOptions {
  settingsPath?: string
  lockPath?: string
}

export interface MigrateSettingsOptions extends SettingsFileOptions {
  dryRun?: boolean
  backupPath?: string
}

export type SettingsMigrationStatus = 'up-to-date' | 'would-run' | 'migrated' | 'skipped' | 'failed'
export type SettingsMigrationSkipReason = 'no-file' | 'locked' | 'invalid-file'

export interface SettingsMigrationResult {
  status: SettingsMigrationStatus
  skipReason?: SettingsMigrationSkipReason
  fromVersion?: number
  toVersion: number
  backupPath?: string
  droppedKeys: string[]
  keptKeys: string[]
  error?: string
}

type RawSettingsReadResult =
  | { kind: 'missing' }
  | { kind: 'io-error'; error: unknown }
  | { kind: 'invalid'; rawText: string; error: string }
  | { kind: 'ok'; rawText: string; parsed: Record<string, unknown> }

type LegacyMigrationPlan = {
  sparseFile: PersistedSettingsFile
  overrides: Partial<Settings>
  droppedKeys: string[]
  keptKeys: string[]
}

export function getSettingsPath(): string {
  return SETTINGS_PATH
}

export function getSettingsLockPath(): string {
  return SETTINGS_LOCK_PATH
}

function resolveFileAndLockPaths(options?: SettingsFileOptions): { settingsPath: string; lockPath: string } {
  const settingsPath = options?.settingsPath ?? SETTINGS_PATH
  const lockPath = options?.lockPath ?? (
    options?.settingsPath
      ? path.join(path.dirname(settingsPath), 'locks', 'settings.lock')
      : SETTINGS_LOCK_PATH
  )
  return { settingsPath, lockPath }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function normalizeSettingValue<T extends number | boolean | string>(value: T): T {
  if (typeof value === 'number' && value === 0) {
    return 0 as T
  }
  return value
}

export function getDefaultRetrievalSettings(): RetrievalSettings {
  return { ...DEFAULT_RETRIEVAL_SETTINGS }
}

export function getDefaultMaintenanceSettings(): MaintenanceSettings {
  return { ...DEFAULT_MAINTENANCE_SETTINGS }
}

export function getDefaultModelSettings(): ModelSettings {
  return { ...DEFAULT_MODEL_SETTINGS }
}

export function getDefaultSettings(): Settings {
  return { ...DEFAULT_SETTINGS }
}

export function isHistoricalDefault<K extends keyof Settings>(key: K, value: Settings[K]): boolean {
  const historical = HISTORICAL_DEFAULT_SETTINGS[key] as readonly Settings[K][] | undefined
  if (!historical) return false
  return historical.includes(value)
}

function readSettingsVersion(raw: Record<string, unknown>): number | undefined {
  const value = raw.settingsVersion
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1) {
    return value
  }
  return undefined
}

function readRawSettingsFile(settingsPath: string): RawSettingsReadResult {
  let rawText: string
  try {
    rawText = fs.readFileSync(settingsPath, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'missing' }
    }
    return { kind: 'io-error', error }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawText) as unknown
  } catch (error) {
    return { kind: 'invalid', rawText, error: `settings.json is not valid JSON: ${toErrorMessage(error)}` }
  }

  if (!isPlainObject(parsed)) {
    return { kind: 'invalid', rawText, error: 'settings.json must be a JSON object' }
  }

  return { kind: 'ok', rawText, parsed }
}

function extractRawFieldValue(
  raw: Record<string, unknown>,
  field: SettingsFieldDefinition
): { present: boolean; value: unknown } {
  const sectionKey = field.group.section
  const nested = raw[sectionKey]
  if (isPlainObject(nested) && Object.prototype.hasOwnProperty.call(nested, field.key)) {
    return { present: true, value: nested[field.key] }
  }
  if (Object.prototype.hasOwnProperty.call(raw, field.key)) {
    return { present: true, value: raw[field.key] }
  }
  return { present: false, value: undefined }
}

function extractV2Overrides(raw: Record<string, unknown>): Partial<Settings> {
  const overrides: Record<string, number | boolean | string> = {}
  for (const field of ALL_SETTINGS_FIELDS) {
    const extracted = extractRawFieldValue(raw, field)
    if (!extracted.present) continue
    const validation = validateSettingValue(field.key, extracted.value)
    if (!validation.ok) continue
    overrides[field.key] = normalizeSettingValue(validation.normalized)
  }
  return overrides as Partial<Settings>
}

export function buildSparseSettingsFile(settings: Settings): PersistedSettingsFile {
  const output: Record<string, number | boolean | string> = {
    settingsVersion: CURRENT_SETTINGS_VERSION
  }
  for (const field of ALL_SETTINGS_FIELDS) {
    const value = normalizeSettingValue(settings[field.key])
    const defaultValue = normalizeSettingValue(DEFAULT_SETTINGS[field.key])
    if (value !== defaultValue) {
      output[field.key] = value
    }
  }
  return output as PersistedSettingsFile
}

function planLegacyMigration(raw: Record<string, unknown>): LegacyMigrationPlan {
  const overrides: Record<string, number | boolean | string> = {}
  const droppedKeys: string[] = []
  const keptKeys: string[] = []

  for (const field of ALL_SETTINGS_FIELDS) {
    const extracted = extractRawFieldValue(raw, field)
    if (!extracted.present) continue

    const validation = validateSettingValue(field.key, extracted.value)
    if (!validation.ok) {
      droppedKeys.push(field.key)
      continue
    }

    const normalized = normalizeSettingValue(validation.normalized)
    const defaultValue = normalizeSettingValue(DEFAULT_SETTINGS[field.key])
    if (normalized === defaultValue || isHistoricalDefault(field.key, normalized as never)) {
      droppedKeys.push(field.key)
      continue
    }

    overrides[field.key] = normalized
    keptKeys.push(field.key)
  }

  for (const [key, value] of Object.entries(raw)) {
    if (key === 'settingsVersion' || KNOWN_SETTING_KEYS.has(key)) continue
    const sectionKeys = SECTION_SETTING_KEYS[key]
    if (sectionKeys && isPlainObject(value)) {
      for (const nestedKey of Object.keys(value)) {
        if (!sectionKeys.has(nestedKey)) {
          droppedKeys.push(`${key}.${nestedKey}`)
        }
      }
      continue
    }
    droppedKeys.push(key)
  }

  const sparseFile: PersistedSettingsFile = {
    settingsVersion: CURRENT_SETTINGS_VERSION,
    ...(overrides as Partial<Settings>)
  }

  return {
    sparseFile,
    overrides: overrides as Partial<Settings>,
    droppedKeys,
    keptKeys
  }
}

function resolveOverridesFromRaw(raw: Record<string, unknown>): Partial<Settings> {
  const version = readSettingsVersion(raw)
  if (version !== undefined && version >= CURRENT_SETTINGS_VERSION) {
    return extractV2Overrides(raw)
  }
  return planLegacyMigration(raw).overrides
}

function resolveWriteTargetPath(filePath: string): string {
  let current = filePath
  for (let depth = 0; depth < MAX_SYMLINK_DEPTH; depth += 1) {
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return current
      throw error
    }
    if (!stat.isSymbolicLink()) return current
    try {
      return fs.realpathSync(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      current = path.resolve(path.dirname(current), fs.readlinkSync(current))
    }
  }
  return current
}

function getFileModeIfExists(filePath: string): number | undefined {
  try {
    return fs.statSync(filePath).mode & 0o777
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function writeSettingsFileAtomic(settingsPath: string, payload: PersistedSettingsFile): void {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
  const destinationPath = resolveWriteTargetPath(settingsPath)
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true })
  const mode = getFileModeIfExists(destinationPath)

  const tmpPath = path.join(
    path.dirname(destinationPath),
    `.${path.basename(destinationPath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  )
  try {
    fs.writeFileSync(
      tmpPath,
      `${JSON.stringify(payload, null, 2)}\n`,
      { encoding: 'utf-8', flag: 'wx', ...(mode !== undefined ? { mode } : {}) }
    )
    if (mode !== undefined) {
      fs.chmodSync(tmpPath, mode)
    }
    fs.renameSync(tmpPath, destinationPath)
  } catch (error) {
    try {
      fs.unlinkSync(tmpPath)
    } catch {
      // Ignore temp cleanup failure and surface original error
    }
    throw error
  }
}

function createExclusiveBackup(settingsPath: string, rawText: string, preferredBackupPath?: string): string {
  const basePath = preferredBackupPath ?? `${settingsPath}.bak-pre-v2`
  fs.mkdirSync(path.dirname(basePath), { recursive: true })
  const mode = getFileModeIfExists(settingsPath)
  const writeOpts: fs.WriteFileOptions = {
    encoding: 'utf-8',
    flag: 'wx',
    ...(mode !== undefined ? { mode } : {})
  }

  try {
    fs.writeFileSync(basePath, rawText, writeOpts)
    return basePath
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }

  const stamp = Date.now()
  for (let suffix = 0; suffix < 100; suffix += 1) {
    const candidate = suffix === 0 ? `${basePath}-${stamp}` : `${basePath}-${stamp}-${suffix}`
    try {
      fs.writeFileSync(candidate, rawText, writeOpts)
      return candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }

  throw new Error(`Failed to allocate unique settings backup path near ${basePath}`)
}

function loadPersistedSettings(options?: SettingsFileOptions): Settings {
  const { settingsPath } = resolveFileAndLockPaths(options)
  const defaults = getDefaultSettings()
  const raw = readRawSettingsFile(settingsPath)

  if (raw.kind === 'missing') return defaults
  if (raw.kind === 'io-error') {
    console.error('[claude-memory] Failed to load settings:', raw.error)
    return defaults
  }
  if (raw.kind === 'invalid') {
    console.error('[claude-memory] Failed to load settings:', raw.error)
    return defaults
  }

  const overrides = resolveOverridesFromRaw(raw.parsed)
  return { ...defaults, ...overrides }
}

/**
 * Load effective settings (read-only; never mutates disk or acquires locks).
 * Unmigrated pre-v2 files have superseded historical defaults stripped in memory
 * so hooks such as pre-prompt immediately inherit new defaults without risking
 * filesystem writes or lock contention on the hot path.
 */
export function loadSettings(options?: SettingsFileOptions): Settings {
  return applyEnvOverrides(loadPersistedSettings(options))
}

/**
 * Apply environment variable overrides to settings.
 * Env vars use the pattern CC_MEMORIES_SETTING_<KEY> where KEY is the
 * camelCase setting name in SCREAMING_SNAKE_CASE.
 * Example: CC_MEMORIES_SETTING_MIN_SEMANTIC_SIMILARITY=0.4
 */
function applyEnvOverrides(settings: Settings): Settings {
  const result = { ...settings }
  const ENV_PREFIX = 'CC_MEMORIES_SETTING_'
  const envKeys = Object.keys(process.env).filter(key => key.startsWith(ENV_PREFIX))
  if (envKeys.length === 0) return result

  for (const envKey of envKeys) {
    const rawValue = process.env[envKey]
    if (rawValue === undefined || rawValue === '') continue

    const snakeKey = envKey.slice(ENV_PREFIX.length).toLowerCase()
    const camelKey = snakeToCamel(snakeKey) as keyof Settings

    if (!(camelKey in result)) continue

    const rule = SETTING_RULES[camelKey]
    if (!rule) continue

    const validation = validateSettingValue(camelKey, rawValue)
    if (validation.ok) {
      ;(result as Record<string, unknown>)[camelKey] = normalizeSettingValue(validation.normalized)
    }
  }

  return result
}

function snakeToCamel(snake: string): string {
  return snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
}

export function resolveMaintenanceSettings(settings?: MaintenanceSettings): MaintenanceSettings {
  return settings ?? loadSettings()
}

export function resolveMaintenanceModel(): string {
  const envOverride = process.env.CC_MAINTENANCE_MODEL?.trim()
  if (envOverride) return envOverride
  return loadSettings().maintenanceModel
}

/**
 * One-time migration from unversioned / v1 full settings.json to sparse v2
 * overrides (`settingsVersion: 2`).
 *
 * - O(1) lock-free fast path when settings.json is absent or already >= v2.
 * - Supports dry-run inspection without acquiring locks or mutating disk.
 * - Creates an exclusive pre-migration backup (`settings.json.bak-pre-v2`)
 *   before atomically replacing settings.json.
 * - Drops keys matching current defaults, known historical defaults, or
 *   removed/invalid fields while preserving genuine user overrides.
 */
export function migrateSettingsIfNeeded(options: MigrateSettingsOptions = {}): SettingsMigrationResult {
  const { settingsPath, lockPath } = resolveFileAndLockPaths(options)
  const dryRun = options.dryRun ?? false

  const initial = readRawSettingsFile(settingsPath)
  if (initial.kind === 'missing') {
    return {
      status: 'up-to-date',
      skipReason: 'no-file',
      toVersion: CURRENT_SETTINGS_VERSION,
      droppedKeys: [],
      keptKeys: []
    }
  }
  if (initial.kind === 'io-error') {
    return {
      status: 'failed',
      toVersion: CURRENT_SETTINGS_VERSION,
      droppedKeys: [],
      keptKeys: [],
      error: toErrorMessage(initial.error)
    }
  }
  if (initial.kind === 'invalid') {
    return {
      status: 'skipped',
      skipReason: 'invalid-file',
      toVersion: CURRENT_SETTINGS_VERSION,
      droppedKeys: [],
      keptKeys: [],
      error: initial.error
    }
  }

  const initialVersion = readSettingsVersion(initial.parsed)
  if (initialVersion !== undefined && initialVersion >= CURRENT_SETTINGS_VERSION) {
    return {
      status: 'up-to-date',
      fromVersion: initialVersion,
      toVersion: CURRENT_SETTINGS_VERSION,
      droppedKeys: [],
      keptKeys: Object.keys(extractV2Overrides(initial.parsed))
    }
  }

  if (dryRun) {
    const plan = planLegacyMigration(initial.parsed)
    return {
      status: 'would-run',
      fromVersion: initialVersion ?? 1,
      toVersion: CURRENT_SETTINGS_VERSION,
      backupPath: options.backupPath ?? `${settingsPath}.bak-pre-v2`,
      droppedKeys: plan.droppedKeys,
      keptKeys: plan.keptKeys
    }
  }

  let lockHandle: ReturnType<typeof acquireFileLock>
  try {
    lockHandle = acquireFileLock(lockPath, {
      staleAfterMs: SETTINGS_LOCK_STALE_MS,
      staleStrategy: 'pid',
      ensureDir: true,
      proceedOnError: false,
      wait: { maxWaitMs: SETTINGS_LOCK_WAIT_MS, retryDelayMs: 20 },
      write: { data: () => `${process.pid}\n${Date.now()}` }
    })
  } catch (error) {
    return {
      status: 'failed',
      fromVersion: initialVersion ?? 1,
      toVersion: CURRENT_SETTINGS_VERSION,
      droppedKeys: [],
      keptKeys: [],
      error: `Failed to acquire settings lock: ${toErrorMessage(error)}`
    }
  }

  if (!lockHandle) {
    return {
      status: 'skipped',
      skipReason: 'locked',
      fromVersion: initialVersion ?? 1,
      toVersion: CURRENT_SETTINGS_VERSION,
      droppedKeys: [],
      keptKeys: []
    }
  }

  try {
    // Re-read inside lock in case another process already migrated or removed the file.
    const fresh = readRawSettingsFile(settingsPath)
    if (fresh.kind === 'missing') {
      return {
        status: 'up-to-date',
        skipReason: 'no-file',
        toVersion: CURRENT_SETTINGS_VERSION,
        droppedKeys: [],
        keptKeys: []
      }
    }
    if (fresh.kind === 'io-error') {
      return {
        status: 'failed',
        toVersion: CURRENT_SETTINGS_VERSION,
        droppedKeys: [],
        keptKeys: [],
        error: toErrorMessage(fresh.error)
      }
    }
    if (fresh.kind === 'invalid') {
      return {
        status: 'skipped',
        skipReason: 'invalid-file',
        toVersion: CURRENT_SETTINGS_VERSION,
        droppedKeys: [],
        keptKeys: [],
        error: fresh.error
      }
    }

    const freshVersion = readSettingsVersion(fresh.parsed)
    if (freshVersion !== undefined && freshVersion >= CURRENT_SETTINGS_VERSION) {
      return {
        status: 'up-to-date',
        fromVersion: freshVersion,
        toVersion: CURRENT_SETTINGS_VERSION,
        droppedKeys: [],
        keptKeys: Object.keys(extractV2Overrides(fresh.parsed))
      }
    }

    const plan = planLegacyMigration(fresh.parsed)
    const backupPath = createExclusiveBackup(settingsPath, fresh.rawText, options.backupPath)
    writeSettingsFileAtomic(settingsPath, plan.sparseFile)

    return {
      status: 'migrated',
      fromVersion: freshVersion ?? 1,
      toVersion: CURRENT_SETTINGS_VERSION,
      backupPath,
      droppedKeys: plan.droppedKeys,
      keptKeys: plan.keptKeys
    }
  } catch (error) {
    return {
      status: 'failed',
      fromVersion: initialVersion ?? 1,
      toVersion: CURRENT_SETTINGS_VERSION,
      droppedKeys: [],
      keptKeys: [],
      error: toErrorMessage(error)
    }
  } finally {
    lockHandle.release()
  }
}

export function saveSettings(settings: Partial<Settings>, options?: SettingsFileOptions): void {
  const { settingsPath, lockPath } = resolveFileAndLockPaths(options)
  const lockHandle = acquireFileLock(lockPath, {
    staleAfterMs: SETTINGS_LOCK_STALE_MS,
    staleStrategy: 'pid',
    ensureDir: true,
    proceedOnError: false,
    wait: { maxWaitMs: SETTINGS_LOCK_WAIT_MS, retryDelayMs: 20 },
    write: { data: () => `${process.pid}\n${Date.now()}` }
  })
  if (!lockHandle) {
    throw new Error('Timed out waiting for settings lock')
  }

  try {
    const defaults = getDefaultSettings()
    const raw = readRawSettingsFile(settingsPath)
    let current = defaults
    let futureVersion: number | undefined
    let preservedFutureFields: Record<string, unknown> | undefined

    if (raw.kind === 'io-error') {
      throw raw.error
    } else if (raw.kind === 'invalid') {
      try {
        createExclusiveBackup(settingsPath, raw.rawText, `${settingsPath}.bak-corrupt`)
      } catch (backupError) {
        console.error('[claude-memory] Failed to back up corrupt settings.json before overwrite:', backupError)
      }
    } else if (raw.kind === 'ok') {
      const version = readSettingsVersion(raw.parsed)
      if (version !== undefined && version >= CURRENT_SETTINGS_VERSION) {
        current = { ...defaults, ...extractV2Overrides(raw.parsed) }
        if (version > CURRENT_SETTINGS_VERSION) {
          futureVersion = version
          preservedFutureFields = {}
          for (const [key, value] of Object.entries(raw.parsed)) {
            if (key !== 'settingsVersion' && !KNOWN_SETTING_KEYS.has(key)) {
              preservedFutureFields[key] = value
            }
          }
        }
      } else {
        const plan = planLegacyMigration(raw.parsed)
        createExclusiveBackup(settingsPath, raw.rawText)
        current = { ...defaults, ...plan.overrides }
      }
    }

    const merged = coerceSettings({ ...current, ...settings }, current)
    const sparse = buildSparseSettingsFile(merged)
    const payload: PersistedSettingsFile = futureVersion !== undefined
      ? { ...sparse, settingsVersion: futureVersion, ...preservedFutureFields }
      : sparse
    writeSettingsFileAtomic(settingsPath, payload)
  } finally {
    lockHandle.release()
  }
}

export function resetSettings(options?: SettingsFileOptions): void {
  const { settingsPath, lockPath } = resolveFileAndLockPaths(options)
  const lockHandle = acquireFileLock(lockPath, {
    staleAfterMs: SETTINGS_LOCK_STALE_MS,
    staleStrategy: 'pid',
    ensureDir: true,
    proceedOnError: false,
    wait: { maxWaitMs: SETTINGS_LOCK_WAIT_MS, retryDelayMs: 20 },
    write: { data: () => `${process.pid}\n${Date.now()}` }
  })
  if (!lockHandle) {
    throw new Error('Timed out waiting for settings lock')
  }

  try {
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(settingsPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }

    if (stat.isSymbolicLink()) {
      const destinationPath = resolveWriteTargetPath(settingsPath)
      if (fs.existsSync(destinationPath)) {
        writeSettingsFileAtomic(settingsPath, { settingsVersion: CURRENT_SETTINGS_VERSION })
      }
      return
    }

    fs.unlinkSync(settingsPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  } finally {
    lockHandle.release()
  }
}

function coerceSettings(value: unknown, fallback: Settings): Settings {
  const raw = isPlainObject(value) ? value : {}
  const retrievalSource = isPlainObject(raw.retrieval) ? raw.retrieval : raw
  const maintenanceSource = isPlainObject(raw.maintenance) ? raw.maintenance : raw
  const modelSource = isPlainObject(raw.models) ? raw.models : raw
  return {
    ...coerceRetrievalSettings(retrievalSource, fallback),
    ...coerceMaintenanceSettings(maintenanceSource, fallback),
    ...coerceModelSettings(modelSource, fallback)
  }
}

type SettingValidationResult = { ok: true; normalized: number | boolean | string } | { ok: false; error: string }

export function validateSettingValue(setting: keyof Settings, value: unknown): SettingValidationResult {
  const rule = SETTING_RULES[setting]
  if (rule.kind === 'text') {
    const str = typeof value === 'string' ? value.trim() : ''
    if (!str) return { ok: false, error: 'value must be a non-empty string' }
    if (!rule.allowCustom && rule.options && !rule.options.includes(str)) {
      return { ok: false, error: `value must be one of: ${rule.options.join(', ')}` }
    }
    return { ok: true, normalized: str }
  }
  if (rule.kind === 'bool') {
    if (typeof value === 'boolean') return { ok: true, normalized: value }
    if (value === 'true') return { ok: true, normalized: true }
    if (value === 'false') return { ok: true, normalized: false }
    return { ok: false, error: 'value must be a boolean' }
  }
  return validateNumericSetting(rule, value)
}

function coerceSettingsByFields<T extends Partial<Settings>>(
  fields: SettingsFieldDefinition[],
  value: Record<string, unknown>,
  fallback: Settings
): T {
  const output: Record<string, number | boolean | string> = {}
  for (const field of fields) {
    const fallbackValue = fallback[field.key]
    const rule = SETTING_RULES[field.key]
    if (rule.kind === 'text') {
      const raw = value[field.key]
      const str = typeof raw === 'string' ? raw.trim() : ''
      const validation = validateSettingValue(field.key, str)
      output[field.key] = validation.ok ? validation.normalized as string : (fallbackValue as string)
      continue
    }
    if (rule.kind === 'bool') {
      output[field.key] = coerceBooleanValue(value[field.key], fallbackValue as boolean)
      continue
    }
    output[field.key] = coerceSettingValue(rule, value[field.key], fallbackValue as number)
  }
  return output as T
}

export function coerceRetrievalSettings(value: Record<string, unknown>, fallback: RetrievalSettings): RetrievalSettings {
  return coerceSettingsByFields<RetrievalSettings>(RETRIEVAL_FIELDS, value, fallback as Settings)
}

function coerceMaintenanceSettings(value: Record<string, unknown>, fallback: MaintenanceSettings): MaintenanceSettings {
  return coerceSettingsByFields<MaintenanceSettings>(MAINTENANCE_FIELDS, value, fallback as Settings)
}

function coerceModelSettings(value: Record<string, unknown>, fallback: ModelSettings): ModelSettings {
  return coerceSettingsByFields<ModelSettings>(MODEL_FIELDS, value, fallback as Settings)
}

function coerceSettingValue(rule: NumericSettingRule, value: unknown, fallback: number): number {
  const validation = validateNumericSetting(rule, value)
  return validation.ok ? normalizeSettingValue(validation.normalized as number) : fallback
}

function coerceBooleanValue(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

function validateNumericSetting(rule: NumericSettingRule, value: unknown): SettingValidationResult {
  const parsed = parseNumber(value)
  if (parsed === null) {
    return { ok: false, error: 'value must be a number' }
  }

  if (rule.kind === 'int' && !Number.isInteger(parsed)) {
    return { ok: false, error: 'value must be a whole number' }
  }

  if (rule.min !== undefined && rule.max !== undefined) {
    if (parsed < rule.min || parsed > rule.max) {
      return { ok: false, error: `value must be between ${rule.min} and ${rule.max}` }
    }
  } else if (rule.min !== undefined && parsed < rule.min) {
    return { ok: false, error: `value must be >= ${rule.min}` }
  } else if (rule.max !== undefined && parsed > rule.max) {
    return { ok: false, error: `value must be <= ${rule.max}` }
  }

  const normalized = normalizeSettingValue(rule.kind === 'int' ? Math.trunc(parsed) : parsed)
  return { ok: true, normalized }
}

function parseNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}
