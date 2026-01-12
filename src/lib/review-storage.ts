import fs from 'fs'
import path from 'path'
import { homedir } from 'os'
import { type ExtractionReview, type ExtractionReviewIssue } from './extraction-review.js'
import { type InjectedMemoryVerdict, type InjectionReview, type MissedMemory } from './injection-review.js'
import { asBoolean, asInteger, asNumber, asString, isPlainObject } from './parsing.js'
import { sanitizeRunId, sanitizeSessionId } from './shared.js'
import {
  clampScore,
  coerceInjectedVerdict,
  coerceMissedMemory,
  coerceMaintenanceActionReviewItem,
  coerceReviewIssue,
  coerceSettingsRecommendation,
  parseMaintenanceAssessment,
  parseOverallAccuracy,
  parseOverallRelevance
} from './review-coercion.js'
import { type MaintenanceReview } from '../../shared/types.js'

const REVIEWS_DIR = path.join(homedir(), '.claude-memory', 'reviews')

function saveReviewFile<T>(filePath: string, review: T): void {
  try {
    fs.mkdirSync(REVIEWS_DIR, { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify(review, null, 2))
  } catch (error) {
    console.error('[claude-memory] Failed to write review:', error)
  }
}

function loadReviewFile<T>(filePath: string, coerce: (data: unknown) => T | null): T | null {
  if (!fs.existsSync(filePath)) return null
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown
    return coerce(data)
  } catch (error) {
    console.error('[claude-memory] Failed to read review:', error)
    return null
  }
}

export function getReviewPath(runId: string): string {
  const safeId = sanitizeRunId(runId)
  return path.join(REVIEWS_DIR, `${safeId}.json`)
}

export function saveReview(review: ExtractionReview): void {
  const filePath = getReviewPath(review.runId)
  saveReviewFile(filePath, review)
}

export function getReview(runId: string): ExtractionReview | null {
  const filePath = getReviewPath(runId)
  return loadReviewFile(filePath, (data) => coerceExtractionReview(data, runId))
}

export function getInjectionReviewPath(sessionId: string): string {
  const safeId = sanitizeSessionId(sessionId)
  return path.join(REVIEWS_DIR, `injection-${safeId}.json`)
}

export function saveInjectionReview(review: InjectionReview): void {
  const filePath = getInjectionReviewPath(review.sessionId)
  saveReviewFile(filePath, review)
}

export function getInjectionReview(sessionId: string): InjectionReview | null {
  const filePath = getInjectionReviewPath(sessionId)
  return loadReviewFile(filePath, (data) => coerceInjectionReview(data, sessionId))
}

export function getMaintenanceReviewPath(resultId: string, operation: string): string {
  const safeOperation = sanitizeRunId(operation)
  const safeId = sanitizeRunId(resultId)
  return path.join(REVIEWS_DIR, `maintenance-${safeOperation}-${safeId}.json`)
}

export function saveMaintenanceReview(review: MaintenanceReview): void {
  const filePath = getMaintenanceReviewPath(review.resultId, review.operation)
  saveReviewFile(filePath, review)
}

export function getMaintenanceReview(resultId: string, operation: string): MaintenanceReview | null {
  const filePath = getMaintenanceReviewPath(resultId, operation)
  return loadReviewFile(filePath, (data) => coerceMaintenanceReview(data, resultId, operation))
}

function coerceExtractionReview(value: unknown, runId: string): ExtractionReview | null {
  if (!isPlainObject(value)) return null
  const record = value

  const summary = asString(record.summary)?.trim() ?? ''
  const overallAccuracy = parseOverallAccuracy(record.overallAccuracy)
  const accuracyScore = asNumber(record.accuracyScore) ?? 0
  const reviewedAt = asInteger(record.reviewedAt) ?? 0
  const model = asString(record.model) ?? 'unknown'
  const durationMs = asInteger(record.durationMs) ?? 0

  const issues = Array.isArray(record.issues)
    ? record.issues.map(coerceReviewIssue).filter((issue): issue is ExtractionReviewIssue => Boolean(issue))
    : []

  if (!overallAccuracy) return null

  return {
    runId: asString(record.runId) ?? runId,
    reviewedAt,
    overallAccuracy,
    accuracyScore: clampScore(accuracyScore),
    issues,
    summary,
    model,
    durationMs
  }
}

function coerceInjectionReview(value: unknown, sessionId: string): InjectionReview | null {
  if (!isPlainObject(value)) return null
  const record = value

  const summary = asString(record.summary)?.trim() ?? ''
  const overallRelevance = parseOverallRelevance(record.overallRelevance)
  const relevanceScore = asNumber(record.relevanceScore) ?? 0
  const reviewedAt = asInteger(record.reviewedAt) ?? 0
  const model = asString(record.model) ?? 'unknown'
  const durationMs = asInteger(record.durationMs) ?? 0
  const prompt = asString(record.prompt) ?? ''

  const injectedVerdicts = Array.isArray(record.injectedVerdicts)
    ? record.injectedVerdicts.map(coerceInjectedVerdict).filter((item): item is InjectedMemoryVerdict => Boolean(item))
    : []

  const missedMemories = Array.isArray(record.missedMemories)
    ? record.missedMemories.map(coerceMissedMemory).filter((item): item is MissedMemory => Boolean(item))
    : []

  if (!overallRelevance) return null

  return {
    sessionId: asString(record.sessionId) ?? sessionId,
    prompt,
    reviewedAt,
    overallRelevance,
    relevanceScore: clampScore(relevanceScore),
    injectedVerdicts,
    missedMemories,
    summary,
    model,
    durationMs
  }
}

function coerceMaintenanceReview(value: unknown, resultId: string, operation: string): MaintenanceReview | null {
  if (!isPlainObject(value)) return null
  const record = value

  const summary = asString(record.summary)?.trim() ?? ''
  const overallAssessment = parseMaintenanceAssessment(record.overallAssessment)
  const assessmentScore = asNumber(record.assessmentScore) ?? 0
  const reviewedAt = asInteger(record.reviewedAt) ?? 0
  const model = asString(record.model) ?? 'unknown'
  const durationMs = asInteger(record.durationMs) ?? 0
  const dryRun = asBoolean(record.dryRun) ?? false

  const actionVerdicts = Array.isArray(record.actionVerdicts)
    ? record.actionVerdicts
      .map(coerceMaintenanceActionReviewItem)
      .filter((item): item is MaintenanceReview['actionVerdicts'][number] => Boolean(item))
    : []

  const settingsRecommendations = Array.isArray(record.settingsRecommendations)
    ? record.settingsRecommendations
      .map(coerceSettingsRecommendation)
      .filter((item): item is MaintenanceReview['settingsRecommendations'][number] => Boolean(item))
    : []

  if (!overallAssessment) return null

  return {
    resultId: asString(record.resultId) ?? resultId,
    operation: asString(record.operation) ?? operation,
    dryRun,
    reviewedAt,
    overallAssessment,
    assessmentScore: clampScore(assessmentScore),
    actionVerdicts,
    settingsRecommendations,
    summary,
    model,
    durationMs
  }
}
