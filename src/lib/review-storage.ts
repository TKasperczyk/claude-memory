import { type ExtractionReview, type ExtractionReviewIssue } from './extraction-review.js'
import { type InjectedMemoryVerdict, type InjectionReview, type MissedMemory } from './injection-review.js'
import { asBoolean, asInteger, asNumber, asString, isPlainObject } from './parsing.js'
import { JsonStore } from './file-store.js'
import { sanitizeRunId, sanitizeSessionId } from './shared.js'
import { loadSessionTracking, saveSessionTracking } from './session-tracking.js'
import {
  clampScore,
  coerceInjectedVerdict,
  coerceMissedMemory,
  coerceMaintenanceActionReviewItem,
  coerceReviewIssue,
  coerceSettingsRecommendation,
  parseReviewRating
} from './review-coercion.js'
import { type MaintenanceReview } from '../../shared/types.js'

const reviewStore = new JsonStore('reviews')

function getReviewKey(runId: string): string {
  return sanitizeRunId(runId)
}

function getInjectionReviewKey(sessionId: string): string {
  return `injection-${sanitizeSessionId(sessionId)}`
}

function getMaintenanceReviewKey(resultId: string, operation: string): string {
  const safeOperation = sanitizeRunId(operation)
  const safeId = sanitizeRunId(resultId)
  return `maintenance-${safeOperation}-${safeId}`
}

function saveReviewFile<T>(key: string, review: T, collection?: string): void {
  reviewStore.write(key, review, {
    collection,
    ensureDir: true,
    pretty: 2,
    onError: error => console.error('[claude-memory] Failed to write review:', error)
  })
}

function loadReviewFile<T>(
  key: string,
  coerce: (data: unknown) => T | null,
  collection?: string,
  includeLegacyForDefault: boolean = false
): T | null {
  return reviewStore.read(key, {
    collection,
    includeLegacyForDefault,
    errorMessage: '[claude-memory] Failed to read review:',
    coerce,
    fallback: null
  })
}

export function getReviewPath(runId: string): string {
  return reviewStore.buildPath(getReviewKey(runId), { legacy: true, sanitize: false })
}

export function saveReview(review: ExtractionReview, collection?: string): void {
  saveReviewFile(getReviewKey(review.runId), review, collection)
}

export function getReview(runId: string, collection?: string): ExtractionReview | null {
  return loadReviewFile(
    getReviewKey(runId),
    data => coerceExtractionReview(data, runId),
    collection,
    true
  )
}

export function deleteReview(runId: string, collection?: string): void {
  reviewStore.delete(getReviewKey(runId), {
    collection,
    includeLegacyForDefault: true,
    continueOnError: true,
    onError: error => console.error('[claude-memory] Failed to delete extraction review:', error)
  })
}

export function getInjectionReviewPath(sessionId: string, collection?: string): string {
  return reviewStore.buildPath(getInjectionReviewKey(sessionId), { collection, sanitize: false })
}

export function saveInjectionReview(review: InjectionReview, collection?: string): void {
  saveReviewFile(getInjectionReviewKey(review.sessionId), review, collection)
  try {
    const session = loadSessionTracking(review.sessionId, collection)
    if (!session || session.hasReview) return
    saveSessionTracking({ ...session, hasReview: true }, collection)
  } catch (error) {
    console.error('[claude-memory] Failed to update session review flag:', error)
  }
}

export function getInjectionReview(sessionId: string, collection?: string): InjectionReview | null {
  return loadReviewFile(
    getInjectionReviewKey(sessionId),
    data => coerceInjectionReview(data, sessionId),
    collection,
    true
  )
}

export async function hasInjectionReview(sessionId: string, collection?: string): Promise<boolean> {
  return reviewStore.exists(getInjectionReviewKey(sessionId), {
    collection,
    includeLegacyForDefault: true
  })
}

export function getMaintenanceReviewPath(resultId: string, operation: string, collection?: string): string {
  return reviewStore.buildPath(getMaintenanceReviewKey(resultId, operation), { collection, sanitize: false })
}

export function saveMaintenanceReview(review: MaintenanceReview, collection?: string): void {
  saveReviewFile(getMaintenanceReviewKey(review.resultId, review.operation), review, collection)
}

export function getMaintenanceReview(resultId: string, operation: string, collection?: string): MaintenanceReview | null {
  return loadReviewFile(
    getMaintenanceReviewKey(resultId, operation),
    data => coerceMaintenanceReview(data, resultId, operation),
    collection,
    true
  )
}

function coerceExtractionReview(value: unknown, runId: string): ExtractionReview | null {
  if (!isPlainObject(value)) return null
  const record = value

  const summary = asString(record.summary)?.trim() ?? ''
  const overallRating = parseReviewRating(record.overallRating ?? record.overallAccuracy)
  const accuracyScore = asNumber(record.accuracyScore) ?? 0
  const reviewedAt = asInteger(record.reviewedAt) ?? 0
  const model = asString(record.model) ?? 'unknown'
  const durationMs = asInteger(record.durationMs) ?? 0

  const issues = Array.isArray(record.issues)
    ? record.issues.map(coerceReviewIssue).filter((issue): issue is ExtractionReviewIssue => Boolean(issue))
    : []

  if (!overallRating) return null

  return {
    runId: asString(record.runId) ?? runId,
    reviewedAt,
    overallRating,
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
  const overallRating = parseReviewRating(record.overallRating ?? record.overallRelevance)
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

  if (!overallRating) return null

  return {
    sessionId: asString(record.sessionId) ?? sessionId,
    prompt,
    reviewedAt,
    overallRating,
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
  const overallRating = parseReviewRating(record.overallRating ?? record.overallAssessment)
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

  if (!overallRating) return null

  return {
    resultId: asString(record.resultId) ?? resultId,
    operation: asString(record.operation) ?? operation,
    dryRun,
    reviewedAt,
    overallRating,
    assessmentScore: clampScore(assessmentScore),
    actionVerdicts,
    settingsRecommendations,
    summary,
    model,
    durationMs
  }
}
