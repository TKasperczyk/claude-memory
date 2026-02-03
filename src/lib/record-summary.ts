import type { MemoryRecord, RecordType } from '../../shared/types.js'
import { getRecordSummaryText, type RecordSummaryOptions } from './record-fields.js'

export type RecordSummarySource = {
  type: RecordType
  command?: string
  errorText?: string
  what?: string
  name?: string
  avoid?: string
  useInstead?: string
}

export type { RecordSummaryOptions }

export function getRecordSummary(record: MemoryRecord): string
export function getRecordSummary(
  record: RecordSummarySource,
  options?: RecordSummaryOptions
): string | undefined
export function getRecordSummary(
  record: RecordSummarySource,
  options: RecordSummaryOptions = {}
): string | undefined {
  return getRecordSummaryText(record, options)
}
