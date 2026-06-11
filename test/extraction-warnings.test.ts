import { describe, expect, it } from 'vitest'
import {
  buildExtractionWarnings,
  EXTRACTION_WARNING_THRESHOLDS,
  type ExtractionWarning
} from '../dashboard/server/lib/extraction-warnings.js'
import { DAY_MS } from '../src/lib/time-buckets.js'
import type { ExtractionRun } from '../shared/types.js'

const HOUR_MS = 60 * 60 * 1000
const NOW = Date.UTC(2026, 5, 11, 12, 0, 0)

function run(overrides: Partial<ExtractionRun> = {}): ExtractionRun {
  const runId = overrides.runId ?? 'run-1'
  return {
    runId,
    sessionId: 'session-1',
    transcriptPath: '/tmp/session.jsonl',
    timestamp: NOW - HOUR_MS,
    recordCount: 0,
    parseErrorCount: 0,
    extractedRecordIds: [],
    duration: 0,
    ...overrides
  }
}

function success(runId: string, timestamp: number, overrides: Partial<ExtractionRun> = {}): ExtractionRun {
  return run({
    runId,
    timestamp,
    recordCount: 1,
    extractedRecordIds: [`record-${runId}`],
    ...overrides
  })
}

function failed(runId: string, timestamp: number, overrides: Partial<ExtractionRun> = {}): ExtractionRun {
  return run({
    runId,
    timestamp,
    error: { kind: 'parse_error', message: 'Extraction tool call missing' },
    ...overrides
  })
}

function successSeries(
  prefix: string,
  lastElapsedMs: number,
  intervals: number[],
  overrides: Partial<ExtractionRun> = {}
): ExtractionRun[] {
  const timestamps: number[] = []
  let timestamp = NOW - lastElapsedMs - intervals.reduce((sum, interval) => sum + interval, 0)
  timestamps.push(timestamp)
  for (const interval of intervals) {
    timestamp += interval
    timestamps.push(timestamp)
  }
  return timestamps.map((ts, index) => success(`${prefix}-${index + 1}`, ts, overrides))
}

function warningIds(warnings: ExtractionWarning[]): string[] {
  return warnings.map(warning => warning.id).sort()
}

function findWarning(warnings: ExtractionWarning[], id: ExtractionWarning['id']): ExtractionWarning {
  const warning = warnings.find(entry => entry.id === id)
  if (!warning) throw new Error(`Expected warning ${id}`)
  return warning
}

describe('buildExtractionWarnings', () => {
  it('uses the stalled threshold as an exclusive boundary', () => {
    const thresholdMs = EXTRACTION_WARNING_THRESHOLDS.stalledAbsoluteFloorMs
    const atBoundary = buildExtractionWarnings(
      successSeries('boundary', thresholdMs, [HOUR_MS, HOUR_MS, HOUR_MS]),
      0,
      NOW
    )
    expect(warningIds(atBoundary.warnings)).toEqual([])

    const pastBoundary = buildExtractionWarnings(
      successSeries('boundary', thresholdMs + 1, [HOUR_MS, HOUR_MS, HOUR_MS]),
      0,
      NOW
    )
    expect(warningIds(pastBoundary.warnings)).toEqual(['stalled'])
  })

  it('pins odd-count non-uniform median intervals for stalled cadence', () => {
    const intervals = [20 * HOUR_MS, 40 * HOUR_MS, 60 * HOUR_MS]
    const elapsedMs = 160 * HOUR_MS + 1
    const result = buildExtractionWarnings(successSeries('odd', elapsedMs, intervals), 0, NOW)

    expect(warningIds(result.warnings)).toEqual(['stalled'])
    expect(findWarning(result.warnings, 'stalled').details).toMatchObject({
      medianIntervalMs: 40 * HOUR_MS,
      thresholdMs: 160 * HOUR_MS
    })
  })

  it('pins even-count non-uniform median intervals for stalled cadence', () => {
    const intervals = [20 * HOUR_MS, 40 * HOUR_MS, 80 * HOUR_MS, 100 * HOUR_MS]
    const elapsedMs = 240 * HOUR_MS + 1
    const result = buildExtractionWarnings(successSeries('even', elapsedMs, intervals), 0, NOW)

    expect(warningIds(result.warnings)).toEqual(['stalled'])
    expect(findWarning(result.warnings, 'stalled').details).toMatchObject({
      medianIntervalMs: 60 * HOUR_MS,
      thresholdMs: 240 * HOUR_MS
    })
  })

  it('warns for record store failures only when failedRecordCount is positive', () => {
    const result = buildExtractionWarnings([
      success('undefined-failed-count', NOW - HOUR_MS),
      success('zero-failed-count', NOW - 2 * HOUR_MS, { failedRecordCount: 0 }),
      success('store-failed', NOW - 3 * HOUR_MS, { failedRecordCount: 2 })
    ], 0, NOW)

    expect(warningIds(result.warnings)).toEqual(['record_store_failures'])
    expect(findWarning(result.warnings, 'record_store_failures').count).toBe(2)
  })

  it('does not warn for high failure rate below the minimum recent run count', () => {
    const result = buildExtractionWarnings([
      failed('failed-1', NOW - HOUR_MS),
      failed('failed-2', NOW - 2 * HOUR_MS)
    ], 0, NOW)

    expect(warningIds(result.warnings)).toEqual([])
  })

  it('keeps high failure rate at warning severity when not all recent runs failed', () => {
    const result = buildExtractionWarnings([
      failed('failed-1', NOW - HOUR_MS),
      failed('failed-2', NOW - 2 * HOUR_MS),
      failed('failed-3', NOW - 3 * HOUR_MS),
      success('success-1', NOW - 4 * HOUR_MS)
    ], 0, NOW)

    expect(warningIds(result.warnings)).toEqual(['high_failure_rate'])
    expect(findWarning(result.warnings, 'high_failure_rate').severity).toBe('warning')
  })

  it('does not emit stalled with only three stale successes', () => {
    const result = buildExtractionWarnings([
      success('success-1', NOW - 7 * DAY_MS),
      success('success-2', NOW - 6 * DAY_MS),
      success('success-3', NOW - 5 * DAY_MS)
    ], 0, NOW)

    expect(warningIds(result.warnings)).toEqual([])
  })

  it('excludes successful re-extract runs from the stalled cadence baseline', () => {
    const result = buildExtractionWarnings([
      success('manual-reextract', NOW - HOUR_MS, { isReExtract: true }),
      ...successSeries('normal', 10 * DAY_MS, [HOUR_MS, HOUR_MS, HOUR_MS])
    ], 0, NOW)

    expect(warningIds(result.warnings)).toEqual(['stalled'])
    expect(findWarning(result.warnings, 'stalled').latestRunId).toBe('normal-4')
  })

  it('fires stalled for burst successes once the absolute floor is exceeded', () => {
    const result = buildExtractionWarnings(
      successSeries('burst', 10 * DAY_MS, [2 * HOUR_MS, 2 * HOUR_MS, 2 * HOUR_MS]),
      0,
      NOW
    )

    expect(warningIds(result.warnings)).toEqual(['stalled'])
  })

  it('excludes future successful runs from stalled cadence candidates', () => {
    const result = buildExtractionWarnings([
      success('future-success', NOW + HOUR_MS),
      ...successSeries('normal', 10 * DAY_MS, [HOUR_MS, HOUR_MS, HOUR_MS])
    ], 0, NOW)

    expect(warningIds(result.warnings)).toEqual(['stalled'])
    expect(findWarning(result.warnings, 'stalled').latestRunId).toBe('normal-4')
  })

  it('detects auth via status 401 and excludes future runs from window signals', () => {
    const result = buildExtractionWarnings([
      run({
        runId: 'auth-401',
        timestamp: NOW - HOUR_MS,
        error: { kind: 'api_error', status: 401, message: 'Unauthorized' }
      }),
      run({
        runId: 'future-rate-limit',
        timestamp: NOW + HOUR_MS,
        error: { kind: 'api_error', status: 429, code: 'rate_limit_error', message: 'Future rate limit' }
      })
    ], 0, NOW)

    expect(warningIds(result.warnings)).toEqual(['auth'])
  })

  it('does not double-fire store warnings for true failed runs with failedRecordCount', () => {
    const result = buildExtractionWarnings([
      failed('failed-store-1', NOW - HOUR_MS, { failedRecordCount: 3 }),
      failed('failed-store-2', NOW - 2 * HOUR_MS, { failedRecordCount: 2 }),
      failed('failed-store-3', NOW - 3 * HOUR_MS, { failedRecordCount: 1 })
    ], 0, NOW)

    expect(warningIds(result.warnings)).toEqual(['high_failure_rate'])
  })

  it('marks in-progress stalled suppression only when enough successful history exists', () => {
    const freshInstall = buildExtractionWarnings([], 1, NOW)
    expect(freshInstall.summary.stalledSuppressedByInProgress).toBe(false)
    expect(warningIds(freshInstall.warnings)).toEqual([])

    const coldStart = buildExtractionWarnings([
      success('success-1', NOW - 7 * DAY_MS),
      success('success-2', NOW - 6 * DAY_MS),
      success('success-3', NOW - 5 * DAY_MS)
    ], 1, NOW)
    expect(coldStart.summary.stalledSuppressedByInProgress).toBe(false)
    expect(warningIds(coldStart.warnings)).toEqual([])

    const suppressed = buildExtractionWarnings(
      successSeries('normal', 10 * DAY_MS, [HOUR_MS, HOUR_MS, HOUR_MS]),
      1,
      NOW
    )
    expect(suppressed.summary.stalledSuppressedByInProgress).toBe(true)
    expect(warningIds(suppressed.warnings)).toEqual([])
  })
})
