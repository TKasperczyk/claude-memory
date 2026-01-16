import fs from 'fs'
import { getRecordSummary, type RecordSummarySource } from './record-summary.js'
import { type MemoryRecord, type RecordType } from './types.js'

/**
 * Check if a string looks like a command line.
 * Uses heuristics rather than a hardcoded list to support any command.
 */
export function looksLikeCommand(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed) return false

  // Path-based executables
  if (trimmed.startsWith('./') || trimmed.startsWith('/') || trimmed.startsWith('~/')) {
    return true
  }

  const first = trimmed.split(/\s+/)[0]
  if (!first) return false

  // Valid command names: alphanumeric with dashes/underscores, no special chars
  // This matches: npm, runpodctl, docker-compose, python3, etc.
  if (/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(first)) {
    return true
  }

  return false
}

export function normalizeStep(step: string): string {
  return step
    .replace(/^\s*[-*]\s+/, '')
    .replace(/^\s*\d+\.\s+/, '')
    .replace(/^\s*\d+\)\s+/, '')
    .replace(/^\s*[$>#]\s+/, '')
    .trim()
}

export function buildExactText(record: MemoryRecord): string {
  switch (record.type) {
    case 'command':
      return record.command
    case 'error':
      return record.errorText
    case 'discovery':
      return [record.what, record.where].filter(Boolean).join('\n')
    case 'procedure':
      return [record.name, ...record.steps].filter(Boolean).join('\n')
    case 'warning':
      return [record.avoid, record.useInstead, record.reason].filter(Boolean).join('\n')
  }
}

export function normalizeExactText(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
}

export function readFileIfExists(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8')
  } catch {
    return null
  }
}

export function sanitizeRunId(runId: string): string {
  return runId.replace(/[\\/]/g, '_')
}

export function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[\\/]/g, '_')
}

export function escapeFilterValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

const UNKNOWN_RECORD_SUMMARY: Record<RecordType, string> = {
  command: 'unknown command',
  error: 'unknown error',
  discovery: 'unknown discovery',
  procedure: 'unknown procedure',
  warning: 'unknown warning'
}

export function buildRecordSnippet(record: {
  type: string
  command?: string
  errorText?: string
  what?: string
  name?: string
  avoid?: string
  useInstead?: string
}): string {
  const summary = getRecordSummary(record as RecordSummarySource)
  if (summary !== undefined) return summary
  const fallback = UNKNOWN_RECORD_SUMMARY[record.type as RecordType]
  if (fallback) return fallback
  return `${record.type} record`
}

export function truncateSnippet(value: string, maxLength: number = 120): string {
  const cleaned = value.replace(/\s+/g, ' ').trim()
  if (cleaned.length <= maxLength) return cleaned
  return `${cleaned.slice(0, maxLength - 3)}...`
}

export function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return value.slice(0, maxLength - 3) + '...'
}

export function truncateTextWithMarker(
  value: string | undefined,
  maxLength: number,
  options: { tailLength?: number; marker?: string } = {}
): string {
  if (!value) return ''
  if (value.length <= maxLength) return value
  const tailLength = options.tailLength ?? 500
  const marker = options.marker ?? '\n...[truncated]...\n'
  const head = value.slice(0, Math.max(0, maxLength - tailLength))
  const tail = value.slice(-tailLength)
  return `${head}${marker}${tail}`
}

export function buildCandidateRecord(
  record: MemoryRecord,
  reason: string,
  details?: Record<string, number | string | boolean>
) {
  const candidate = {
    id: record.id,
    type: record.type,
    snippet: truncateSnippet(buildRecordSnippet(record)),
    reason
  }
  if (details) {
    return { ...candidate, details }
  }
  return candidate
}

export function truncateWithTail(value: string, maxLength: number, tailLength: number = 300): string {
  if (value.length <= maxLength) return value
  if (maxLength <= 3) return value.slice(0, maxLength)
  const head = value.slice(0, Math.max(0, maxLength - tailLength))
  const tail = value.slice(-tailLength)
  return `${head}\n...\n${tail}`
}

export type TimeoutResult<T> =
  | { completed: true; timedOut: false; value: T }
  | { completed: false; timedOut: boolean }

export async function withTimeout<T>(
  task: (signal: AbortSignal) => Promise<T>,
  options: { timeoutMs?: number; signal?: AbortSignal; onTimeout?: () => void } = {}
): Promise<TimeoutResult<T>> {
  const { timeoutMs, signal: externalSignal, onTimeout } = options

  if (externalSignal?.aborted) {
    return { completed: false, timedOut: false }
  }

  const controller = new AbortController()
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  let timedOut = false

  const abort = (): void => {
    if (!controller.signal.aborted) {
      controller.abort()
    }
  }

  const onExternalAbort = (): void => {
    abort()
  }

  if (externalSignal) {
    externalSignal.addEventListener('abort', onExternalAbort, { once: true })
  }

  if (timeoutMs && timeoutMs > 0) {
    timeoutId = setTimeout(() => {
      timedOut = true
      abort()
      if (onTimeout) {
        try {
          onTimeout()
        } catch (error) {
          console.error('[claude-memory] Timeout cleanup failed:', error)
        }
      }
    }, timeoutMs)
  }

  let onAbort: (() => void) | null = null
  const abortPromise = new Promise<{ completed: false; timedOut: boolean }>(resolve => {
    if (controller.signal.aborted) {
      resolve({ completed: false, timedOut })
      return
    }
    onAbort = () => resolve({ completed: false, timedOut })
    controller.signal.addEventListener('abort', onAbort, { once: true })
  })

  const taskPromise = task(controller.signal)
    .then(value => ({ completed: true as const, timedOut: false as const, value }))
    .catch(error => {
      if (controller.signal.aborted) {
        return { completed: false as const, timedOut }
      }
      throw error
    })

  try {
    return await Promise.race([taskPromise, abortPromise])
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort)
    if (onAbort) controller.signal.removeEventListener('abort', onAbort)
  }
}
