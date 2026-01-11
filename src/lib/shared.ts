import fs from 'fs'
import { type MemoryRecord } from './types.js'

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

export function buildRecordSnippet(record: {
  type: string
  command?: string
  errorText?: string
  what?: string
  name?: string
  avoid?: string
}): string {
  switch (record.type) {
    case 'command':
      return record.command ?? 'unknown command'
    case 'error':
      return record.errorText ?? 'unknown error'
    case 'discovery':
      return record.what ?? 'unknown discovery'
    case 'procedure':
      return record.name ?? 'unknown procedure'
    case 'warning':
      return record.avoid ?? 'unknown warning'
    default:
      return `${record.type} record`
  }
}

export function truncateSnippet(value: string, maxLength: number = 120): string {
  const cleaned = value.replace(/\s+/g, ' ').trim()
  if (cleaned.length <= maxLength) return cleaned
  return `${cleaned.slice(0, maxLength - 3)}...`
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
