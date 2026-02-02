import fs from 'fs'
import path from 'path'
import { homedir } from 'os'
import { isPlainObject } from './parsing.js'
import { readJsonFile, writeJsonFile } from './json.js'
import { SIMILARITY_THRESHOLDS } from './types.js'
import type { MaintenanceSettings, RetrievalSettings, Settings } from '../../shared/types.js'

export type { MaintenanceSettings, RetrievalSettings, Settings } from '../../shared/types.js'

const SETTINGS_DIR = path.join(homedir(), '.claude-memory')
const SETTINGS_PATH = path.join(SETTINGS_DIR, 'settings.json')

type NumericSettingRule = { kind: 'int' | 'float'; min?: number; max?: number }
type BooleanSettingRule = { kind: 'bool' }
type SettingRule = NumericSettingRule | BooleanSettingRule

const SETTING_RULES = {
  minSemanticSimilarity: { kind: 'float', min: 0, max: 1 },
  minScore: { kind: 'float', min: 0, max: 1 },
  minSemanticOnlyScore: { kind: 'float', min: 0, max: 1 },
  maxRecords: { kind: 'int', min: 1, max: 20 },
  maxTokens: { kind: 'int', min: 1, max: 10000 },
  mmrLambda: { kind: 'float', min: 0, max: 1 },
  usageRatioWeight: { kind: 'float', min: 0, max: 1 },
  enableHaikuRetrieval: { kind: 'bool' },
  maxKeywordQueries: { kind: 'int', min: 1 },
  maxKeywordErrors: { kind: 'int', min: 1 },
  maxKeywordCommands: { kind: 'int', min: 1 },
  prePromptTimeoutMs: { kind: 'int', min: 1 },
  haikuQueryTimeoutMs: { kind: 'int', min: 1 },
  maxSemanticQueryChars: { kind: 'int', min: 1 },
  staleDays: { kind: 'int', min: 1 },
  discoveryMaxAgeDays: { kind: 'int', min: 1 },
  lowUsageMinRetrievals: { kind: 'int', min: 1 },
  lowUsageRatioThreshold: { kind: 'float', min: 0, max: 1 },
  lowUsageHighRetrievalMin: { kind: 'int', min: 1 },
  staleUnusedDays: { kind: 'int', min: 1 },
  consolidationSearchLimit: { kind: 'int', min: 1 },
  consolidationMaxClusterSize: { kind: 'int', min: 1 },
  consolidationThreshold: { kind: 'float', min: 0, max: 1 },
  consolidationRecheckDays: { kind: 'int', min: 1 },
  crossTypeConsolidationThreshold: { kind: 'float', min: 0.75, max: 1 },
  enableConsolidationLlmVerification: { kind: 'bool' },
  consolidationTextSimilarityRatio: { kind: 'float', min: 0, max: 1 },
  conflictSimilarityThreshold: { kind: 'float', min: 0, max: 1 },
  conflictCheckBatchSize: { kind: 'int', min: 1 },
  contradictionSimilarityThreshold: { kind: 'float', min: 0, max: 1 },
  contradictionSearchLimit: { kind: 'int', min: 1 },
  contradictionBatchSize: { kind: 'int', min: 1 },
  globalPromotionBatchSize: { kind: 'int', min: 1 },
  globalPromotionRecheckDays: { kind: 'int', min: 1 },
  globalPromotionMinSuccessCount: { kind: 'int', min: 1 },
  globalPromotionMinUsageRatio: { kind: 'float', min: 0, max: 1 },
  globalPromotionMinRetrievalsForUsageRatio: { kind: 'int', min: 1 },
  warningClusterSimilarityThreshold: { kind: 'float', min: 0, max: 1 },
  warningClusterLimit: { kind: 'int', min: 1 },
  warningSynthesisMinFailures: { kind: 'int', min: 1 },
  warningSynthesisBatchSize: { kind: 'int', min: 1 },
  warningSynthesisRecheckDays: { kind: 'int', min: 1 },
  procedureStepCheckCount: { kind: 'int', min: 1 },
  extractionDedupThreshold: { kind: 'float', min: 0, max: 1 },
  reviewSimilarThreshold: { kind: 'float', min: 0, max: 1 },
  reviewDuplicateWarningThreshold: { kind: 'float', min: 0, max: 1 },
  extractionLogRetentionDays: { kind: 'int', min: 1 }
} satisfies Record<keyof Settings, SettingRule>

export function getDefaultRetrievalSettings(): RetrievalSettings {
  return {
    minSemanticSimilarity: 0.70,
    minScore: 0.45,
    minSemanticOnlyScore: 0.65,
    maxRecords: 5,
    maxTokens: 2000,
    mmrLambda: 0.7,
    usageRatioWeight: 0.2,
    enableHaikuRetrieval: false,
    maxKeywordQueries: 4,
    maxKeywordErrors: 2,
    maxKeywordCommands: 2,
    prePromptTimeoutMs: 5000,
    haikuQueryTimeoutMs: 2500,
    maxSemanticQueryChars: 1200
  }
}

export function getDefaultMaintenanceSettings(): MaintenanceSettings {
  return {
    staleDays: 90,
    discoveryMaxAgeDays: 180,
    lowUsageMinRetrievals: 5,
    lowUsageRatioThreshold: 0.1,
    lowUsageHighRetrievalMin: 5,
    staleUnusedDays: 30,
    consolidationSearchLimit: 12,
    consolidationMaxClusterSize: 8,
    consolidationThreshold: SIMILARITY_THRESHOLDS.CONSOLIDATION,
    consolidationRecheckDays: 7,
    crossTypeConsolidationThreshold: 0.93,
    enableConsolidationLlmVerification: true,
    consolidationTextSimilarityRatio: 0.2,
    conflictSimilarityThreshold: 0.85,
    conflictCheckBatchSize: 10,
    contradictionSimilarityThreshold: 0.75,
    contradictionSearchLimit: 8,
    contradictionBatchSize: 15,
    globalPromotionBatchSize: 20,
    globalPromotionRecheckDays: 30,
    globalPromotionMinSuccessCount: 2,
    globalPromotionMinUsageRatio: 0.3,
    globalPromotionMinRetrievalsForUsageRatio: 3,
    warningClusterSimilarityThreshold: 0.8,
    warningClusterLimit: 5,
    warningSynthesisMinFailures: 2,
    warningSynthesisBatchSize: 10,
    warningSynthesisRecheckDays: 30,
    procedureStepCheckCount: 3,
    extractionDedupThreshold: SIMILARITY_THRESHOLDS.EXTRACTION_DEDUP,
    reviewSimilarThreshold: SIMILARITY_THRESHOLDS.REVIEW_SIMILAR,
    reviewDuplicateWarningThreshold: SIMILARITY_THRESHOLDS.REVIEW_DUPLICATE_WARNING,
    extractionLogRetentionDays: 14
  }
}

export function getDefaultSettings(): Settings {
  return {
    ...getDefaultRetrievalSettings(),
    ...getDefaultMaintenanceSettings()
  }
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

export function coerceRetrievalSettings(value: Record<string, unknown>, fallback: RetrievalSettings): RetrievalSettings {
  return {
    minSemanticSimilarity: coerceSettingValue(
      SETTING_RULES.minSemanticSimilarity,
      value.minSemanticSimilarity,
      fallback.minSemanticSimilarity
    ),
    minScore: coerceSettingValue(
      SETTING_RULES.minScore,
      value.minScore,
      fallback.minScore
    ),
    minSemanticOnlyScore: coerceSettingValue(
      SETTING_RULES.minSemanticOnlyScore,
      value.minSemanticOnlyScore,
      fallback.minSemanticOnlyScore
    ),
    maxRecords: coerceSettingValue(
      SETTING_RULES.maxRecords,
      value.maxRecords,
      fallback.maxRecords
    ),
    maxTokens: coerceSettingValue(
      SETTING_RULES.maxTokens,
      value.maxTokens,
      fallback.maxTokens
    ),
    mmrLambda: coerceSettingValue(
      SETTING_RULES.mmrLambda,
      value.mmrLambda,
      fallback.mmrLambda
    ),
    usageRatioWeight: coerceSettingValue(
      SETTING_RULES.usageRatioWeight,
      value.usageRatioWeight,
      fallback.usageRatioWeight
    ),
    enableHaikuRetrieval: coerceBooleanValue(value.enableHaikuRetrieval, fallback.enableHaikuRetrieval),
    maxKeywordQueries: coerceSettingValue(
      SETTING_RULES.maxKeywordQueries,
      value.maxKeywordQueries,
      fallback.maxKeywordQueries
    ),
    maxKeywordErrors: coerceSettingValue(
      SETTING_RULES.maxKeywordErrors,
      value.maxKeywordErrors,
      fallback.maxKeywordErrors
    ),
    maxKeywordCommands: coerceSettingValue(
      SETTING_RULES.maxKeywordCommands,
      value.maxKeywordCommands,
      fallback.maxKeywordCommands
    ),
    prePromptTimeoutMs: coerceSettingValue(
      SETTING_RULES.prePromptTimeoutMs,
      value.prePromptTimeoutMs,
      fallback.prePromptTimeoutMs
    ),
    haikuQueryTimeoutMs: coerceSettingValue(
      SETTING_RULES.haikuQueryTimeoutMs,
      value.haikuQueryTimeoutMs,
      fallback.haikuQueryTimeoutMs
    ),
    maxSemanticQueryChars: coerceSettingValue(
      SETTING_RULES.maxSemanticQueryChars,
      value.maxSemanticQueryChars,
      fallback.maxSemanticQueryChars
    )
  }
}

function coerceMaintenanceSettings(value: Record<string, unknown>, fallback: MaintenanceSettings): MaintenanceSettings {
  return {
    staleDays: coerceSettingValue(SETTING_RULES.staleDays, value.staleDays, fallback.staleDays),
    discoveryMaxAgeDays: coerceSettingValue(
      SETTING_RULES.discoveryMaxAgeDays,
      value.discoveryMaxAgeDays,
      fallback.discoveryMaxAgeDays
    ),
    lowUsageMinRetrievals: coerceSettingValue(
      SETTING_RULES.lowUsageMinRetrievals,
      value.lowUsageMinRetrievals,
      fallback.lowUsageMinRetrievals
    ),
    lowUsageRatioThreshold: coerceSettingValue(
      SETTING_RULES.lowUsageRatioThreshold,
      value.lowUsageRatioThreshold,
      fallback.lowUsageRatioThreshold
    ),
    lowUsageHighRetrievalMin: coerceSettingValue(
      SETTING_RULES.lowUsageHighRetrievalMin,
      value.lowUsageHighRetrievalMin,
      fallback.lowUsageHighRetrievalMin
    ),
    staleUnusedDays: coerceSettingValue(
      SETTING_RULES.staleUnusedDays,
      value.staleUnusedDays,
      fallback.staleUnusedDays
    ),
    consolidationSearchLimit: coerceSettingValue(
      SETTING_RULES.consolidationSearchLimit,
      value.consolidationSearchLimit,
      fallback.consolidationSearchLimit
    ),
    consolidationMaxClusterSize: coerceSettingValue(
      SETTING_RULES.consolidationMaxClusterSize,
      value.consolidationMaxClusterSize,
      fallback.consolidationMaxClusterSize
    ),
    consolidationThreshold: coerceSettingValue(
      SETTING_RULES.consolidationThreshold,
      value.consolidationThreshold,
      fallback.consolidationThreshold
    ),
    consolidationRecheckDays: coerceSettingValue(
      SETTING_RULES.consolidationRecheckDays,
      value.consolidationRecheckDays,
      fallback.consolidationRecheckDays
    ),
    crossTypeConsolidationThreshold: coerceSettingValue(
      SETTING_RULES.crossTypeConsolidationThreshold,
      value.crossTypeConsolidationThreshold,
      fallback.crossTypeConsolidationThreshold
    ),
    enableConsolidationLlmVerification: coerceBooleanValue(
      value.enableConsolidationLlmVerification,
      fallback.enableConsolidationLlmVerification
    ),
    consolidationTextSimilarityRatio: coerceSettingValue(
      SETTING_RULES.consolidationTextSimilarityRatio,
      value.consolidationTextSimilarityRatio,
      fallback.consolidationTextSimilarityRatio
    ),
    conflictSimilarityThreshold: coerceSettingValue(
      SETTING_RULES.conflictSimilarityThreshold,
      value.conflictSimilarityThreshold,
      fallback.conflictSimilarityThreshold
    ),
    conflictCheckBatchSize: coerceSettingValue(
      SETTING_RULES.conflictCheckBatchSize,
      value.conflictCheckBatchSize,
      fallback.conflictCheckBatchSize
    ),
    contradictionSimilarityThreshold: coerceSettingValue(
      SETTING_RULES.contradictionSimilarityThreshold,
      value.contradictionSimilarityThreshold,
      fallback.contradictionSimilarityThreshold
    ),
    contradictionSearchLimit: coerceSettingValue(
      SETTING_RULES.contradictionSearchLimit,
      value.contradictionSearchLimit,
      fallback.contradictionSearchLimit
    ),
    contradictionBatchSize: coerceSettingValue(
      SETTING_RULES.contradictionBatchSize,
      value.contradictionBatchSize,
      fallback.contradictionBatchSize
    ),
    globalPromotionBatchSize: coerceSettingValue(
      SETTING_RULES.globalPromotionBatchSize,
      value.globalPromotionBatchSize,
      fallback.globalPromotionBatchSize
    ),
    globalPromotionRecheckDays: coerceSettingValue(
      SETTING_RULES.globalPromotionRecheckDays,
      value.globalPromotionRecheckDays,
      fallback.globalPromotionRecheckDays
    ),
    globalPromotionMinSuccessCount: coerceSettingValue(
      SETTING_RULES.globalPromotionMinSuccessCount,
      value.globalPromotionMinSuccessCount,
      fallback.globalPromotionMinSuccessCount
    ),
    globalPromotionMinUsageRatio: coerceSettingValue(
      SETTING_RULES.globalPromotionMinUsageRatio,
      value.globalPromotionMinUsageRatio,
      fallback.globalPromotionMinUsageRatio
    ),
    globalPromotionMinRetrievalsForUsageRatio: coerceSettingValue(
      SETTING_RULES.globalPromotionMinRetrievalsForUsageRatio,
      value.globalPromotionMinRetrievalsForUsageRatio,
      fallback.globalPromotionMinRetrievalsForUsageRatio
    ),
    warningClusterSimilarityThreshold: coerceSettingValue(
      SETTING_RULES.warningClusterSimilarityThreshold,
      value.warningClusterSimilarityThreshold,
      fallback.warningClusterSimilarityThreshold
    ),
    warningClusterLimit: coerceSettingValue(
      SETTING_RULES.warningClusterLimit,
      value.warningClusterLimit,
      fallback.warningClusterLimit
    ),
    warningSynthesisMinFailures: coerceSettingValue(
      SETTING_RULES.warningSynthesisMinFailures,
      value.warningSynthesisMinFailures,
      fallback.warningSynthesisMinFailures
    ),
    warningSynthesisBatchSize: coerceSettingValue(
      SETTING_RULES.warningSynthesisBatchSize,
      value.warningSynthesisBatchSize,
      fallback.warningSynthesisBatchSize
    ),
    warningSynthesisRecheckDays: coerceSettingValue(
      SETTING_RULES.warningSynthesisRecheckDays,
      value.warningSynthesisRecheckDays,
      fallback.warningSynthesisRecheckDays
    ),
    procedureStepCheckCount: coerceSettingValue(
      SETTING_RULES.procedureStepCheckCount,
      value.procedureStepCheckCount,
      fallback.procedureStepCheckCount
    ),
    extractionDedupThreshold: coerceSettingValue(
      SETTING_RULES.extractionDedupThreshold,
      value.extractionDedupThreshold,
      fallback.extractionDedupThreshold
    ),
    reviewSimilarThreshold: coerceSettingValue(
      SETTING_RULES.reviewSimilarThreshold,
      value.reviewSimilarThreshold,
      fallback.reviewSimilarThreshold
    ),
    reviewDuplicateWarningThreshold: coerceSettingValue(
      SETTING_RULES.reviewDuplicateWarningThreshold,
      value.reviewDuplicateWarningThreshold,
      fallback.reviewDuplicateWarningThreshold
    ),
    extractionLogRetentionDays: coerceSettingValue(
      SETTING_RULES.extractionLogRetentionDays,
      value.extractionLogRetentionDays,
      fallback.extractionLogRetentionDays
    )
  }
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
