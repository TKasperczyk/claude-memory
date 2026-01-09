import type { ExclusionReason, NearMissRecord } from './types.js'

export function buildExclusionReason(
  reason: ExclusionReason['reason'],
  threshold: number,
  actual: number,
  extra: Partial<ExclusionReason> = {}
): ExclusionReason {
  return {
    reason,
    threshold,
    actual,
    gap: threshold - actual,
    ...extra
  }
}

export function mergeNearMisses(
  target: Map<string, NearMissRecord>,
  incoming: NearMissRecord[]
): void {
  for (const entry of incoming) {
    const id = entry.record.record.id
    const existing = target.get(id)
    if (existing) {
      existing.exclusionReasons.push(...entry.exclusionReasons)
      continue
    }
    target.set(id, { record: entry.record, exclusionReasons: [...entry.exclusionReasons] })
  }
}
