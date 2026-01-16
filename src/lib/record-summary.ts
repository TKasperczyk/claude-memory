import type { MemoryRecord, RecordType } from '../../shared/types.js'

export type RecordSummarySource = {
  type: RecordType
  command?: string
  errorText?: string
  what?: string
  name?: string
  avoid?: string
  useInstead?: string
}

export type RecordSummaryOptions = {
  useInsteadFallback?: boolean
}

export function getRecordSummary(record: MemoryRecord): string
export function getRecordSummary(
  record: RecordSummarySource,
  options?: RecordSummaryOptions
): string | undefined
export function getRecordSummary(
  record: RecordSummarySource,
  options: RecordSummaryOptions = {}
): string | undefined {
  switch (record.type) {
    case 'command':
      return record.command
    case 'error':
      return record.errorText
    case 'discovery':
      return record.what
    case 'procedure':
      return record.name
    case 'warning':
      if (record.avoid !== undefined) return record.avoid
      if (options.useInsteadFallback) return record.useInstead
      return undefined
  }
}
