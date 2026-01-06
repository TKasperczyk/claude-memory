import type { MemoryRecord } from '@/lib/api'

export const TYPE_COLORS: Record<MemoryRecord['type'], string> = {
  command: '#2dd4bf',
  error: '#f43f5e',
  discovery: '#60a5fa',
  procedure: '#a78bfa'
}

export function getMemorySummary(record: MemoryRecord): string {
  switch (record.type) {
    case 'command':
      return record.command
    case 'error':
      return record.errorText
    case 'discovery':
      return record.what
    case 'procedure':
      return record.name
  }
}

export function getMemoryTitle(record: MemoryRecord): string {
  return getMemorySummary(record)
}
