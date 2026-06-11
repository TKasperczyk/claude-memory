import fs from 'fs'
import path from 'path'
import { asInteger, asNumber, asRecordType, asString, asStringArray, asTrimmedString, isPlainObject } from './parsing.js'
import { getRecordSummary } from './record-summary.js'
import { RunLog } from './run-log.js'
import { LOCKS_DIR } from './paths.js'
import { isTrueExtractionFailure } from './extraction-status.js'
import type { ExtractionFailure, ExtractionRecordOutcome, ExtractionRecordSummary, ExtractionRun, MemoryRecord, RecordType, TokenUsage } from '../../shared/types.js'

export type { ExtractionRecordSummary, ExtractionRun } from '../../shared/types.js'

type ExtractionRecordOutcomeMetadata = Pick<
  ExtractionRecordSummary,
  'id' | 'outcome' | 'storedRecordId' | 'dedupSimilarity' | 'storeError'
>

class ExtractionRunLog extends RunLog<ExtractionRun> {
  protected coerce(data: unknown, runId: string): ExtractionRun | null {
    return coerceExtractionRun(data, runId)
  }
}

const extractionLog = new ExtractionRunLog('extractions', 'extractionLogRetentionDays')

export function saveExtractionRun(run: ExtractionRun, collection?: string): void {
  extractionLog.save(run, collection)
}

export function listExtractionRuns(collection?: string): ExtractionRun[] {
  return extractionLog.list(collection)
}

export function getExtractionRun(runId: string, collection?: string): ExtractionRun | null {
  return extractionLog.get(runId, collection)
}

export function deleteExtractionRun(runId: string, collection?: string): boolean {
  return extractionLog.delete(runId, collection)
}

export function buildExtractionRecordSummaries(
  records: MemoryRecord[],
  outcomes: ExtractionRecordOutcomeMetadata[] = []
): ExtractionRecordSummary[] {
  const outcomesById = new Map(outcomes.map(outcome => [outcome.id, outcome]))
  return records
    .map(record => buildExtractionRecordSummary(record, outcomesById.get(record.id)))
    .filter((record): record is ExtractionRecordSummary => Boolean(record))
}

export function getLastExtractionRunForSession(sessionId: string, collection?: string): ExtractionRun | null {
  const runs = extractionLog.list(collection) // sorted by timestamp desc
  return runs.find(run =>
    run.sessionId === sessionId
    && run.extractedEventCount != null
    && !isTrueExtractionFailure(run.error, run.recordCount)
  ) ?? null
}

function buildExtractionRecordSummary(
  record: MemoryRecord,
  outcome: ExtractionRecordOutcomeMetadata | undefined
): ExtractionRecordSummary | null {
  const summary = getRecordSummary(record)
  if (!record.id || !summary) return null
  return {
    id: record.id,
    type: record.type,
    summary,
    timestamp: record.timestamp,
    ...(outcome?.outcome ? { outcome: outcome.outcome } : {}),
    ...(outcome?.storedRecordId ? { storedRecordId: outcome.storedRecordId } : {}),
    ...(typeof outcome?.dedupSimilarity === 'number' ? { dedupSimilarity: outcome.dedupSimilarity } : {}),
    ...(outcome?.storeError ? { storeError: outcome.storeError } : {})
  }
}

export interface InProgressExtraction {
  sessionId: string
  pid: number
  startedAt: number
  elapsedMs: number
}

const IN_PROGRESS_STALE_MS = 5 * 60 * 1000

export function listInProgressExtractions(): InProgressExtraction[] {
  const locksDir = LOCKS_DIR
  if (!fs.existsSync(locksDir)) return []

  const files = fs.readdirSync(locksDir)
  const now = Date.now()
  const inProgress: InProgressExtraction[] = []

  for (const file of files) {
    if (!file.endsWith('.lock') || file === 'auto-maintenance.lock') continue
    const lockPath = path.join(locksDir, file)
    try {
      const content = fs.readFileSync(lockPath, 'utf-8').trim()
      const lines = content.split('\n')
      const pid = parseInt(lines[0], 10)
      const startedAt = parseInt(lines[1], 10)
      if (!Number.isFinite(pid) || !Number.isFinite(startedAt)) continue
      if (now - startedAt > IN_PROGRESS_STALE_MS) continue
      const sessionId = file.replace(/\.lock$/, '')
      inProgress.push({ sessionId, pid, startedAt, elapsedMs: now - startedAt })
    } catch {
      continue
    }
  }

  return inProgress
}

function coerceExtractionRun(value: unknown, runId: string): ExtractionRun | null {
  if (!isPlainObject(value)) return null
  const record = value

  const sessionId = asString(record.sessionId) ?? 'unknown'
  const transcriptPath = asString(record.transcriptPath) ?? ''
  const timestamp = asInteger(record.timestamp) ?? Date.now()
  const extractedRecordIds = asStringArray(record.extractedRecordIds)
  const updatedRecordIds = asStringArray(record.updatedRecordIds)
  const recordCount = asInteger(record.recordCount) ?? new Set([...extractedRecordIds, ...updatedRecordIds]).size
  const parseErrorCount = asInteger(record.parseErrorCount) ?? 0
  const skippedRecordCount = asInteger(record.skippedRecordCount) ?? undefined
  const failedRecordCount = asInteger(record.failedRecordCount) ?? undefined
  const extractedRecords = coerceRecordSummaries(record.extractedRecords)
  const duration = asInteger(record.duration) ?? 0
  const firstPrompt = asTrimmedString(record.firstPrompt)
  const tokenUsage = coerceTokenUsage(record.tokenUsage)
  const extractedEventCount = asInteger(record.extractedEventCount) ?? undefined
  const isIncremental = record.isIncremental === true ? true : undefined
  const isReExtract = record.isReExtract === true ? true : undefined
  const hasRememberMarker = record.hasRememberMarker === true ? true : undefined
  const supersedesMissing = asInteger(record.supersedesMissing) ?? undefined
  const skipReason = record.skipReason === 'too_short' ? 'too_short' as const
    : record.skipReason === 'no_records' ? 'no_records' as const
    : undefined
  const error = coerceExtractionFailure(record.error)

  return {
    runId: asString(record.runId) ?? runId,
    sessionId,
    transcriptPath,
    timestamp,
    recordCount,
    parseErrorCount,
    skippedRecordCount,
    failedRecordCount,
    extractedRecordIds,
    updatedRecordIds: updatedRecordIds.length > 0 ? updatedRecordIds : undefined,
    extractedRecords,
    duration,
    firstPrompt,
    tokenUsage,
    extractedEventCount,
    isIncremental,
    isReExtract,
    hasRememberMarker,
    supersedesMissing,
    skipReason,
    error
  }
}

function coerceExtractionFailure(value: unknown): ExtractionFailure | undefined {
  if (!isPlainObject(value)) return undefined

  const kind = asString(value.kind)
  if (kind === 'api_error') {
    const message = asString(value.message)
    if (message === undefined) return undefined
    const status = asInteger(value.status)
    const code = asString(value.code)
    const requestId = asString(value.requestId)
    return {
      kind,
      ...(status !== null ? { status } : {}),
      ...(code !== undefined ? { code } : {}),
      ...(requestId !== undefined ? { requestId } : {}),
      message
    }
  }

  if (kind === 'parse_error') {
    const message = asString(value.message)
    return message === undefined ? undefined : { kind, message }
  }

  if (kind === 'no_auth') {
    const message = asString(value.message)
    return message === undefined ? undefined : { kind, message }
  }

  if (kind === 'max_tokens') {
    const maxTokens = asInteger(value.maxTokens)
    return maxTokens === null ? undefined : { kind, maxTokens }
  }

  return undefined
}

function coerceTokenUsage(value: unknown): TokenUsage | undefined {
  if (!isPlainObject(value)) return undefined

  return {
    inputTokens: asInteger(value.inputTokens) ?? 0,
    outputTokens: asInteger(value.outputTokens) ?? 0,
    cacheCreationInputTokens: asInteger(value.cacheCreationInputTokens) ?? 0,
    cacheReadInputTokens: asInteger(value.cacheReadInputTokens) ?? 0
  }
}

function coerceRecordSummaries(value: unknown): ExtractionRecordSummary[] | undefined {
  if (!Array.isArray(value)) return undefined
  const summaries = value
    .map(entry => coerceRecordSummary(entry))
    .filter((entry): entry is ExtractionRecordSummary => Boolean(entry))
  return summaries.length > 0 ? summaries : undefined
}

function coerceRecordSummary(value: unknown): ExtractionRecordSummary | null {
  if (!isPlainObject(value)) return null
  const record = value

  const id = asString(record.id)
  const type = asRecordType(record.type)
  const timestamp = asInteger(record.timestamp) ?? undefined
  const outcome = coerceExtractionRecordOutcome(record.outcome)
  const storedRecordId = asString(record.storedRecordId)
  const dedupSimilarity = coerceSimilarity(record.dedupSimilarity)
  const storeError = asTrimmedString(record.storeError)
  const summary = asTrimmedString(record.summary)
    ?? asTrimmedString(record.snippet)
    ?? deriveSummaryFromRecord(type, record)

  if (!id || !type || !summary) return null

  return {
    id,
    type,
    summary,
    timestamp,
    outcome,
    storedRecordId,
    dedupSimilarity,
    storeError
  }
}

function coerceExtractionRecordOutcome(value: unknown): ExtractionRecordOutcome | undefined {
  return value === 'inserted' || value === 'updated' || value === 'skipped' || value === 'failed'
    ? value
    : undefined
}

function coerceSimilarity(value: unknown): number | undefined {
  const parsed = asNumber(value)
  return parsed === null ? undefined : Number(parsed.toFixed(3))
}

function deriveSummaryFromRecord(type: RecordType | undefined, record: Record<string, unknown>): string | undefined {
  if (!type) return undefined
  return getRecordSummary({
    type,
    command: asTrimmedString(record.command),
    errorText: asTrimmedString(record.errorText),
    what: asTrimmedString(record.what),
    name: asTrimmedString(record.name),
    avoid: asTrimmedString(record.avoid),
    useInstead: asTrimmedString(record.useInstead)
  }, { useInsteadFallback: true })
}
