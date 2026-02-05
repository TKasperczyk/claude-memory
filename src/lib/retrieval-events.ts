import fs from 'fs'
import { JsonLinesStore } from './file-store.js'
import {
  buildTimeBuckets,
  parseDateKeyUtc,
  startOfWeekUtc,
  toDateKeyUtc,
  DAY_MS,
  type TimeBucketPeriod
} from './time-buckets.js'
import type {
  RetrievalActivity,
  RetrievalActivityBucket,
  RetrievalEvent
} from '../../shared/types.js'

const EVENT_SUFFIX = '.jsonl'
const RETRIEVAL_RETENTION_DAYS = 90

const eventsStore = new JsonLinesStore('retrieval-events', { suffix: EVENT_SUFFIX })

export { getCollectionKey } from './file-store.js'

function getEventPath(dateKey: string, collection?: string): string {
  return eventsStore.buildPath(dateKey, { collection, sanitize: false })
}

function cleanupOldEvents(collection?: string): void {
  const cutoff = Date.now() - RETRIEVAL_RETENTION_DAYS * DAY_MS

  try {
    eventsStore.cleanupByAge({
      collection,
      cutoffMs: cutoff,
      keyToTimestamp: dateKey => parseDateKeyUtc(dateKey)
    })
  } catch (error) {
    console.error('[claude-memory] Failed to clean up retrieval events:', error)
  }
}

function countEvents(filePath: string): number {
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    if (!content.trim()) return 0
    return content.split('\n').filter(line => line.trim().length > 0).length
  } catch {
    return 0
  }
}

function readDailyCounts(collection?: string): Map<string, number> {
  const counts = new Map<string, number>()
  const dateKeys = eventsStore.list({ collection })
  for (const dateKey of dateKeys) {
    const filePath = getEventPath(dateKey, collection)
    counts.set(dateKey, countEvents(filePath))
  }
  return counts
}

export function recordRetrievalEvents(
  events: RetrievalEvent[],
  options: { collection?: string } = {}
): void {
  if (!events || events.length === 0) return

  try {
    cleanupOldEvents(options.collection)

    const byDate = new Map<string, RetrievalEvent[]>()
    const now = Date.now()

    for (const event of events) {
      if (!event?.id) continue
      const timestamp = Number.isFinite(event.timestamp)
        ? Math.trunc(event.timestamp)
        : now
      const key = toDateKeyUtc(timestamp)
      const entry: RetrievalEvent = {
        id: event.id,
        type: event.type,
        timestamp
      }
      const list = byDate.get(key)
      if (list) {
        list.push(entry)
      } else {
        byDate.set(key, [entry])
      }
    }

    if (byDate.size === 0) return

    for (const [dateKey, entries] of byDate) {
      eventsStore.append(dateKey, entries, { collection: options.collection })
    }
  } catch (error) {
    console.error('[claude-memory] Failed to record retrieval events:', error)
  }
}

function sumWeeklyCounts(dailyCounts: Map<string, number>): Map<string, number> {
  const weekly = new Map<string, number>()
  for (const [dateKey, count] of dailyCounts) {
    const dayStart = parseDateKeyUtc(dateKey)
    if (dayStart === null) continue
    const weekKey = toDateKeyUtc(startOfWeekUtc(dayStart))
    weekly.set(weekKey, (weekly.get(weekKey) ?? 0) + count)
  }
  return weekly
}

export function getRetrievalActivity(
  period: TimeBucketPeriod,
  options: { limit?: number; collection?: string; now?: number } = {}
): RetrievalActivity {
  const limit = options.limit ?? (period === 'week' ? 12 : 30)
  const safeLimit = Math.max(1, period === 'week' ? Math.min(limit, 104) : Math.min(limit, 365))
  const now = options.now ?? Date.now()

  cleanupOldEvents(options.collection)
  const dailyCounts = readDailyCounts(options.collection)
  const buckets = buildTimeBuckets(period, safeLimit, now)

  if (period === 'day') {
    const dailyBuckets: RetrievalActivityBucket[] = buckets.map(bucket => ({
      start: bucket.start,
      end: bucket.end,
      count: dailyCounts.get(bucket.key) ?? 0
    }))
    return { period, buckets: dailyBuckets }
  }

  const weeklyCounts = sumWeeklyCounts(dailyCounts)
  const weeklyBuckets: RetrievalActivityBucket[] = buckets.map(bucket => ({
    start: bucket.start,
    end: bucket.end,
    count: weeklyCounts.get(bucket.key) ?? 0
  }))
  return { period, buckets: weeklyBuckets }
}
