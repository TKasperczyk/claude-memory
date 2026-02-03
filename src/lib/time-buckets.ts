import type { RetrievalActivityPeriod } from '../../shared/types.js'

export type TimeBucketPeriod = RetrievalActivityPeriod

export type TimeBucket = {
  start: number
  end: number
  key: string
}

export const DAY_MS = 24 * 60 * 60 * 1000

// Use UTC boundaries to keep bucket math consistent across environments.
export function toDateKeyUtc(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10)
}

export function parseDateKeyUtc(key: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return null
  const parsed = Date.parse(`${key}T00:00:00.000Z`)
  return Number.isNaN(parsed) ? null : parsed
}

export function startOfDayUtc(timestamp: number): number {
  const date = new Date(timestamp)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}

export function startOfWeekUtc(timestamp: number): number {
  const dayStart = startOfDayUtc(timestamp)
  const day = new Date(dayStart).getUTCDay()
  const diff = (day + 6) % 7
  return dayStart - diff * DAY_MS
}

export function buildTimeBuckets(
  period: TimeBucketPeriod,
  limit: number,
  now: number = Date.now()
): TimeBucket[] {
  const safeLimit = Math.max(1, limit)
  const buckets: TimeBucket[] = []

  if (period === 'day') {
    const todayStart = startOfDayUtc(now)
    for (let i = safeLimit - 1; i >= 0; i -= 1) {
      const start = todayStart - i * DAY_MS
      buckets.push({ start, end: start + DAY_MS, key: toDateKeyUtc(start) })
    }
    return buckets
  }

  const weekStart = startOfWeekUtc(now)
  for (let i = safeLimit - 1; i >= 0; i -= 1) {
    const start = weekStart - i * 7 * DAY_MS
    buckets.push({ start, end: start + 7 * DAY_MS, key: toDateKeyUtc(start) })
  }
  return buckets
}
