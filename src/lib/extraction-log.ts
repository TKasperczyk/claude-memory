import fs from 'fs'
import path from 'path'
import { homedir } from 'os'
import { asInteger, asRecordType, asString, asStringArray, asTrimmedString, isPlainObject } from './parsing.js'
import { readJsonFileSafe, writeJsonFile } from './json.js'
import { sanitizeRunId } from './shared.js'
import { getRecordSummary } from './record-summary.js'
import { loadSettings } from './settings.js'
import type { ExtractionRecordSummary, ExtractionRun, RecordType } from '../../shared/types.js'

export type { ExtractionRecordSummary, ExtractionRun } from '../../shared/types.js'

const EXTRACTIONS_DIR = path.join(homedir(), '.claude-memory', 'extractions')

function getExtractionRunPath(runId: string): string {
  const safeId = sanitizeRunId(runId)
  return path.join(EXTRACTIONS_DIR, `${safeId}.json`)
}

function cleanupOldExtractionLogs(): void {
  if (!fs.existsSync(EXTRACTIONS_DIR)) return

  const settings = loadSettings()
  const daysToKeep = settings.extractionLogRetentionDays
  const cutoff = Date.now() - Math.max(daysToKeep, 1) * 24 * 60 * 60 * 1000

  try {
    const files = fs.readdirSync(EXTRACTIONS_DIR).filter(file => file.endsWith('.json'))
    for (const file of files) {
      const filePath = path.join(EXTRACTIONS_DIR, file)
      try {
        const stats = fs.statSync(filePath)
        if (stats.mtimeMs < cutoff) {
          fs.unlinkSync(filePath)
        }
      } catch {
        // ignore
      }
    }
  } catch (error) {
    console.error('[claude-memory] Failed to clean up extraction logs:', error)
  }
}

export function saveExtractionRun(run: ExtractionRun): void {
  try {
    // Cleanup happens on save to avoid extra I/O when no extractions run.
    cleanupOldExtractionLogs()
    const filePath = getExtractionRunPath(run.runId)
    writeJsonFile(filePath, run, { ensureDir: true, pretty: 2 })
  } catch (error) {
    console.error('[claude-memory] Failed to write extraction run log:', error)
  }
}

export function listExtractionRuns(): ExtractionRun[] {
  if (!fs.existsSync(EXTRACTIONS_DIR)) return []

  try {
    const files = fs.readdirSync(EXTRACTIONS_DIR).filter(file => file.endsWith('.json'))
    const runs: ExtractionRun[] = []

    for (const file of files) {
      const runId = file.replace(/\.json$/, '')
      const record = getExtractionRun(runId)
      if (record) runs.push(record)
    }

    runs.sort((a, b) => b.timestamp - a.timestamp)
    return runs
  } catch (error) {
    console.error('[claude-memory] Failed to list extraction runs:', error)
    return []
  }
}

export function getExtractionRun(runId: string): ExtractionRun | null {
  const filePath = getExtractionRunPath(runId)
  return readJsonFileSafe(filePath, {
    errorMessage: '[claude-memory] Failed to read extraction run log:',
    coerce: data => coerceExtractionRun(data, runId)
  })
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
  const extractedRecords = coerceRecordSummaries(record.extractedRecords)
  const duration = asInteger(record.duration) ?? 0

  return {
    runId: asString(record.runId) ?? runId,
    sessionId,
    transcriptPath,
    timestamp,
    recordCount,
    parseErrorCount,
    extractedRecordIds,
    extractedRecords,
    duration
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
