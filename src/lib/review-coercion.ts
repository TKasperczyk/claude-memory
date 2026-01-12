import type { ExtractionReview, ExtractionReviewIssue } from './extraction-review.js'
import type {
  MaintenanceActionReviewItem,
  MaintenanceAssessment,
  MaintenanceActionVerdict,
  MaintenanceSettingsRecommendation,
  SettingsRecommendation
} from '../../shared/types.js'
import { asNumber, asString, isPlainObject } from './parsing.js'

export function coerceReviewIssue(value: unknown): ExtractionReviewIssue | null {
  if (!isPlainObject(value)) return null
  const record = value

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
    if (
      normalized === 'inaccurate'
      || normalized === 'partial'
      || normalized === 'hallucinated'
      || normalized === 'missed'
      || normalized === 'duplicate'
    ) {
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

export function parseMaintenanceAssessment(value: unknown): MaintenanceAssessment | null {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'good' || normalized === 'concerning' || normalized === 'poor') return normalized
  }
  return null
}

export function parseMaintenanceActionVerdict(value: unknown): MaintenanceActionVerdict | null {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'correct' || normalized === 'questionable' || normalized === 'incorrect') return normalized
  }
  return null
}

export function parseSettingsRecommendation(value: unknown): SettingsRecommendation | null {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'too_aggressive' || normalized === 'too_lenient' || normalized === 'appropriate') {
      return normalized
    }
  }
  return null
}

export function coerceMaintenanceActionReviewItem(value: unknown): MaintenanceActionReviewItem | null {
  if (!isPlainObject(value)) return null
  const record = value

  const action = asString(record.action)?.trim().toLowerCase()
  if (
    action !== 'deprecate'
    && action !== 'update'
    && action !== 'merge'
    && action !== 'promote'
    && action !== 'suggestion'
  ) {
    return null
  }
  const snippet = asString(record.snippet)?.trim()
  const verdict = parseMaintenanceActionVerdict(record.verdict)
  const reason = asString(record.reason)?.trim()

  if (!snippet || !verdict || !reason) return null

  const item: MaintenanceActionReviewItem = {
    action,
    snippet,
    verdict,
    reason
  }

  const recordId = asString(record.recordId)?.trim()
  if (recordId) item.recordId = recordId

  return item
}

export function coerceSettingsRecommendation(value: unknown): MaintenanceSettingsRecommendation | null {
  if (!isPlainObject(value)) return null
  const record = value

  const setting = asString(record.setting)?.trim()
  const recommendation = parseSettingsRecommendation(record.recommendation)
  const reason = asString(record.reason)?.trim()

  const currentValueNumber = asNumber(record.currentValue)
  const currentValueString = asString(record.currentValue)?.trim()
  const currentValue = currentValueNumber ?? (currentValueString ? currentValueString : null)

  const suggestedValueNumber = asNumber(record.suggestedValue)
  const suggestedValueString = asString(record.suggestedValue)?.trim()
  const suggestedValue = suggestedValueNumber ?? (suggestedValueString ? suggestedValueString : null)

  if (!setting || !recommendation || !reason || currentValue === null) return null

  const item: MaintenanceSettingsRecommendation = {
    setting,
    currentValue,
    recommendation,
    reason
  }

  if (suggestedValue !== null) item.suggestedValue = suggestedValue

  return item
}
