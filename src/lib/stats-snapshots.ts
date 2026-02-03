import fs from 'fs'
import path from 'path'
import { homedir } from 'os'
import { asInteger, asNumber, isPlainObject } from './parsing.js'
import { readJsonFileSafe, writeJsonFile } from './json.js'
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
  MemoryStatsSummary,
  StatsSnapshot
} from '../../shared/types.js'

const SNAPSHOTS_ROOT = path.join(homedir(), '.claude-memory', 'stats-snapshots')
const SNAPSHOT_SUFFIX = '.json'
const SNAPSHOT_RETENTION_DAYS = 180

type StatsHistoryBucket = {
  start: number
  end: number
  snapshot: StatsSnapshot | null
}

export type StatsHistory = {
  period: TimeBucketPeriod
  buckets: StatsHistoryBucket[]
}

function getCollectionKey(collection?: string): string {
  const fallback = DEFAULT_CONFIG.milvus.collection
  const raw = (collection ?? fallback).trim()
  return sanitizeRunId(raw || fallback)
}

function getSnapshotsDir(collection?: string): string {
  return path.join(SNAPSHOTS_ROOT, getCollectionKey(collection))
}

function getSnapshotPath(dateKey: string, collection?: string): string {
  return path.join(getSnapshotsDir(collection), `${dateKey}${SNAPSHOT_SUFFIX}`)
}

function cleanupOldSnapshots(collection?: string): void {
  const dir = getSnapshotsDir(collection)
  if (!fs.existsSync(dir)) return

  const cutoff = Date.now() - SNAPSHOT_RETENTION_DAYS * DAY_MS

  try {
    const files = fs.readdirSync(dir).filter(file => file.endsWith(SNAPSHOT_SUFFIX))
    for (const file of files) {
      const dateKey = file.slice(0, -SNAPSHOT_SUFFIX.length)
      const dayStart = parseDateKeyUtc(dateKey)
      const filePath = path.join(dir, file)
      const reference = dayStart ?? fs.statSync(filePath).mtimeMs
      if (reference < cutoff) {
        fs.unlinkSync(filePath)
      }
    }
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
    byDomain: coerceCountMap(record.byDomain),
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
    const filePath = getSnapshotPath(dateKey, options.collection)
    writeJsonFile(filePath, snapshot, { ensureDir: true, pretty: 2 })
  } catch (error) {
    console.error('[claude-memory] Failed to write stats snapshot:', error)
  }
}

export function hasStatsSnapshot(timestamp: number, collection?: string): boolean {
  const dateKey = toDateKeyUtc(timestamp)
  return fs.existsSync(getSnapshotPath(dateKey, collection))
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
  const filePath = getSnapshotPath(dateKey, collection)
  return readJsonFileSafe(filePath, {
    errorMessage: '[claude-memory] Failed to read stats snapshot:',
    coerce: data => coerceStatsSnapshot(data, dateKey)
  })
}

export function listStatsSnapshots(collection?: string): StatsSnapshot[] {
  const dir = getSnapshotsDir(collection)
  if (!fs.existsSync(dir)) return []

  try {
    const files = fs.readdirSync(dir).filter(file => file.endsWith(SNAPSHOT_SUFFIX))
    const snapshots: StatsSnapshot[] = []
    for (const file of files) {
      const dateKey = file.slice(0, -SNAPSHOT_SUFFIX.length)
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
