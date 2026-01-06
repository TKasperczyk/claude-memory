import fs from 'fs'
import path from 'path'
import { homedir } from 'os'
import { type MemoryRecord } from './types.js'

export interface ExtractionRun {
  runId: string
  sessionId: string
  transcriptPath: string
  timestamp: number
  recordCount: number
  parseErrorCount: number
  extractedRecordIds: string[]
  extractedRecords?: MemoryRecord[]
  duration: number
}

const EXTRACTIONS_DIR = path.join(homedir(), '.claude-memory', 'extractions')
const DEFAULT_DAYS_TO_KEEP = 1

export function getExtractionRunPath(runId: string): string {
  const safeId = sanitizeRunId(runId)
  return path.join(EXTRACTIONS_DIR, `${safeId}.json`)
}

export function cleanupOldExtractionLogs(daysToKeep: number = DEFAULT_DAYS_TO_KEEP): void {
  if (!fs.existsSync(EXTRACTIONS_DIR)) return

  const cutoff = Date.now() - Math.max(daysToKeep, 0) * 24 * 60 * 60 * 1000

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
    fs.mkdirSync(EXTRACTIONS_DIR, { recursive: true })
    // Cleanup happens on save to avoid extra I/O when no extractions run.
    cleanupOldExtractionLogs()
    const filePath = getExtractionRunPath(run.runId)
    fs.writeFileSync(filePath, JSON.stringify(run, null, 2))
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
  if (!fs.existsSync(filePath)) return null

  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    return coerceExtractionRun(parsed, runId)
  } catch (error) {
    console.error('[claude-memory] Failed to read extraction run log:', error)
    return null
  }
}

function sanitizeRunId(runId: string): string {
  return runId.replace(/[\\/]/g, '_')
}

function coerceExtractionRun(value: unknown, runId: string): ExtractionRun | null {
  if (!isPlainObject(value)) return null
  const record = value as Record<string, unknown>

  const sessionId = asString(record.sessionId) ?? 'unknown'
  const transcriptPath = asString(record.transcriptPath) ?? ''
  const timestamp = asNumber(record.timestamp) ?? Date.now()
  const recordCount = asNumber(record.recordCount) ?? 0
  const parseErrorCount = asNumber(record.parseErrorCount) ?? 0
  const extractedRecordIds = asStringArray(record.extractedRecordIds)
  const extractedRecords = asRecordArray(record.extractedRecords)
  const duration = asNumber(record.duration) ?? 0

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

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return Math.trunc(parsed)
  }
  return null
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

function asRecordArray(value: unknown): MemoryRecord[] | undefined {
  if (!Array.isArray(value)) return undefined
  const records = value.filter((entry): entry is Record<string, unknown> => isPlainObject(entry))
  return records as unknown as MemoryRecord[]
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
