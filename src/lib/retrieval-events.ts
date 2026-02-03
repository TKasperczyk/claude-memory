import fs from 'fs'
import path from 'path'
import { homedir } from 'os'
import { sanitizeRunId } from './shared.js'
import { DEFAULT_CONFIG } from './types.js'
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

const EVENTS_ROOT = path.join(homedir(), '.claude-memory', 'retrieval-events')
const EVENT_SUFFIX = '.jsonl'
const RETRIEVAL_RETENTION_DAYS = 90

function getCollectionKey(collection?: string): string {
  const fallback = DEFAULT_CONFIG.milvus.collection
  const raw = (collection ?? fallback).trim()
  return sanitizeRunId(raw || fallback)
}

function getCollectionDir(collection?: string): string {
  return path.join(EVENTS_ROOT, getCollectionKey(collection))
}

function getEventPath(dateKey: string, collection?: string): string {
  return path.join(getCollectionDir(collection), `${dateKey}${EVENT_SUFFIX}`)
}

function cleanupOldEvents(collection?: string): void {
  const dir = getCollectionDir(collection)
  if (!fs.existsSync(dir)) return

  const cutoff = Date.now() - RETRIEVAL_RETENTION_DAYS * DAY_MS

  try {
    const files = fs.readdirSync(dir).filter(file => file.endsWith(EVENT_SUFFIX))
    for (const file of files) {
      const dateKey = file.slice(0, -EVENT_SUFFIX.length)
      const dayStart = parseDateKeyUtc(dateKey)
      const filePath = path.join(dir, file)
      const reference = dayStart ?? fs.statSync(filePath).mtimeMs
      if (reference < cutoff) {
        fs.unlinkSync(filePath)
      }
    }
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
  const dir = getCollectionDir(collection)
  if (!fs.existsSync(dir)) return new Map()

  const counts = new Map<string, number>()
  const files = fs.readdirSync(dir).filter(file => file.endsWith(EVENT_SUFFIX))
  for (const file of files) {
    const dateKey = file.slice(0, -EVENT_SUFFIX.length)
    const filePath = path.join(dir, file)
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

    const dir = getCollectionDir(options.collection)
    fs.mkdirSync(dir, { recursive: true })

    for (const [dateKey, entries] of byDate) {
      const payload = entries.map(entry => JSON.stringify(entry)).join('\n') + '\n'
      fs.appendFileSync(getEventPath(dateKey, options.collection), payload, 'utf-8')
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
