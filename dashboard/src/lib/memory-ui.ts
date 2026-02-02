import type { MemoryRecord } from '@/lib/api'
import { getRecordSummary } from '../../../src/lib/record-summary.js'

export const TYPE_COLORS: Record<MemoryRecord['type'], string> = {
  command: 'hsl(var(--type-command))',
  error: 'hsl(var(--type-error))',
  discovery: 'hsl(var(--type-discovery))',
  procedure: 'hsl(var(--type-procedure))',
  warning: 'hsl(var(--type-warning))'
}

export function getMemorySummary(record: MemoryRecord): string {
  return getRecordSummary(record)
}

export function getMemoryTitle(record: MemoryRecord): string {
  return getMemorySummary(record)
}
