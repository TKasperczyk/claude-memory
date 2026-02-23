import { asInteger, asNumber, isPlainObject } from './parsing.js'
import { JsonStore } from './file-store.js'
import {
  buildTimeBuckets,
  parseDateKeyUtc,
  startOfWeekUtc,
  toDateKeyUtc,
  DAY_MS,
  type TimeBucketPeriod
} from './time-buckets.js'
import type {
  MemoryStatsSummary,
  StatsSnapshot
} from '../../shared/types.js'

const SNAPSHOT_SUFFIX = '.json'
const SNAPSHOT_RETENTION_DAYS = 180
const snapshotsStore = new JsonStore('stats-snapshots', { suffix: SNAPSHOT_SUFFIX })

type StatsHistoryBucket = {
  start: number
  end: number
  snapshot: StatsSnapshot | null
}

export type StatsHistory = {
  period: TimeBucketPeriod
  buckets: StatsHistoryBucket[]
}

function cleanupOldSnapshots(collection?: string): void {
  const cutoff = Date.now() - SNAPSHOT_RETENTION_DAYS * DAY_MS

  try {
    snapshotsStore.cleanupByAge({
      collection,
      cutoffMs: cutoff,
      keyToTimestamp: dateKey => parseDateKeyUtc(dateKey)
    })
  } catch (error) {
    console.error('[claude-memory] Failed to clean up stats snapshots:', error)
  }
}

function coerceCountMap(value: unknown): Record<string, number> {
  if (!isPlainObject(value)) return {}
  const entries: Record<string, number> = {}
  for (const [key, raw] of Object.entries(value)) {
    const parsed = asNumber(raw)
    if (parsed === null) continue
    entries[key] = parsed
  }
  return entries
}

function coerceStatsSnapshot(value: unknown, dateKey: string): StatsSnapshot | null {
  if (!isPlainObject(value)) return null
  const record = value

  const timestamp = asInteger(record.timestamp) ?? parseDateKeyUtc(dateKey) ?? Date.now()

  return {
    timestamp,
    total: asInteger(record.total) ?? 0,
    byType: coerceCountMap(record.byType),
    byProject: coerceCountMap(record.byProject),
    byScope: coerceCountMap(record.byScope),
    avgRetrievalCount: asNumber(record.avgRetrievalCount) ?? 0,
    avgUsageCount: asNumber(record.avgUsageCount) ?? 0,
    avgUsageRatio: asNumber(record.avgUsageRatio) ?? 0,
    deprecated: asInteger(record.deprecated) ?? 0
  }
}

export function saveStatsSnapshot(snapshot: StatsSnapshot, options: { collection?: string } = {}): void {
  try {
    cleanupOldSnapshots(options.collection)
    const dateKey = toDateKeyUtc(snapshot.timestamp)
    snapshotsStore.write(dateKey, snapshot, {
      collection: options.collection,
      ensureDir: true,
      pretty: 2
    })
  } catch (error) {
    console.error('[claude-memory] Failed to write stats snapshot:', error)
  }
}

export function hasStatsSnapshot(timestamp: number, collection?: string): boolean {
  const dateKey = toDateKeyUtc(timestamp)
  return snapshotsStore.exists(dateKey, { collection })
}

export function saveStatsSnapshotIfNeeded(
  stats: MemoryStatsSummary,
  options: { collection?: string; timestamp?: number } = {}
): StatsSnapshot | null {
  const timestamp = options.timestamp ?? Date.now()
  if (hasStatsSnapshot(timestamp, options.collection)) return null

  const snapshot: StatsSnapshot = {
    timestamp,
    ...stats
  }
  saveStatsSnapshot(snapshot, { collection: options.collection })
  return snapshot
}

export function getStatsSnapshot(dateKey: string, collection?: string): StatsSnapshot | null {
  return snapshotsStore.read(dateKey, {
    collection,
    errorMessage: '[claude-memory] Failed to read stats snapshot:',
    coerce: data => coerceStatsSnapshot(data, dateKey),
    fallback: null
  })
}

export function listStatsSnapshots(collection?: string): StatsSnapshot[] {
  try {
    const snapshots: StatsSnapshot[] = []
    for (const dateKey of snapshotsStore.list({ collection })) {
      const snapshot = getStatsSnapshot(dateKey, collection)
      if (snapshot) snapshots.push(snapshot)
    }
    snapshots.sort((a, b) => a.timestamp - b.timestamp)
    return snapshots
  } catch (error) {
    console.error('[claude-memory] Failed to list stats snapshots:', error)
    return []
  }
}

function pickLatestSnapshot(
  snapshots: StatsSnapshot[],
  period: TimeBucketPeriod
): Map<string, StatsSnapshot> {
  const selected = new Map<string, StatsSnapshot>()
  for (const snapshot of snapshots) {
    const key = period === 'day'
      ? toDateKeyUtc(snapshot.timestamp)
      : toDateKeyUtc(startOfWeekUtc(snapshot.timestamp))
    const existing = selected.get(key)
    if (!existing || snapshot.timestamp > existing.timestamp) {
      selected.set(key, snapshot)
    }
  }
  return selected
}

export function getStatsHistory(
  period: TimeBucketPeriod,
  options: { limit?: number; collection?: string; now?: number } = {}
): StatsHistory {
  const limit = options.limit ?? (period === 'week' ? 12 : 30)
  const safeLimit = Math.max(1, period === 'week' ? Math.min(limit, 104) : Math.min(limit, 365))
  const now = options.now ?? Date.now()

  cleanupOldSnapshots(options.collection)
  const snapshots = listStatsSnapshots(options.collection)
  const byBucket = pickLatestSnapshot(snapshots, period)
  const buckets = buildTimeBuckets(period, safeLimit, now)

  return {
    period,
    buckets: buckets.map(bucket => ({
      start: bucket.start,
      end: bucket.end,
      snapshot: byBucket.get(bucket.key) ?? null
    }))
  }
}
