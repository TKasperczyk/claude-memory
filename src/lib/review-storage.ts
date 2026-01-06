import fs from 'fs'
import path from 'path'
import { homedir } from 'os'
import { type ExtractionReview, type ExtractionReviewIssue } from './extraction-review.js'
import { asString, clampScore, coerceReviewIssue, isPlainObject, parseOverallAccuracy } from './review-coercion.js'

const REVIEWS_DIR = path.join(homedir(), '.claude-memory', 'reviews')

export function getReviewPath(runId: string): string {
  const safeId = sanitizeRunId(runId)
  return path.join(REVIEWS_DIR, `${safeId}.json`)
}

export function saveReview(review: ExtractionReview): void {
  try {
    fs.mkdirSync(REVIEWS_DIR, { recursive: true })
    const filePath = getReviewPath(review.runId)
    fs.writeFileSync(filePath, JSON.stringify(review, null, 2))
  } catch (error) {
    console.error('[claude-memory] Failed to write extraction review:', error)
  }
}

export function getReview(runId: string): ExtractionReview | null {
  const filePath = getReviewPath(runId)
  if (!fs.existsSync(filePath)) return null

  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    return coerceReview(parsed, runId)
  } catch (error) {
    console.error('[claude-memory] Failed to read extraction review:', error)
    return null
  }
}

function sanitizeRunId(runId: string): string {
  return runId.replace(/[\\/]/g, '_')
}

function coerceReview(value: unknown, runId: string): ExtractionReview | null {
  if (!isPlainObject(value)) return null
  const record = value as Record<string, unknown>

  const summary = asString(record.summary)?.trim() ?? ''
  const overallAccuracy = parseOverallAccuracy(record.overallAccuracy)
  const accuracyScore = parseNumber(record.accuracyScore) ?? 0
  const reviewedAt = parseNumber(record.reviewedAt) ?? 0
  const model = asString(record.model) ?? 'unknown'
  const durationMs = parseNumber(record.durationMs) ?? 0

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

function parseNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return Math.trunc(parsed)
  }
  return null
}
