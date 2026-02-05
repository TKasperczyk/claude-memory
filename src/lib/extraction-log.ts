import fs from 'fs'
import path from 'path'
import { homedir } from 'os'
import { asInteger, asRecordType, asString, asStringArray, asTrimmedString, isPlainObject } from './parsing.js'
import { readJsonFileSafe, writeJsonFile } from './json.js'
import { sanitizeRunId } from './shared.js'
import { getRecordSummary } from './record-summary.js'
import { getCollectionKey } from './retrieval-events.js'
import { isDefaultCollection } from './storage-paths.js'
import { loadSettings } from './settings.js'
import type { ExtractionRecordSummary, ExtractionRun, RecordType } from '../../shared/types.js'

export type { ExtractionRecordSummary, ExtractionRun } from '../../shared/types.js'

const EXTRACTIONS_ROOT = path.join(homedir(), '.claude-memory', 'extractions')

function getExtractionsDir(collection?: string): string {
  return path.join(EXTRACTIONS_ROOT, getCollectionKey(collection))
}

function getLegacyExtractionRunPath(runId: string): string {
  const safeId = sanitizeRunId(runId)
  return path.join(EXTRACTIONS_ROOT, `${safeId}.json`)
}

function getExtractionRunPath(runId: string, collection?: string): string {
  const safeId = sanitizeRunId(runId)
  return path.join(getExtractionsDir(collection), `${safeId}.json`)
}

function cleanupDir(dir: string, cutoff: number): void {
  if (!fs.existsSync(dir)) return

  const files = fs.readdirSync(dir).filter(file => file.endsWith('.json'))
  for (const file of files) {
    const filePath = path.join(dir, file)
    try {
      const stats = fs.statSync(filePath)
      if (stats.mtimeMs < cutoff) {
        fs.unlinkSync(filePath)
      }
    } catch {
      // ignore
    }
  }
}

function cleanupOldExtractionLogs(collection?: string): void {
  const settings = loadSettings()
  const daysToKeep = settings.extractionLogRetentionDays
  const cutoff = Date.now() - Math.max(daysToKeep, 1) * 24 * 60 * 60 * 1000

  try {
    cleanupDir(getExtractionsDir(collection), cutoff)
    if (isDefaultCollection(collection)) {
      cleanupDir(EXTRACTIONS_ROOT, cutoff)
    }
  } catch (error) {
    console.error('[claude-memory] Failed to clean up extraction logs:', error)
  }
}

function readExtractionRun(filePath: string, runId: string): ExtractionRun | null {
  return readJsonFileSafe(filePath, {
    errorMessage: '[claude-memory] Failed to read extraction run log:',
    coerce: data => coerceExtractionRun(data, runId)
  })
}

function listRunIds(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  try {
    return fs.readdirSync(dir)
      .filter(file => file.endsWith('.json'))
      .map(file => file.replace(/\.json$/, ''))
  } catch (error) {
    console.error('[claude-memory] Failed to list extraction runs:', error)
    return []
  }
}

export function saveExtractionRun(run: ExtractionRun, collection?: string): void {
  try {
    // Cleanup happens on save to avoid extra I/O when no extractions run.
    cleanupOldExtractionLogs(collection)
    const filePath = getExtractionRunPath(run.runId, collection)
    writeJsonFile(filePath, run, { ensureDir: true, pretty: 2 })
  } catch (error) {
    console.error('[claude-memory] Failed to write extraction run log:', error)
  }
}

export function listExtractionRuns(collection?: string): ExtractionRun[] {
  try {
    const ids = new Set<string>(listRunIds(getExtractionsDir(collection)))
    if (isDefaultCollection(collection)) {
      for (const runId of listRunIds(EXTRACTIONS_ROOT)) {
        ids.add(runId)
      }
    }
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
  const primaryPath = getExtractionRunPath(runId, collection)
  const primary = readExtractionRun(primaryPath, runId)
  if (primary) return primary

  if (isDefaultCollection(collection)) {
    return readExtractionRun(getLegacyExtractionRunPath(runId), runId)
  }

  return null
}

export function deleteExtractionRun(runId: string, collection?: string): boolean {
  let deleted = false
  const paths = [getExtractionRunPath(runId, collection)]
  if (isDefaultCollection(collection)) {
    paths.push(getLegacyExtractionRunPath(runId))
  }
  try {
    for (const filePath of paths) {
      if (!fs.existsSync(filePath)) continue
      fs.unlinkSync(filePath)
      deleted = true
    }
    return deleted
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
