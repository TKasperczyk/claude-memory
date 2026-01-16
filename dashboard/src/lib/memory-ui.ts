import type { MemoryRecord } from '@/lib/api'
import { getRecordSummary } from '../../../src/lib/record-summary.js'

export const TYPE_COLORS: Record<MemoryRecord['type'], string> = {
  command: '#2dd4bf',
  error: '#f43f5e',
  discovery: '#60a5fa',
  procedure: '#a78bfa',
  warning: '#fbbf24'
}

export function getMemorySummary(record: MemoryRecord): string {
  return getRecordSummary(record)
}

export function getMemoryTitle(record: MemoryRecord): string {
  return getMemorySummary(record)
}
