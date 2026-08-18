import type { ExtractionFailure } from '../../shared/types.js'

export type ExtractionRunStatus = 'failed' | 'skipped' | 'partial' | 'completed'

export interface ExtractionRunStatusInput {
  error?: ExtractionFailure
  recordCount: number
  failedRecordCount?: number
  skipReason?: string
}

export function isTrueExtractionFailure(
  failure: ExtractionFailure | undefined,
  persistedRecordCount: number
): boolean {
  return Boolean(failure && persistedRecordCount === 0)
}

/** Every recorded store attempt failed before any extracted memory was persisted. */
export function isAllStoreFailure(run: Pick<ExtractionRunStatusInput, 'recordCount' | 'failedRecordCount'>): boolean {
  return run.recordCount === 0 && (run.failedRecordCount ?? 0) > 0
}

export function isExtractionRunFailure(run: ExtractionRunStatusInput): boolean {
  return isTrueExtractionFailure(run.error, run.recordCount) || isAllStoreFailure(run)
}

export function getRunStatus(run: ExtractionRunStatusInput): ExtractionRunStatus {
  if (isExtractionRunFailure(run)) return 'failed'
  if (run.skipReason) return 'skipped'
  if (run.error) return 'partial'
  return 'completed'
}

export function formatExtractionFailureSummary(failure: ExtractionFailure | undefined): string {
  if (!failure) return ''
  if (failure.kind === 'api_error') {
    if (failure.code) return `api_error:${failure.code}`
    if (failure.status !== undefined) return `api_error:status_${failure.status}`
    return 'api_error'
  }
  return failure.kind
}
