import fs from 'fs'
import path from 'path'
import { homedir } from 'os'
import { type ExtractionReview, type ExtractionReviewIssue } from './extraction-review.js'
import { type InjectedMemoryVerdict, type InjectionReview, type MissedMemory } from './injection-review.js'
import { asBoolean, asInteger, asNumber, asString, isPlainObject } from './parsing.js'
import { readJsonFileSafe, writeJsonFile } from './json.js'
import { sanitizeRunId, sanitizeSessionId } from './shared.js'
import { getCollectionKey } from './retrieval-events.js'
import { loadSessionTracking, saveSessionTracking } from './session-tracking.js'
import { isDefaultCollection } from './storage-paths.js'
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

const REVIEWS_ROOT = path.join(homedir(), '.claude-memory', 'reviews')

function getReviewsDir(collection?: string): string {
  return path.join(REVIEWS_ROOT, getCollectionKey(collection))
}

function saveReviewFile<T>(filePath: string, review: T): void {
  writeJsonFile(filePath, review, {
    ensureDir: true,
    pretty: 2,
    onError: error => console.error('[claude-memory] Failed to write review:', error)
  })
}

function loadReviewFile<T>(filePath: string, coerce: (data: unknown) => T | null): T | null {
  return readJsonFileSafe(filePath, {
    errorMessage: '[claude-memory] Failed to read review:',
    coerce
  })
}

export function getReviewPath(runId: string): string {
  const safeId = sanitizeRunId(runId)
  return path.join(REVIEWS_ROOT, `${safeId}.json`)
}

function getScopedReviewPath(runId: string, collection?: string): string {
  const safeId = sanitizeRunId(runId)
  return path.join(getReviewsDir(collection), `${safeId}.json`)
}

function loadReviewFileWithFallback<T>(
  primaryPath: string,
  legacyPath: string,
  coerce: (data: unknown) => T | null,
  collection?: string
): T | null {
  const primary = loadReviewFile(primaryPath, coerce)
  if (primary) return primary
  if (!isDefaultCollection(collection)) return null
  return loadReviewFile(legacyPath, coerce)
}

function deleteReviewFileWithFallback(primaryPath: string, legacyPath: string, collection?: string): void {
  const paths = [primaryPath]
  if (isDefaultCollection(collection)) {
    paths.push(legacyPath)
  }

  for (const filePath of paths) {
    if (!fs.existsSync(filePath)) continue
    try {
      fs.unlinkSync(filePath)
    } catch (error) {
      console.error('[claude-memory] Failed to delete extraction review:', error)
    }
  }
}

export function saveReview(review: ExtractionReview, collection?: string): void {
  const filePath = getScopedReviewPath(review.runId, collection)
  saveReviewFile(filePath, review)
}

export function getReview(runId: string, collection?: string): ExtractionReview | null {
  return loadReviewFileWithFallback(
    getScopedReviewPath(runId, collection),
    getReviewPath(runId),
    data => coerceExtractionReview(data, runId),
    collection
  )
}

export function deleteReview(runId: string, collection?: string): void {
  deleteReviewFileWithFallback(
    getScopedReviewPath(runId, collection),
    getReviewPath(runId),
    collection
  )
}

function getLegacyInjectionReviewPath(sessionId: string): string {
  const safeId = sanitizeSessionId(sessionId)
  return path.join(REVIEWS_ROOT, `injection-${safeId}.json`)
}

export function getInjectionReviewPath(sessionId: string, collection?: string): string {
  const safeId = sanitizeSessionId(sessionId)
  return path.join(getReviewsDir(collection), `injection-${safeId}.json`)
}

export function saveInjectionReview(review: InjectionReview, collection?: string): void {
  const filePath = getInjectionReviewPath(review.sessionId, collection)
  saveReviewFile(filePath, review)
  try {
    const session = loadSessionTracking(review.sessionId, collection)
    if (!session || session.hasReview) return
    saveSessionTracking({ ...session, hasReview: true }, collection)
  } catch (error) {
    console.error('[claude-memory] Failed to update session review flag:', error)
  }
}

export function getInjectionReview(sessionId: string, collection?: string): InjectionReview | null {
  return loadReviewFileWithFallback(
    getInjectionReviewPath(sessionId, collection),
    getLegacyInjectionReviewPath(sessionId),
    data => coerceInjectionReview(data, sessionId),
    collection
  )
}

export async function hasInjectionReview(sessionId: string, collection?: string): Promise<boolean> {
  try {
    await fs.promises.access(getInjectionReviewPath(sessionId, collection))
    return true
  } catch {
    if (!isDefaultCollection(collection)) return false
    try {
      await fs.promises.access(getLegacyInjectionReviewPath(sessionId))
      return true
    } catch {
      return false
    }
  }
}

function getLegacyMaintenanceReviewPath(resultId: string, operation: string): string {
  const safeOperation = sanitizeRunId(operation)
  const safeId = sanitizeRunId(resultId)
  return path.join(REVIEWS_ROOT, `maintenance-${safeOperation}-${safeId}.json`)
}

export function getMaintenanceReviewPath(resultId: string, operation: string, collection?: string): string {
  const safeOperation = sanitizeRunId(operation)
  const safeId = sanitizeRunId(resultId)
  return path.join(getReviewsDir(collection), `maintenance-${safeOperation}-${safeId}.json`)
}

export function saveMaintenanceReview(review: MaintenanceReview, collection?: string): void {
  const filePath = getMaintenanceReviewPath(review.resultId, review.operation, collection)
  saveReviewFile(filePath, review)
}

export function getMaintenanceReview(resultId: string, operation: string, collection?: string): MaintenanceReview | null {
  return loadReviewFileWithFallback(
    getMaintenanceReviewPath(resultId, operation, collection),
    getLegacyMaintenanceReviewPath(resultId, operation),
    data => coerceMaintenanceReview(data, resultId, operation),
    collection
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
