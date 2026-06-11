import { getRunStatus, type ExtractionRunStatus } from '../../../src/lib/extraction-status.js'
import { DAY_MS } from '../../../src/lib/time-buckets.js'
import type { ExtractionRun } from '../../../shared/types.js'

const HOUR_MS = 60 * 60 * 1000

export const EXTRACTION_WARNING_THRESHOLDS = {
  recentWindowMs: DAY_MS,
  highFailureMinRuns: 3,
  highFailureMinFailures: 2,
  highFailureRate: 0.5,
  stalledMinSuccessfulRuns: 4,
  stalledAbsoluteFloorMs: 3 * DAY_MS,
  stalledIntervalMultiplier: 4
} as const

export type ExtractionWarningKind =
  | 'rate_limited'
  | 'auth'
  | 'record_store_failures'
  | 'high_failure_rate'
  | 'stalled'

export type ExtractionWarningSeverity = 'warning' | 'critical'

export interface ExtractionWarning {
  id: ExtractionWarningKind
  severity: ExtractionWarningSeverity
  title: string
  message: string
  count?: number
  latestRunId?: string
  latestTimestamp?: number
  details?: Record<string, unknown>
}

export interface ExtractionWarningsPayload {
  generatedAt: number
  window: {
    start: number
    end: number
    ms: number
  }
  thresholds: typeof EXTRACTION_WARNING_THRESHOLDS
  summary: {
    analyzedRuns: number
    recentRuns: number
    excludedReExtractRuns: number
    inProgressCount: number
    inProgressLocksCollectionScoped: false
    stalledSuppressedByInProgress: boolean
    lastSuccessfulRun?: {
      runId: string
      timestamp: number
      status: Extract<ExtractionRunStatus, 'completed' | 'partial'>
    }
  }
  warnings: ExtractionWarning[]
}

type RunWithStatus = {
  run: ExtractionRun
  status: ExtractionRunStatus
}

export function buildExtractionWarnings(
  runs: ExtractionRun[],
  inProgressCount: number,
  now: number
): ExtractionWarningsPayload {
  const windowStart = now - EXTRACTION_WARNING_THRESHOLDS.recentWindowMs
  const analyzedRuns = runs
    .filter(run => run.isReExtract !== true)
    .sort((a, b) => b.timestamp - a.timestamp)
  const recentRuns = analyzedRuns.filter(run => run.timestamp >= windowStart && run.timestamp <= now)
  const recentWithStatus = recentRuns.map(run => ({ run, status: getRunStatus(run) }))
  const successfulRuns = analyzedRuns
    .filter(run => Number.isFinite(run.timestamp) && run.timestamp <= now)
    .map(run => ({ run, status: getRunStatus(run) }))
    .filter(isSuccessfulRun)
    .sort((a, b) => b.run.timestamp - a.run.timestamp)

  const warnings: ExtractionWarning[] = []
  addRateLimitWarning(warnings, recentRuns)
  addAuthWarning(warnings, recentRuns)
  addRecordStoreWarning(warnings, recentWithStatus)
  addHighFailureRateWarning(warnings, recentWithStatus)
  addStalledWarning(warnings, runs.length, successfulRuns, inProgressCount, now)

  const lastSuccessful = successfulRuns[0]
  const stalledSuppressedByInProgress = runs.length > 0
    && successfulRuns.length >= EXTRACTION_WARNING_THRESHOLDS.stalledMinSuccessfulRuns
    && inProgressCount > 0

  return {
    generatedAt: now,
    window: {
      start: windowStart,
      end: now,
      ms: EXTRACTION_WARNING_THRESHOLDS.recentWindowMs
    },
    thresholds: EXTRACTION_WARNING_THRESHOLDS,
    summary: {
      analyzedRuns: analyzedRuns.length,
      recentRuns: recentRuns.length,
      excludedReExtractRuns: runs.length - analyzedRuns.length,
      inProgressCount,
      inProgressLocksCollectionScoped: false,
      stalledSuppressedByInProgress,
      ...(lastSuccessful ? {
        lastSuccessfulRun: {
          runId: lastSuccessful.run.runId,
          timestamp: lastSuccessful.run.timestamp,
          status: lastSuccessful.status
        }
      } : {})
    },
    warnings
  }
}

function addRateLimitWarning(warnings: ExtractionWarning[], recentRuns: ExtractionRun[]): void {
  const matches = recentRuns.filter(isRateLimitedRun)
  if (matches.length === 0) return
  const latest = latestRun(matches)
  warnings.push({
    id: 'rate_limited',
    severity: 'warning',
    title: 'Extraction rate limited',
    message: `${matches.length} recent extraction ${plural(matches.length, 'run')} hit Anthropic rate limits.`,
    count: matches.length,
    latestRunId: latest?.runId,
    latestTimestamp: latest?.timestamp,
    details: {
      windowMs: EXTRACTION_WARNING_THRESHOLDS.recentWindowMs
    }
  })
}

function addAuthWarning(warnings: ExtractionWarning[], recentRuns: ExtractionRun[]): void {
  const matches = recentRuns.filter(isAuthFailureRun)
  if (matches.length === 0) return
  const latest = latestRun(matches)
  warnings.push({
    id: 'auth',
    severity: 'critical',
    title: 'Extraction authentication failing',
    message: `${matches.length} recent extraction ${plural(matches.length, 'run')} could not authenticate. Check Anthropic credentials.`,
    count: matches.length,
    latestRunId: latest?.runId,
    latestTimestamp: latest?.timestamp,
    details: {
      windowMs: EXTRACTION_WARNING_THRESHOLDS.recentWindowMs
    }
  })
}

function addRecordStoreWarning(warnings: ExtractionWarning[], recentRuns: RunWithStatus[]): void {
  const matches = recentRuns.filter(entry => entry.status !== 'failed' && (entry.run.failedRecordCount ?? 0) > 0)
  if (matches.length === 0) return
  const matchedRuns = matches.map(entry => entry.run)
  const latest = latestRun(matchedRuns)
  const failedRecords = matchedRuns.reduce((sum, run) => sum + (run.failedRecordCount ?? 0), 0)
  warnings.push({
    id: 'record_store_failures',
    severity: 'warning',
    title: 'Extracted records failed to store',
    message: `${failedRecords} extracted ${plural(failedRecords, 'record')} failed to store across ${matchedRuns.length} recent ${plural(matchedRuns.length, 'run')}.`,
    count: failedRecords,
    latestRunId: latest?.runId,
    latestTimestamp: latest?.timestamp,
    details: {
      runCount: matchedRuns.length,
      failedRecordCount: failedRecords,
      windowMs: EXTRACTION_WARNING_THRESHOLDS.recentWindowMs
    }
  })
}

function addHighFailureRateWarning(warnings: ExtractionWarning[], recentRuns: RunWithStatus[]): void {
  const total = recentRuns.length
  if (total < EXTRACTION_WARNING_THRESHOLDS.highFailureMinRuns) return

  const failed = recentRuns.filter(entry => entry.status === 'failed')
  if (failed.length < EXTRACTION_WARNING_THRESHOLDS.highFailureMinFailures) return

  const failureRate = failed.length / total
  if (failureRate < EXTRACTION_WARNING_THRESHOLDS.highFailureRate) return

  const latest = latestRun(failed.map(entry => entry.run))
  const allFailed = failed.length === total
  warnings.push({
    id: 'high_failure_rate',
    severity: allFailed ? 'critical' : 'warning',
    title: 'Extraction failure rate elevated',
    message: `${failed.length} of ${total} recent extraction ${plural(total, 'run')} failed.`,
    count: failed.length,
    latestRunId: latest?.runId,
    latestTimestamp: latest?.timestamp,
    details: {
      failedRuns: failed.length,
      analyzedRecentRuns: total,
      failureRate,
      windowMs: EXTRACTION_WARNING_THRESHOLDS.recentWindowMs
    }
  })
}

function addStalledWarning(
  warnings: ExtractionWarning[],
  totalRuns: number,
  successfulRuns: Array<RunWithStatus & { status: 'completed' | 'partial' }>,
  inProgressCount: number,
  now: number
): void {
  if (totalRuns === 0) return
  if (inProgressCount > 0) return
  if (successfulRuns.length < EXTRACTION_WARNING_THRESHOLDS.stalledMinSuccessfulRuns) return

  const timestamps = successfulRuns
    .map(entry => entry.run.timestamp)
    .filter(timestamp => Number.isFinite(timestamp))
    .sort((a, b) => a - b)
  if (timestamps.length < EXTRACTION_WARNING_THRESHOLDS.stalledMinSuccessfulRuns) return

  const intervals = buildIntervals(timestamps)
  if (intervals.length < EXTRACTION_WARNING_THRESHOLDS.stalledMinSuccessfulRuns - 1) return

  const medianIntervalMs = median(intervals)

  const thresholdMs = Math.max(
    EXTRACTION_WARNING_THRESHOLDS.stalledAbsoluteFloorMs,
    medianIntervalMs * EXTRACTION_WARNING_THRESHOLDS.stalledIntervalMultiplier
  )
  const lastSuccess = successfulRuns[0]
  const elapsedMs = now - lastSuccess.run.timestamp
  if (elapsedMs <= thresholdMs) return

  warnings.push({
    id: 'stalled',
    severity: 'warning',
    title: 'Extraction appears stalled',
    message: `No successful extraction for ${formatApproxDuration(elapsedMs)}; expected within ${formatApproxDuration(thresholdMs)} based on recent cadence.`,
    latestRunId: lastSuccess.run.runId,
    latestTimestamp: lastSuccess.run.timestamp,
    details: {
      elapsedMs,
      thresholdMs,
      medianIntervalMs,
      successfulRuns: successfulRuns.length,
      inProgressCount,
      inProgressLocksCollectionScoped: false
    }
  })
}

function isSuccessfulRun(entry: RunWithStatus): entry is RunWithStatus & { status: 'completed' | 'partial' } {
  return entry.status === 'completed' || entry.status === 'partial'
}

function isRateLimitedRun(run: ExtractionRun): boolean {
  const failure = run.error
  return failure?.kind === 'api_error'
    && (failure.code === 'rate_limit_error' || failure.status === 429)
}

function isAuthFailureRun(run: ExtractionRun): boolean {
  const failure = run.error
  if (!failure) return false
  if (failure.kind === 'no_auth') return true
  return failure.kind === 'api_error' && (failure.status === 401 || failure.status === 403)
}

function latestRun(runs: ExtractionRun[]): ExtractionRun | undefined {
  return runs.reduce<ExtractionRun | undefined>((latest, run) => {
    if (!latest || run.timestamp > latest.timestamp) return run
    return latest
  }, undefined)
}

function buildIntervals(timestamps: number[]): number[] {
  const intervals: number[] = []
  for (let i = 1; i < timestamps.length; i += 1) {
    const interval = timestamps[i] - timestamps[i - 1]
    if (interval > 0) intervals.push(interval)
  }
  return intervals
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid]
  return (sorted[mid - 1] + sorted[mid]) / 2
}

function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`
}

function formatApproxDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return '0m'
  const days = Math.floor(durationMs / DAY_MS)
  if (days > 0) return `${days}d`
  const hours = Math.floor(durationMs / HOUR_MS)
  if (hours > 0) return `${hours}h`
  const minutes = Math.max(1, Math.floor(durationMs / 60000))
  return `${minutes}m`
}
