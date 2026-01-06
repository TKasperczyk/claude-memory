import fs from 'fs'
import path from 'path'
import { homedir } from 'os'

export interface RetrievalSettings {
  minSemanticSimilarity: number
  minScore: number
  minSemanticOnlyScore: number
  maxRecords: number
  maxTokens: number
  mmrLambda: number
  usageRatioWeight: number
}

const SETTINGS_DIR = path.join(homedir(), '.claude-memory')
const SETTINGS_PATH = path.join(SETTINGS_DIR, 'settings.json')

export function getDefaultSettings(): RetrievalSettings {
  return {
    minSemanticSimilarity: 0.70,
    minScore: 0.45,
    minSemanticOnlyScore: 0.65,
    maxRecords: 5,
    maxTokens: 2000,
    mmrLambda: 0.7,
    usageRatioWeight: 0.2
  }
}

export function loadSettings(): RetrievalSettings {
  const defaults = getDefaultSettings()
  if (!fs.existsSync(SETTINGS_PATH)) return defaults

  try {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (!isPlainObject(parsed)) return defaults
    return coerceSettings(parsed, defaults)
  } catch (error) {
    console.error('[claude-memory] Failed to load settings:', error)
    return defaults
  }
}

export function saveSettings(settings: Partial<RetrievalSettings>): void {
  const current = loadSettings()
  const merged = coerceSettings(settings, current)
  fs.mkdirSync(SETTINGS_DIR, { recursive: true })
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2))
}

export function resetSettings(): void {
  if (!fs.existsSync(SETTINGS_PATH)) return
  fs.unlinkSync(SETTINGS_PATH)
}

function coerceSettings(value: unknown, fallback: RetrievalSettings): RetrievalSettings {
  const raw = isPlainObject(value) ? value : {}
  return {
    minSemanticSimilarity: coerceFloat(raw.minSemanticSimilarity, fallback.minSemanticSimilarity, 0, 1),
    minScore: coerceFloat(raw.minScore, fallback.minScore, 0, 1),
    minSemanticOnlyScore: coerceFloat(raw.minSemanticOnlyScore, fallback.minSemanticOnlyScore, 0, 1),
    maxRecords: coerceInt(raw.maxRecords, fallback.maxRecords, 1),
    maxTokens: coerceInt(raw.maxTokens, fallback.maxTokens, 1),
    mmrLambda: coerceFloat(raw.mmrLambda, fallback.mmrLambda, 0, 1),
    usageRatioWeight: coerceFloat(raw.usageRatioWeight, fallback.usageRatioWeight, 0, 1)
  }
}

function coerceFloat(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = parseNumber(value)
  if (parsed === null) return fallback
  if (parsed < min || parsed > max) return fallback
  return parsed
}

function coerceInt(value: unknown, fallback: number, min: number): number {
  const parsed = parseNumber(value)
  if (parsed === null) return fallback
  const rounded = Math.trunc(parsed)
  if (rounded < min) return fallback
  return rounded
}

function parseNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
