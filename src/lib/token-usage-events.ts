import { JsonLinesStore } from './file-store.js'
import { listExtractionRuns } from './extraction-log.js'
import { asInteger, asTrimmedString, isPlainObject } from './parsing.js'
import {
  buildTimeBuckets,
  parseDateKeyUtc,
  startOfWeekUtc,
  toDateKeyUtc,
  DAY_MS,
  type TimeBucketPeriod
} from './time-buckets.js'
import type {
  TokenUsage,
  TokenUsageActivity,
  TokenUsageBucket,
  TokenUsageEvent,
  TokenUsageSource
} from '../../shared/types.js'

const EVENT_SUFFIX = '.jsonl'
const TOKEN_USAGE_RETENTION_DAYS = 90
const eventsStore = new JsonLinesStore('token-usage-events', { suffix: EVENT_SUFFIX })

type TokenUsageFilter = TokenUsageSource | 'all'
type TokenUsageTotals = TokenUsage & { totalTokens: number }

function emptyTotals(): TokenUsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    totalTokens: 0
  }
}

function normalizeTokenCount(value: unknown): number {
  const parsed = asInteger(value)
  if (parsed === null) return 0
  return Math.max(0, parsed)
}

function normalizeModel(value: unknown): string {
  return asTrimmedString(value) ?? 'unknown'
}

function asTokenUsageSource(value: unknown): TokenUsageSource | null {
  if (value === 'extraction' || value === 'haiku-query' || value === 'usefulness-rating') {
    return value
  }
  return null
}

function cleanupOldEvents(collection?: string): void {
  const cutoff = Date.now() - TOKEN_USAGE_RETENTION_DAYS * DAY_MS

  try {
    eventsStore.cleanupByAge({
      collection,
      cutoffMs: cutoff,
      keyToTimestamp: dateKey => parseDateKeyUtc(dateKey)
    })
  } catch (error) {
    console.error('[claude-memory] Failed to clean up token usage events:', error)
  }
}

function coerceTokenUsageEvent(value: unknown): TokenUsageEvent | null {
  if (!isPlainObject(value)) return null
  const timestamp = asInteger(value.timestamp)
  const source = asTokenUsageSource(value.source)
  if (timestamp === null || !source) return null

  return {
    timestamp,
    source,
    model: normalizeModel(value.model),
    inputTokens: normalizeTokenCount(value.inputTokens),
    outputTokens: normalizeTokenCount(value.outputTokens),
    cacheCreationInputTokens: normalizeTokenCount(value.cacheCreationInputTokens),
    cacheReadInputTokens: normalizeTokenCount(value.cacheReadInputTokens)
  }
}

function addUsage(target: TokenUsageTotals, value: TokenUsage): void {
  target.inputTokens += value.inputTokens
  target.outputTokens += value.outputTokens
  target.cacheCreationInputTokens += value.cacheCreationInputTokens
  target.cacheReadInputTokens += value.cacheReadInputTokens
  target.totalTokens += value.inputTokens + value.outputTokens
}

function readDailyTotals(source: TokenUsageFilter, collection?: string): Map<string, TokenUsageTotals> {
  const totalsByDate = new Map<string, TokenUsageTotals>()
  const dateKeys = eventsStore.list({ collection })

  for (const dateKey of dateKeys) {
    const entries = eventsStore.readLines<TokenUsageEvent>(dateKey, {
      collection,
      coerce: coerceTokenUsageEvent,
      onError: error => {
        console.error(`[claude-memory] Failed to read token usage events for ${dateKey}:`, error)
      },
      onLineError: error => {
        console.error(`[claude-memory] Failed to parse token usage event line for ${dateKey}:`, error)
      }
    })

    const totals = emptyTotals()
    for (const entry of entries) {
      if (source !== 'all' && entry.source !== source) continue
      addUsage(totals, entry)
    }

    if (totals.totalTokens > 0 || totals.cacheCreationInputTokens > 0 || totals.cacheReadInputTokens > 0) {
      totalsByDate.set(dateKey, totals)
    }
  }

  return totalsByDate
}

function sumWeeklyTotals(dailyTotals: Map<string, TokenUsageTotals>): Map<string, TokenUsageTotals> {
  const weeklyTotals = new Map<string, TokenUsageTotals>()
  for (const [dateKey, totals] of dailyTotals) {
    const dayStart = parseDateKeyUtc(dateKey)
    if (dayStart === null) continue
    const weekKey = toDateKeyUtc(startOfWeekUtc(dayStart))
    const weekly = weeklyTotals.get(weekKey)
    if (weekly) {
      addUsage(weekly, totals)
    } else {
      weeklyTotals.set(weekKey, { ...totals })
    }
  }
  return weeklyTotals
}

function buildBucket(start: number, end: number, totals: TokenUsageTotals | undefined): TokenUsageBucket {
  const usage = totals ?? emptyTotals()
  return {
    start,
    end,
    totalTokens: usage.totalTokens,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheCreationInputTokens: usage.cacheCreationInputTokens,
    cacheReadInputTokens: usage.cacheReadInputTokens
  }
}

export function recordTokenUsageEvents(
  events: TokenUsageEvent[],
  options: { collection?: string } = {}
): void {
  if (!events || events.length === 0) return

  try {
    cleanupOldEvents(options.collection)

    const byDate = new Map<string, TokenUsageEvent[]>()
    const now = Date.now()

    for (const event of events) {
      const source = asTokenUsageSource(event?.source)
      if (!source) continue

      const timestamp = Number.isFinite(event.timestamp)
        ? Math.trunc(event.timestamp)
        : now
      const dateKey = toDateKeyUtc(timestamp)
      const entry: TokenUsageEvent = {
        timestamp,
        source,
        model: normalizeModel(event.model),
        inputTokens: normalizeTokenCount(event.inputTokens),
        outputTokens: normalizeTokenCount(event.outputTokens),
        cacheCreationInputTokens: normalizeTokenCount(event.cacheCreationInputTokens),
        cacheReadInputTokens: normalizeTokenCount(event.cacheReadInputTokens)
      }

      const entries = byDate.get(dateKey)
      if (entries) {
        entries.push(entry)
      } else {
        byDate.set(dateKey, [entry])
      }
    }

    if (byDate.size === 0) return

    for (const [dateKey, entries] of byDate) {
      eventsStore.append(dateKey, entries, { collection: options.collection })
    }
  } catch (error) {
    console.error('[claude-memory] Failed to record token usage events:', error)
  }
}

export function recordTokenUsageEventsAsync(
  events: TokenUsageEvent[],
  options: { collection?: string } = {}
): void {
  if (!events || events.length === 0) return
  setImmediate(() => {
    recordTokenUsageEvents(events, options)
  })
}

export function getTokenUsageActivity(
  period: TimeBucketPeriod,
  options: { limit?: number; collection?: string; now?: number; source?: TokenUsageFilter } = {}
): TokenUsageActivity {
  const limit = options.limit ?? (period === 'week' ? 12 : 30)
  const safeLimit = Math.max(1, period === 'week' ? Math.min(limit, 104) : Math.min(limit, 365))
  const now = options.now ?? Date.now()
  const source = options.source ?? 'all'

  cleanupOldEvents(options.collection)

  const dailyTotals = readDailyTotals(source, options.collection)
  const buckets = buildTimeBuckets(period, safeLimit, now)
  const totalsByBucket = period === 'day' ? dailyTotals : sumWeeklyTotals(dailyTotals)

  return {
    period,
    source,
    buckets: buckets.map(bucket => buildBucket(
      bucket.start,
      bucket.end,
      totalsByBucket.get(bucket.key)
    ))
  }
}

export function backfillFromExtractionRuns(collection?: string): number {
  const runs = listExtractionRuns(collection)
  const events: TokenUsageEvent[] = []

  for (const run of runs) {
    if (!run.tokenUsage) continue
    events.push({
      timestamp: run.timestamp,
      source: 'extraction',
      model: 'unknown',
      inputTokens: run.tokenUsage.inputTokens,
      outputTokens: run.tokenUsage.outputTokens,
      cacheCreationInputTokens: run.tokenUsage.cacheCreationInputTokens,
      cacheReadInputTokens: run.tokenUsage.cacheReadInputTokens
    })
  }

  if (events.length > 0) {
    recordTokenUsageEvents(events, { collection })
  }
  return events.length
}
