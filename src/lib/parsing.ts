import { type InjectionStatus, type RecordType } from './types.js'

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

export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

export function asRecordType(value: unknown): RecordType | undefined {
  if (value === 'command' || value === 'error' || value === 'discovery' || value === 'procedure') {
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
