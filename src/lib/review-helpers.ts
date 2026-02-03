import type { MemoryRecord } from './types.js'
import { getRecordReviewFields } from './record-fields.js'
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
  return { ...base, ...getRecordReviewFields(record) }
}
