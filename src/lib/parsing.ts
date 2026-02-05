import {
  type CommandRecord,
  type DiscoveryRecord,
  type InjectionStatus,
  type RecordScope,
  type RecordType,
  type WarningSeverity
} from './types.js'

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: unknown }

export function isToolUseBlock(value: unknown): value is ToolUseBlock {
  return (
    isPlainObject(value)
    && value.type === 'tool_use'
    && typeof value.id === 'string'
    && typeof value.name === 'string'
    && 'input' in value
  )
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function asTrimmedString(value: unknown): string | undefined {
  const raw = asString(value)
  const trimmed = raw?.trim()
  return trimmed ? trimmed : undefined
}

export function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

export function asInteger(value: unknown): number | null {
  const parsed = asNumber(value)
  return parsed === null ? null : Math.trunc(parsed)
}

export function asBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  return null
}

export type StringArrayOptions = {
  trim?: boolean
  filterEmpty?: boolean
  unique?: boolean
}

export function asStringArray(value: unknown, options: StringArrayOptions = {}): string[] {
  if (!Array.isArray(value)) return []
  const { trim = false, filterEmpty = false, unique = false } = options
  let entries = value.filter((entry): entry is string => typeof entry === 'string')

  if (trim) {
    entries = entries.map(entry => entry.trim())
  }

  if (filterEmpty) {
    entries = entries.filter(entry => entry.length > 0)
  }

  if (unique) {
    const seen = new Set<string>()
    entries = entries.filter(entry => {
      if (seen.has(entry)) return false
      seen.add(entry)
      return true
    })
  }

  return entries
}

export function asRecordType(value: unknown): RecordType | undefined {
  if (
    value === 'command'
    || value === 'error'
    || value === 'discovery'
    || value === 'procedure'
    || value === 'warning'
  ) {
    return value
  }
  return undefined
}

export function asInjectionStatus(value: unknown): InjectionStatus | undefined {
  if (
    value === 'injected'
    || value === 'no_matches'
    || value === 'empty_prompt'
    || value === 'timeout'
    || value === 'error'
  ) {
    return value
  }
  return undefined
}

export function isValidOutcome(value: unknown): value is CommandRecord['outcome'] {
  return value === 'success' || value === 'failure' || value === 'partial'
}

export function asOutcome(value: unknown): CommandRecord['outcome'] | undefined {
  return isValidOutcome(value) ? value : undefined
}

export function isValidConfidence(value: unknown): value is DiscoveryRecord['confidence'] {
  return value === 'verified' || value === 'inferred' || value === 'tentative'
}

export function asConfidence(value: unknown): DiscoveryRecord['confidence'] | undefined {
  return isValidConfidence(value) ? value : undefined
}

export function isValidSeverity(value: unknown): value is WarningSeverity {
  return value === 'caution' || value === 'warning' || value === 'critical'
}

export function asSeverity(value: unknown): WarningSeverity | undefined {
  return isValidSeverity(value) ? value : undefined
}

export function isValidScope(value: unknown): value is RecordScope {
  return value === 'global' || value === 'project'
}

export function asScope(value: unknown): RecordScope | undefined {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'global' || normalized === 'project') {
      return normalized as RecordScope
    }
  }
  if (isValidScope(value)) return value
  return undefined
}

export function normalizeScope(value: unknown, fallback: RecordScope = 'project'): RecordScope {
  return asScope(value) ?? fallback
}
