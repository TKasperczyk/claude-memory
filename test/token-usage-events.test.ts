import { randomUUID } from 'crypto'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getCollectionKey } from '../src/lib/file-store.js'
import { DAY_MS, startOfWeekUtc } from '../src/lib/time-buckets.js'
import { getTokenUsageActivity, recordTokenUsageEvents } from '../src/lib/token-usage-events.js'
import type { TokenUsageActivity, TokenUsageBucket } from '../shared/types.js'

function toDateKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10)
}

function getBucketByDate(activity: TokenUsageActivity, dateKey: string): TokenUsageBucket | undefined {
  return activity.buckets.find(bucket => toDateKey(bucket.start) === dateKey)
}

let collection = ''
let collectionDir = ''

beforeEach(async () => {
  collection = `token-usage-test-${randomUUID()}`
  collectionDir = path.join(
    os.homedir(),
    '.claude-memory',
    'token-usage-events',
    getCollectionKey(collection)
  )
  await fs.rm(collectionDir, { recursive: true, force: true })
})

afterEach(async () => {
  vi.useRealTimers()
  await fs.rm(collectionDir, { recursive: true, force: true })
})

describe('token usage events', () => {
  it('records events and aggregates totals by day', () => {
    const now = Date.UTC(2026, 1, 16, 12, 0, 0)
    const twoDaysAgo = now - (2 * DAY_MS)
    const oneDayAgo = now - DAY_MS

    recordTokenUsageEvents([
      {
        timestamp: twoDaysAgo + 1_000,
        source: 'extraction',
        model: 'model-a',
        inputTokens: 10,
        outputTokens: 4,
        cacheCreationInputTokens: 2,
        cacheReadInputTokens: 1
      },
      {
        timestamp: twoDaysAgo + 2_000,
        source: 'haiku-query',
        model: 'model-b',
        inputTokens: 6,
        outputTokens: 5,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 3
      },
      {
        timestamp: oneDayAgo + 1_000,
        source: 'usefulness-rating',
        model: 'model-c',
        inputTokens: 7,
        outputTokens: 2,
        cacheCreationInputTokens: 1,
        cacheReadInputTokens: 0
      }
    ], { collection })

    const activity = getTokenUsageActivity('day', { collection, limit: 3, now })

    expect(activity.period).toBe('day')
    expect(activity.source).toBe('all')

    const twoDaysAgoBucket = getBucketByDate(activity, toDateKey(twoDaysAgo))
    expect(twoDaysAgoBucket).toMatchObject({
      totalTokens: 25,
      inputTokens: 16,
      outputTokens: 9,
      cacheCreationInputTokens: 2,
      cacheReadInputTokens: 4
    })

    const oneDayAgoBucket = getBucketByDate(activity, toDateKey(oneDayAgo))
    expect(oneDayAgoBucket).toMatchObject({
      totalTokens: 9,
      inputTokens: 7,
      outputTokens: 2,
      cacheCreationInputTokens: 1,
      cacheReadInputTokens: 0
    })

    const todayBucket = getBucketByDate(activity, toDateKey(now))
    expect(todayBucket).toMatchObject({
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0
    })
  })

  it('aggregates daily totals into weekly buckets', () => {
    const now = Date.UTC(2026, 1, 19, 12, 0, 0)
    const currentWeekEventA = now - DAY_MS
    const currentWeekEventB = now - (2 * DAY_MS)
    const previousWeekEvent = now - (8 * DAY_MS)

    recordTokenUsageEvents([
      {
        timestamp: currentWeekEventA,
        source: 'haiku-query',
        model: 'model-a',
        inputTokens: 3,
        outputTokens: 2,
        cacheCreationInputTokens: 1,
        cacheReadInputTokens: 0
      },
      {
        timestamp: currentWeekEventB,
        source: 'extraction',
        model: 'model-b',
        inputTokens: 7,
        outputTokens: 1,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 2
      },
      {
        timestamp: previousWeekEvent,
        source: 'usefulness-rating',
        model: 'model-c',
        inputTokens: 4,
        outputTokens: 4,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0
      }
    ], { collection })

    const activity = getTokenUsageActivity('week', { collection, limit: 2, now })
    const currentWeek = startOfWeekUtc(now)
    const previousWeek = currentWeek - (7 * DAY_MS)

    const currentBucket = getBucketByDate(activity, toDateKey(currentWeek))
    expect(currentBucket).toMatchObject({
      totalTokens: 13,
      inputTokens: 10,
      outputTokens: 3,
      cacheCreationInputTokens: 1,
      cacheReadInputTokens: 2
    })

    const previousBucket = getBucketByDate(activity, toDateKey(previousWeek))
    expect(previousBucket).toMatchObject({
      totalTokens: 8,
      inputTokens: 4,
      outputTokens: 4,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0
    })
  })

  it('supports source filtering', () => {
    const now = Date.UTC(2026, 1, 16, 12, 0, 0)

    recordTokenUsageEvents([
      {
        timestamp: now - 1_000,
        source: 'extraction',
        model: 'model-a',
        inputTokens: 10,
        outputTokens: 2,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0
      },
      {
        timestamp: now - 2_000,
        source: 'haiku-query',
        model: 'model-b',
        inputTokens: 4,
        outputTokens: 3,
        cacheCreationInputTokens: 1,
        cacheReadInputTokens: 2
      }
    ], { collection })

    const activity = getTokenUsageActivity('day', {
      collection,
      limit: 1,
      now,
      source: 'haiku-query'
    })

    expect(activity.source).toBe('haiku-query')
    expect(activity.buckets[0]).toMatchObject({
      totalTokens: 7,
      inputTokens: 4,
      outputTokens: 3,
      cacheCreationInputTokens: 1,
      cacheReadInputTokens: 2
    })
  })

  it('cleans up events older than retention window', async () => {
    vi.useFakeTimers()
    const now = Date.UTC(2026, 1, 16, 12, 0, 0)
    vi.setSystemTime(now)

    const staleTimestamp = now - (91 * DAY_MS)
    const freshTimestamp = now - DAY_MS
    const staleDateKey = toDateKey(staleTimestamp)
    const freshDateKey = toDateKey(freshTimestamp)

    recordTokenUsageEvents([
      {
        timestamp: staleTimestamp,
        source: 'extraction',
        model: 'model-a',
        inputTokens: 10,
        outputTokens: 10,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0
      },
      {
        timestamp: freshTimestamp,
        source: 'extraction',
        model: 'model-b',
        inputTokens: 2,
        outputTokens: 1,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0
      }
    ], { collection })

    const filesBefore = await fs.readdir(collectionDir)
    expect(filesBefore).toContain(`${staleDateKey}.jsonl`)
    expect(filesBefore).toContain(`${freshDateKey}.jsonl`)

    const activity = getTokenUsageActivity('day', { collection, limit: 120, now })
    const staleBucket = getBucketByDate(activity, staleDateKey)
    const freshBucket = getBucketByDate(activity, freshDateKey)

    expect(staleBucket).toMatchObject({ totalTokens: 0 })
    expect(freshBucket).toMatchObject({ totalTokens: 3 })

    const filesAfter = await fs.readdir(collectionDir)
    expect(filesAfter).not.toContain(`${staleDateKey}.jsonl`)
    expect(filesAfter).toContain(`${freshDateKey}.jsonl`)
  })
})
