import type { ExtractionReview, ExtractionReviewIssue } from './extraction-review.js'

export function coerceReviewIssue(value: unknown): ExtractionReviewIssue | null {
  if (!isPlainObject(value)) return null
  const record = value as Record<string, unknown>

  const type = parseIssueType(record.type)
  const severity = parseSeverity(record.severity)
  const description = asString(record.description)?.trim()
  const evidence = asString(record.evidence)?.trim()

  if (!type || !severity || !description || !evidence) return null

  const issue: ExtractionReviewIssue = {
    type,
    severity,
    description,
    evidence
  }

  const recordId = asString(record.recordId)?.trim()
  if (recordId) issue.recordId = recordId

  const suggestedFix = asString(record.suggestedFix)?.trim()
  if (suggestedFix) issue.suggestedFix = suggestedFix

  return issue
}

export function parseOverallAccuracy(value: unknown): ExtractionReview['overallAccuracy'] | null {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'good' || normalized === 'acceptable' || normalized === 'poor') return normalized
  }
  return null
}

export function parseIssueType(value: unknown): ExtractionReviewIssue['type'] | null {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'inaccurate' || normalized === 'partial' || normalized === 'hallucinated' || normalized === 'missed') {
      return normalized
    }
  }
  return null
}

export function parseSeverity(value: unknown): ExtractionReviewIssue['severity'] | null {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'critical' || normalized === 'major' || normalized === 'minor') {
      return normalized
    }
  }
  return null
}

export function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)))
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export type InjectionOverallRelevance = 'excellent' | 'good' | 'mixed' | 'poor'
export type InjectionVerdict = 'relevant' | 'partially_relevant' | 'irrelevant' | 'unknown'

export function parseOverallRelevance(value: unknown): InjectionOverallRelevance | null {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'excellent' || normalized === 'good' || normalized === 'mixed' || normalized === 'poor') {
      return normalized
    }
  }
  return null
}

export function parseInjectionVerdict(value: unknown): InjectionVerdict | null {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (
      normalized === 'relevant'
      || normalized === 'partially_relevant'
      || normalized === 'irrelevant'
      || normalized === 'unknown'
    ) {
      return normalized
    }
  }
  return null
}
