import fs from 'fs'
import path from 'path'
import { homedir } from 'os'
import { type ExtractionReview, type ExtractionReviewIssue } from './extraction-review.js'
import { type InjectedMemoryVerdict, type InjectionReview, type MissedMemory } from './injection-review.js'
import { asInteger, asNumber, asString, isPlainObject } from './parsing.js'
import { sanitizeRunId, sanitizeSessionId } from './shared.js'
import {
  clampScore,
  coerceReviewIssue,
  parseInjectionVerdict,
  parseOverallAccuracy,
  parseOverallRelevance
} from './review-coercion.js'

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

export function getInjectionReviewPath(sessionId: string): string {
  const safeId = sanitizeSessionId(sessionId)
  return path.join(REVIEWS_DIR, `injection-${safeId}.json`)
}

export function saveInjectionReview(review: InjectionReview): void {
  try {
    fs.mkdirSync(REVIEWS_DIR, { recursive: true })
    const filePath = getInjectionReviewPath(review.sessionId)
    fs.writeFileSync(filePath, JSON.stringify(review, null, 2))
  } catch (error) {
    console.error('[claude-memory] Failed to write injection review:', error)
  }
}

export function getInjectionReview(sessionId: string): InjectionReview | null {
  const filePath = getInjectionReviewPath(sessionId)
  if (!fs.existsSync(filePath)) return null

  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    return coerceInjectionReview(parsed, sessionId)
  } catch (error) {
    console.error('[claude-memory] Failed to read injection review:', error)
    return null
  }
}

function coerceReview(value: unknown, runId: string): ExtractionReview | null {
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

function coerceInjectedVerdict(value: unknown): InjectedMemoryVerdict | null {
  if (!isPlainObject(value)) return null
  const record = value

  const id = asString(record.id)?.trim()
  const snippet = asString(record.snippet)?.trim()
  const verdict = parseInjectionVerdict(record.verdict)
  const reason = asString(record.reason)?.trim()

  if (!id || !snippet || !verdict || !reason) return null

  return {
    id,
    snippet,
    verdict,
    reason
  }
}

function coerceMissedMemory(value: unknown): MissedMemory | null {
  if (!isPlainObject(value)) return null
  const record = value

  const id = asString(record.id)?.trim()
  const snippet = asString(record.snippet)?.trim()
  const reason = asString(record.reason)?.trim()

  if (!id || !snippet || !reason) return null

  return {
    id,
    snippet,
    reason
  }
}
