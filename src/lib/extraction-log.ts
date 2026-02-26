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
    tokenUsage
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
