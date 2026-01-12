import fs from 'fs'
import path from 'path'
import { homedir } from 'os'
import { isPlainObject } from './parsing.js'
import { SIMILARITY_THRESHOLDS } from './types.js'
import type { MaintenanceSettings, RetrievalSettings, Settings } from '../../shared/types.js'

export type { MaintenanceSettings, RetrievalSettings, Settings } from '../../shared/types.js'

const SETTINGS_DIR = path.join(homedir(), '.claude-memory')
const SETTINGS_PATH = path.join(SETTINGS_DIR, 'settings.json')

export function getDefaultRetrievalSettings(): RetrievalSettings {
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

export function getDefaultMaintenanceSettings(): MaintenanceSettings {
  return {
    staleDays: 90,
    discoveryMaxAgeDays: 180,
    lowUsageMinRetrievals: 5,
    lowUsageRatioThreshold: 0.1,
    lowUsageHighRetrievalMin: 10,
    consolidationSearchLimit: 12,
    consolidationMaxClusterSize: 8,
    consolidationThreshold: SIMILARITY_THRESHOLDS.CONSOLIDATION,
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
    reviewDuplicateWarningThreshold: SIMILARITY_THRESHOLDS.REVIEW_DUPLICATE_WARNING
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

export function saveSettings(settings: Partial<Settings>): void {
  const current = loadSettings()
  const merged = coerceSettings({ ...current, ...settings }, current)
  fs.mkdirSync(SETTINGS_DIR, { recursive: true })
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2))
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

export function coerceRetrievalSettings(value: Record<string, unknown>, fallback: RetrievalSettings): RetrievalSettings {
  return {
    minSemanticSimilarity: coerceFloat(value.minSemanticSimilarity, fallback.minSemanticSimilarity, 0, 1),
    minScore: coerceFloat(value.minScore, fallback.minScore, 0, 1),
    minSemanticOnlyScore: coerceFloat(value.minSemanticOnlyScore, fallback.minSemanticOnlyScore, 0, 1),
    maxRecords: coerceInt(value.maxRecords, fallback.maxRecords, 1),
    maxTokens: coerceInt(value.maxTokens, fallback.maxTokens, 1),
    mmrLambda: coerceFloat(value.mmrLambda, fallback.mmrLambda, 0, 1),
    usageRatioWeight: coerceFloat(value.usageRatioWeight, fallback.usageRatioWeight, 0, 1)
  }
}

function coerceMaintenanceSettings(value: Record<string, unknown>, fallback: MaintenanceSettings): MaintenanceSettings {
  return {
    staleDays: coerceInt(value.staleDays, fallback.staleDays, 1),
    discoveryMaxAgeDays: coerceInt(value.discoveryMaxAgeDays, fallback.discoveryMaxAgeDays, 1),
    lowUsageMinRetrievals: coerceInt(value.lowUsageMinRetrievals, fallback.lowUsageMinRetrievals, 1),
    lowUsageRatioThreshold: coerceFloat(value.lowUsageRatioThreshold, fallback.lowUsageRatioThreshold, 0, 1),
    lowUsageHighRetrievalMin: coerceInt(value.lowUsageHighRetrievalMin, fallback.lowUsageHighRetrievalMin, 1),
    consolidationSearchLimit: coerceInt(value.consolidationSearchLimit, fallback.consolidationSearchLimit, 1),
    consolidationMaxClusterSize: coerceInt(value.consolidationMaxClusterSize, fallback.consolidationMaxClusterSize, 1),
    consolidationThreshold: coerceFloat(value.consolidationThreshold, fallback.consolidationThreshold, 0, 1),
    consolidationTextSimilarityRatio: coerceFloat(
      value.consolidationTextSimilarityRatio,
      fallback.consolidationTextSimilarityRatio,
      0,
      1
    ),
    conflictSimilarityThreshold: coerceFloat(value.conflictSimilarityThreshold, fallback.conflictSimilarityThreshold, 0, 1),
    conflictCheckBatchSize: coerceInt(value.conflictCheckBatchSize, fallback.conflictCheckBatchSize, 1),
    contradictionSimilarityThreshold: coerceFloat(value.contradictionSimilarityThreshold, fallback.contradictionSimilarityThreshold, 0, 1),
    contradictionSearchLimit: coerceInt(value.contradictionSearchLimit, fallback.contradictionSearchLimit, 1),
    contradictionBatchSize: coerceInt(value.contradictionBatchSize, fallback.contradictionBatchSize, 1),
    globalPromotionBatchSize: coerceInt(value.globalPromotionBatchSize, fallback.globalPromotionBatchSize, 1),
    globalPromotionRecheckDays: coerceInt(value.globalPromotionRecheckDays, fallback.globalPromotionRecheckDays, 1),
    globalPromotionMinSuccessCount: coerceInt(value.globalPromotionMinSuccessCount, fallback.globalPromotionMinSuccessCount, 1),
    globalPromotionMinUsageRatio: coerceFloat(value.globalPromotionMinUsageRatio, fallback.globalPromotionMinUsageRatio, 0, 1),
    globalPromotionMinRetrievalsForUsageRatio: coerceInt(
      value.globalPromotionMinRetrievalsForUsageRatio,
      fallback.globalPromotionMinRetrievalsForUsageRatio,
      1
    ),
    warningClusterSimilarityThreshold: coerceFloat(
      value.warningClusterSimilarityThreshold,
      fallback.warningClusterSimilarityThreshold,
      0,
      1
    ),
    warningClusterLimit: coerceInt(value.warningClusterLimit, fallback.warningClusterLimit, 1),
    warningSynthesisMinFailures: coerceInt(value.warningSynthesisMinFailures, fallback.warningSynthesisMinFailures, 1),
    warningSynthesisBatchSize: coerceInt(value.warningSynthesisBatchSize, fallback.warningSynthesisBatchSize, 1),
    warningSynthesisRecheckDays: coerceInt(value.warningSynthesisRecheckDays, fallback.warningSynthesisRecheckDays, 1),
    procedureStepCheckCount: coerceInt(value.procedureStepCheckCount, fallback.procedureStepCheckCount, 1),
    extractionDedupThreshold: coerceFloat(value.extractionDedupThreshold, fallback.extractionDedupThreshold, 0, 1),
    reviewSimilarThreshold: coerceFloat(value.reviewSimilarThreshold, fallback.reviewSimilarThreshold, 0, 1),
    reviewDuplicateWarningThreshold: coerceFloat(
      value.reviewDuplicateWarningThreshold,
      fallback.reviewDuplicateWarningThreshold,
      0,
      1
    )
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
