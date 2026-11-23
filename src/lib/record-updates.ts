import path from 'path'
import { canonicalizePath } from './paths.js'
import {
  asBoolean,
  asConfidence,
  asNumber,
  asOutcome,
  asScope,
  asSeverity,
  asStringArray,
  asTrimmedString,
  isPlainObject
} from './parsing.js'
import type { MemoryRecord } from './types.js'

export interface SanitizeRecordUpdatesOptions {
  allowDeprecated?: boolean
  allowContextStringForCommandIntent?: boolean
}

export interface SanitizeRecordUpdatesResult {
  updates: Partial<MemoryRecord>
  rejectedFields: string[]
}

const CONTEXT_ALLOWED_KEYS = {
  command: ['project', 'cwd', 'intent'],
  error: ['project', 'file', 'tool'],
  procedure: ['project']
} as const

function sanitizeContextObject(
  candidate: unknown,
  allowedKeys: readonly string[]
): Record<string, string> | null {
  if (!isPlainObject(candidate)) return null
  const result: Record<string, string> = {}
  for (const key of allowedKeys) {
    const parsed = asTrimmedString(candidate[key])
    if (parsed !== undefined) {
      result[key] = (key === 'project' || key === 'cwd') && path.isAbsolute(parsed)
        ? canonicalizePath(parsed)
        : parsed
    }
  }
  return Object.keys(result).length > 0 ? result : null
}

/**
 * Validate and sanitize partial updates against a record's concrete type.
 * Rejects fields belonging to other record types, protected metadata fields,
 * and malformed context objects (preventing string-spread corruption).
 */
export function sanitizeRecordUpdates(
  existing: MemoryRecord,
  rawFields: Record<string, unknown>,
  options: SanitizeRecordUpdatesOptions = {}
): SanitizeRecordUpdatesResult {
  const updates: Record<string, unknown> = {}
  const rejectedFields: string[] = []

  for (const [key, rawValue] of Object.entries(rawFields)) {
    if (rawValue === undefined) continue
    if (typeof rawValue === 'string' && rawValue.trim() === '') continue

    if (key === 'scope') {
      const scope = asScope(rawValue)
      if (scope) {
        updates.scope = scope
      } else {
        rejectedFields.push(key)
      }
      continue
    }

    if (key === 'deprecated') {
      if (options.allowDeprecated) {
        const deprecated = asBoolean(rawValue)
        if (deprecated !== undefined) {
          updates.deprecated = deprecated
          continue
        }
      }
      rejectedFields.push(key)
      continue
    }

    switch (existing.type) {
      case 'command': {
        if (key === 'command' || key === 'resolution' || key === 'truncatedOutput') {
          const parsed = asTrimmedString(rawValue)
          if (parsed) updates[key] = parsed
          else rejectedFields.push(key)
          continue
        }
        if (key === 'exitCode') {
          const parsed = asNumber(rawValue)
          if (parsed !== null) updates.exitCode = Math.trunc(parsed)
          else rejectedFields.push(key)
          continue
        }
        if (key === 'outcome') {
          const parsed = asOutcome(rawValue)
          if (parsed) updates.outcome = parsed
          else rejectedFields.push(key)
          continue
        }
        if (key === 'context') {
          if (options.allowContextStringForCommandIntent && typeof rawValue === 'string') {
            const intent = asTrimmedString(rawValue)
            if (intent) {
              updates.context = { intent }
              continue
            }
          }
          const parsed = sanitizeContextObject(rawValue, CONTEXT_ALLOWED_KEYS.command)
          if (parsed) updates.context = parsed
          else rejectedFields.push(key)
          continue
        }
        rejectedFields.push(key)
        continue
      }

      case 'error': {
        if (key === 'errorText' || key === 'errorType' || key === 'cause' || key === 'resolution') {
          const parsed = asTrimmedString(rawValue)
          if (parsed) updates[key] = parsed
          else rejectedFields.push(key)
          continue
        }
        if (key === 'context') {
          const parsed = sanitizeContextObject(rawValue, CONTEXT_ALLOWED_KEYS.error)
          if (parsed) updates.context = parsed
          else rejectedFields.push(key)
          continue
        }
        rejectedFields.push(key)
        continue
      }

      case 'discovery': {
        if (key === 'what' || key === 'where' || key === 'evidence') {
          const parsed = asTrimmedString(rawValue)
          if (parsed) updates[key] = parsed
          else rejectedFields.push(key)
          continue
        }
        if (key === 'confidence') {
          const parsed = asConfidence(rawValue)
          if (parsed) updates.confidence = parsed
          else rejectedFields.push(key)
          continue
        }
        rejectedFields.push(key)
        continue
      }

      case 'procedure': {
        if (key === 'name' || key === 'verification') {
          const parsed = asTrimmedString(rawValue)
          if (parsed) updates[key] = parsed
          else rejectedFields.push(key)
          continue
        }
        if (key === 'steps') {
          const steps = asStringArray(rawValue, { trim: true, filterEmpty: true })
          if (steps.length > 0) updates.steps = steps
          else rejectedFields.push(key)
          continue
        }
        if (key === 'prerequisites') {
          if (Array.isArray(rawValue)) {
            updates.prerequisites = asStringArray(rawValue, { trim: true, filterEmpty: true })
          } else {
            rejectedFields.push(key)
          }
          continue
        }
        if (key === 'context') {
          const parsed = sanitizeContextObject(rawValue, CONTEXT_ALLOWED_KEYS.procedure)
          if (parsed) updates.context = parsed
          else rejectedFields.push(key)
          continue
        }
        rejectedFields.push(key)
        continue
      }

      case 'warning': {
        if (key === 'avoid' || key === 'useInstead' || key === 'reason') {
          const parsed = asTrimmedString(rawValue)
          if (parsed) updates[key] = parsed
          else rejectedFields.push(key)
          continue
        }
        if (key === 'severity') {
          const parsed = asSeverity(rawValue)
          if (parsed) updates.severity = parsed
          else rejectedFields.push(key)
          continue
        }
        rejectedFields.push(key)
        continue
      }
    }
  }

  return {
    updates: updates as Partial<MemoryRecord>,
    rejectedFields
  }
}
