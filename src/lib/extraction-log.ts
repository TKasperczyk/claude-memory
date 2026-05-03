import fs from 'fs'
import path from 'path'
import { homedir } from 'os'
import { asInteger, asRecordType, asString, asStringArray, asTrimmedString, isPlainObject } from './parsing.js'
import { getRecordSummary } from './record-summary.js'
import { RunLog } from './run-log.js'
import type { ExtractionRecordSummary, ExtractionRun, RecordType, TokenUsage } from '../../shared/types.js'

export type { ExtractionRecordSummary, ExtractionRun } from '../../shared/types.js'

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

export function getLastExtractionRunForSession(sessionId: string, collection?: string): ExtractionRun | null {
  const runs = extractionLog.list(collection) // sorted by timestamp desc
  return runs.find(run => run.sessionId === sessionId && run.extractedEventCount != null) ?? null
}

export interface InProgressExtraction {
  sessionId: string
  pid: number
  startedAt: number
  elapsedMs: number
}

const IN_PROGRESS_STALE_MS = 5 * 60 * 1000

export function listInProgressExtractions(): InProgressExtraction[] {
  const locksDir = path.join(homedir(), '.claude-memory', 'locks')
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
  const recordCount = asInteger(record.recordCount) ?? 0
  const parseErrorCount = asInteger(record.parseErrorCount) ?? 0
  const extractedRecordIds = asStringArray(record.extractedRecordIds)
  const updatedRecordIds = asStringArray(record.updatedRecordIds)
  const extractedRecords = coerceRecordSummaries(record.extractedRecords)
  const duration = asInteger(record.duration) ?? 0
  const firstPrompt = asTrimmedString(record.firstPrompt)
  const tokenUsage = coerceTokenUsage(record.tokenUsage)
  const extractedEventCount = asInteger(record.extractedEventCount) ?? undefined
  const isIncremental = record.isIncremental === true ? true : undefined
  const hasRememberMarker = record.hasRememberMarker === true ? true : undefined
  const supersedesMissing = asInteger(record.supersedesMissing) ?? undefined
  const skipReason = record.skipReason === 'too_short' ? 'too_short' as const
    : record.skipReason === 'no_records' ? 'no_records' as const
    : undefined

  return {
    runId: asString(record.runId) ?? runId,
    sessionId,
    transcriptPath,
    timestamp,
    recordCount,
    parseErrorCount,
    extractedRecordIds,
    updatedRecordIds: updatedRecordIds.length > 0 ? updatedRecordIds : undefined,
    extractedRecords,
    duration,
    firstPrompt,
    tokenUsage,
    extractedEventCount,
    isIncremental,
    hasRememberMarker,
    supersedesMissing,
    skipReason
  }
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
  const summary = asTrimmedString(record.summary)
    ?? asTrimmedString(record.snippet)
    ?? deriveSummaryFromRecord(type, record)

  if (!id || !type || !summary) return null

  return {
    id,
    type,
    summary,
    timestamp
  }
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
