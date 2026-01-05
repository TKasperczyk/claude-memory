import type { MemoryRecord } from '@/lib/api'

interface MemoryTableProps {
  records: MemoryRecord[]
  onSelect: (record: MemoryRecord) => void
  emptyMessage?: string
}

const TYPE_COLORS: Record<string, string> = {
  command: '#2dd4bf',
  error: '#f43f5e',
  discovery: '#60a5fa',
  procedure: '#a78bfa',
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

function getSummary(record: MemoryRecord): string {
  switch (record.type) {
    case 'command': return record.command
    case 'error': return record.errorText
    case 'discovery': return record.what
    case 'procedure': return record.name
  }
}

function formatRelativeTime(timestamp?: number): string {
  if (!timestamp) return '—'
  const diff = Date.now() - timestamp
  const mins = Math.floor(diff / 60000)
  const hours = Math.floor(mins / 60)
  const days = Math.floor(hours / 24)

  if (days > 0) return `${days}d`
  if (hours > 0) return `${hours}h`
  if (mins > 0) return `${mins}m`
  return 'now'
}

export default function MemoryTable({ records, onSelect, emptyMessage }: MemoryTableProps) {
  if (records.length === 0) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        {emptyMessage ?? 'No memories found'}
      </div>
    )
  }

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-card">
            <th className="text-left font-medium text-muted-foreground px-4 py-3 w-8"></th>
            <th className="text-left font-medium text-muted-foreground px-4 py-3">Summary</th>
            <th className="text-left font-medium text-muted-foreground px-4 py-3 w-32">Project</th>
            <th className="text-left font-medium text-muted-foreground px-4 py-3 w-32">Domain</th>
            <th className="text-right font-medium text-muted-foreground px-4 py-3 w-20">Retr.</th>
            <th className="text-right font-medium text-muted-foreground px-4 py-3 w-20">Usage</th>
            <th className="text-right font-medium text-muted-foreground px-4 py-3 w-16">Age</th>
          </tr>
        </thead>
        <tbody>
          {records.map(record => {
            const summary = truncate(getSummary(record), 80)
            return (
              <tr
                key={record.id}
                onClick={() => onSelect(record)}
                className={`border-b border-border last:border-0 cursor-pointer transition-base hover:bg-secondary/50 ${
                  record.deprecated ? 'opacity-50' : ''
                }`}
              >
                <td className="px-4 py-3">
                  <span
                    className="block w-2 h-2 rounded-full"
                    style={{ backgroundColor: TYPE_COLORS[record.type] }}
                    title={record.type}
                  />
                </td>
                <td className="px-4 py-3">
                  <div className="font-medium truncate">{summary}</div>
                </td>
                <td className="px-4 py-3 text-muted-foreground truncate">
                  {record.project ?? '—'}
                </td>
                <td className="px-4 py-3 text-muted-foreground truncate">
                  {record.domain ?? '—'}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                  {record.retrievalCount ?? 0}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                  {record.usageCount ?? 0}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                  {formatRelativeTime(record.lastUsed ?? record.timestamp)}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
