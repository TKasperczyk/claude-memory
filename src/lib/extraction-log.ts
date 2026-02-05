import { asInteger, asRecordType, asString, asStringArray, asTrimmedString, isPlainObject } from './parsing.js'
import { JsonStore, isDefaultCollection } from './file-store.js'
import { getRecordSummary } from './record-summary.js'
import { loadSettings } from './settings.js'
import type { ExtractionRecordSummary, ExtractionRun, RecordType } from '../../shared/types.js'

export type { ExtractionRecordSummary, ExtractionRun } from '../../shared/types.js'

const extractionStore = new JsonStore('extractions')

function cleanupOldExtractionLogs(collection?: string): void {
  const settings = loadSettings()
  const daysToKeep = settings.extractionLogRetentionDays
  const cutoff = Date.now() - Math.max(daysToKeep, 1) * 24 * 60 * 60 * 1000

  try {
    extractionStore.cleanupByAge({
      collection,
      cutoffMs: cutoff,
      includeLegacyForDefault: isDefaultCollection(collection)
    })
  } catch (error) {
    console.error('[claude-memory] Failed to clean up extraction logs:', error)
  }
}

function readExtractionRun(runId: string, collection?: string): ExtractionRun | null {
  return extractionStore.read(runId, {
    collection,
    includeLegacyForDefault: isDefaultCollection(collection),
    errorMessage: '[claude-memory] Failed to read extraction run log:',
    coerce: data => coerceExtractionRun(data, runId),
    fallback: null
  })
}

export function saveExtractionRun(run: ExtractionRun, collection?: string): void {
  try {
    // Cleanup happens on save to avoid extra I/O when no extractions run.
    cleanupOldExtractionLogs(collection)
    extractionStore.write(run.runId, run, {
      collection,
      ensureDir: true,
      pretty: 2
    })
  } catch (error) {
    console.error('[claude-memory] Failed to write extraction run log:', error)
  }
}

export function listExtractionRuns(collection?: string): ExtractionRun[] {
  try {
    const ids = extractionStore.list({
      collection,
      includeLegacyForDefault: isDefaultCollection(collection)
    })
    const runs: ExtractionRun[] = []

    for (const runId of ids) {
      const record = getExtractionRun(runId, collection)
      if (record) runs.push(record)
    }

    runs.sort((a, b) => b.timestamp - a.timestamp)
    return runs
  } catch (error) {
    console.error('[claude-memory] Failed to list extraction runs:', error)
    return []
  }
}

export function getExtractionRun(runId: string, collection?: string): ExtractionRun | null {
  return readExtractionRun(runId, collection)
}

export function deleteExtractionRun(runId: string, collection?: string): boolean {
  try {
    return extractionStore.delete(runId, {
      collection,
      includeLegacyForDefault: isDefaultCollection(collection)
    })
  } catch (error) {
    console.error('[claude-memory] Failed to delete extraction run log:', error)
    throw error
  }
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
    firstPrompt
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
