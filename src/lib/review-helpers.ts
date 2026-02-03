import type { MemoryRecord } from './types.js'
import { clampScore } from './review-coercion.js'

export type ReviewScoreParseOptions = {
  allowEmbedded?: boolean
}

export function parseReviewScore(value: unknown, options: ReviewScoreParseOptions = {}): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return clampScore(value)
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null

    const parsed = Number(trimmed)
    if (Number.isFinite(parsed)) return clampScore(parsed)

    if (options.allowEmbedded) {
      const match = trimmed.match(/-?\d+(?:\.\d+)?/)
      if (match) {
        const extracted = Number(match[0])
        if (Number.isFinite(extracted)) return clampScore(extracted)
      }
    }
  }
  return null
}

export function formatRecordForReview(
  record: MemoryRecord,
  base: Record<string, unknown>
): Record<string, unknown> {
  switch (record.type) {
    case 'command':
      return {
        ...base,
        command: record.command,
        exitCode: record.exitCode,
        outcome: record.outcome,
        truncatedOutput: record.truncatedOutput,
        resolution: record.resolution,
        context: record.context
      }
    case 'error':
      return {
        ...base,
        errorText: record.errorText,
        errorType: record.errorType,
        cause: record.cause,
        resolution: record.resolution,
        context: record.context
      }
    case 'discovery':
      return {
        ...base,
        what: record.what,
        where: record.where,
        evidence: record.evidence,
        confidence: record.confidence
      }
    case 'procedure':
      return {
        ...base,
        name: record.name,
        steps: record.steps,
        prerequisites: record.prerequisites,
        verification: record.verification,
        context: record.context
      }
    case 'warning':
      return {
        ...base,
        avoid: record.avoid,
        useInstead: record.useInstead,
        reason: record.reason,
        severity: record.severity,
        sourceRecordIds: record.sourceRecordIds
      }
  }
}
