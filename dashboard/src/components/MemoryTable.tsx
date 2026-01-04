import TypeBadge from '@/components/TypeBadge'
import type { MemoryRecord } from '@/lib/api'

interface MemoryTableProps {
  records: MemoryRecord[]
  onSelect: (record: MemoryRecord) => void
  emptyMessage?: string
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength - 3)}...`
}

function getSummary(record: MemoryRecord): string {
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

function formatRelativeTime(timestamp?: number): string {
  if (!timestamp) return 'N/A'
  const diffSeconds = Math.round((timestamp - Date.now()) / 1000)
  const ranges: Array<{ unit: Intl.RelativeTimeFormatUnit; seconds: number }> = [
    { unit: 'year', seconds: 31536000 },
    { unit: 'month', seconds: 2592000 },
    { unit: 'day', seconds: 86400 },
    { unit: 'hour', seconds: 3600 },
    { unit: 'minute', seconds: 60 },
    { unit: 'second', seconds: 1 }
  ]

  for (const range of ranges) {
    if (Math.abs(diffSeconds) >= range.seconds) {
      const value = Math.round(diffSeconds / range.seconds)
      return new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(value, range.unit)
    }
  }

  return 'just now'
}

export default function MemoryTable({ records, onSelect, emptyMessage }: MemoryTableProps) {
  if (records.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-white/10 bg-white/5 p-10 text-center text-sm text-slate-400">
        {emptyMessage ?? 'No memories found.'}
      </div>
    )
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-[color:var(--panel)]">
      <div className="overflow-x-auto">
        <table className="min-w-[900px] w-full border-collapse text-sm">
        <thead className="bg-white/5 text-xs uppercase tracking-[0.18em] text-slate-400">
          <tr>
            <th className="px-4 py-3 text-left font-medium">Type</th>
            <th className="px-4 py-3 text-left font-medium">Summary</th>
            <th className="px-4 py-3 text-left font-medium">Project</th>
            <th className="px-4 py-3 text-left font-medium">Domain</th>
            <th className="px-4 py-3 text-left font-medium">Retrievals</th>
            <th className="px-4 py-3 text-left font-medium">Usage</th>
            <th className="px-4 py-3 text-left font-medium">Last used</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5">
          {records.map(record => {
            const summary = truncateText(getSummary(record), 120)
            const faded = record.deprecated ? 'opacity-60' : ''
            return (
              <tr
                key={record.id}
                onClick={() => onSelect(record)}
                onKeyDown={event => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    onSelect(record)
                  }
                }}
                role="button"
                tabIndex={0}
                className={`cursor-pointer transition hover:bg-white/5 ${faded}`}
              >
                <td className="px-4 py-3">
                  <div className="flex flex-col gap-2">
                    <TypeBadge type={record.type} />
                    {record.deprecated ? (
                      <span className="text-[10px] uppercase tracking-[0.2em] text-rose-300">Deprecated</span>
                    ) : null}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <div className="text-slate-100">{summary}</div>
                  <div className="text-xs text-slate-500">{record.id}</div>
                </td>
                <td className="px-4 py-3 text-slate-300">{record.project ?? 'unknown'}</td>
                <td className="px-4 py-3 text-slate-300">{record.domain ?? 'unknown'}</td>
                <td className="px-4 py-3 text-slate-200">{record.retrievalCount ?? 0}</td>
                <td className="px-4 py-3 text-slate-200">{record.usageCount ?? 0}</td>
                <td className="px-4 py-3 text-slate-400">
                  {formatRelativeTime(record.lastUsed ?? record.timestamp)}
                </td>
              </tr>
            )
          })}
        </tbody>
        </table>
      </div>
    </div>
  )
}
