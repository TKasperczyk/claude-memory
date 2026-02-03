import fs from 'fs'
import path from 'path'
import { homedir } from 'os'
import { isPlainObject } from './parsing.js'
import { readJsonFile, writeJsonFile } from './json.js'
import type { MaintenanceSettings, RetrievalSettings, Settings } from '../../shared/types.js'
import {
  DEFAULT_MAINTENANCE_SETTINGS,
  DEFAULT_RETRIEVAL_SETTINGS,
  DEFAULT_SETTINGS,
  MAINTENANCE_FIELDS,
  RETRIEVAL_FIELDS,
  SETTING_RULES,
  type NumericSettingRule,
  type SettingsFieldDefinition
} from './settings-schema.js'

export type { MaintenanceSettings, RetrievalSettings, Settings } from '../../shared/types.js'

const SETTINGS_DIR = path.join(homedir(), '.claude-memory')
const SETTINGS_PATH = path.join(SETTINGS_DIR, 'settings.json')

export function getDefaultRetrievalSettings(): RetrievalSettings {
  return { ...DEFAULT_RETRIEVAL_SETTINGS }
}

export function getDefaultMaintenanceSettings(): MaintenanceSettings {
  return { ...DEFAULT_MAINTENANCE_SETTINGS }
}

export function getDefaultSettings(): Settings {
  return { ...DEFAULT_SETTINGS }
}

export function loadSettings(): Settings {
  const defaults = getDefaultSettings()
  return readJsonFile(SETTINGS_PATH, {
    fallback: defaults,
    onError: error => console.error('[claude-memory] Failed to load settings:', error),
    coerce: data => {
      if (!isPlainObject(data)) return defaults
      return coerceSettings(data, defaults)
    }
  }) ?? defaults
}

export function resolveMaintenanceSettings(settings?: MaintenanceSettings): MaintenanceSettings {
  return settings ?? loadSettings()
}

export function saveSettings(settings: Partial<Settings>): void {
  const current = loadSettings()
  const merged = coerceSettings({ ...current, ...settings }, current)
  writeJsonFile(SETTINGS_PATH, merged, { ensureDir: true, pretty: 2 })
}

export function resetSettings(): void {
  if (!fs.existsSync(SETTINGS_PATH)) return
  fs.unlinkSync(SETTINGS_PATH)
}

function coerceSettings(value: unknown, fallback: Settings): Settings {
  const raw = isPlainObject(value) ? value : {}
  const retrievalSource = isPlainObject(raw.retrieval) ? raw.retrieval : raw
  const maintenanceSource = isPlainObject(raw.maintenance) ? raw.maintenance : raw
  return {
    ...coerceRetrievalSettings(retrievalSource, fallback),
    ...coerceMaintenanceSettings(maintenanceSource, fallback)
  }
}

type SettingValidationResult = { ok: true; normalized: number | boolean } | { ok: false; error: string }

export function validateSettingValue(setting: keyof Settings, value: unknown): SettingValidationResult {
  const rule = SETTING_RULES[setting]
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
  const output: Record<string, number | boolean> = {}
  for (const field of fields) {
    const fallbackValue = fallback[field.key]
    const rule = SETTING_RULES[field.key]
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

function coerceSettingValue(rule: NumericSettingRule, value: unknown, fallback: number): number {
  const validation = validateNumericSetting(rule, value)
  return validation.ok ? validation.normalized as number : fallback
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

  const normalized = rule.kind === 'int' ? Math.trunc(parsed) : parsed
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
