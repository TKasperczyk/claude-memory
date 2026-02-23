import { Card } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { MemoryRecord } from '@/lib/api'
import { truncateText } from '@/lib/format'
import { TYPE_COLORS, getMemorySummary } from '@/lib/memory-ui'

const TYPE_LABELS: Record<string, string> = {
  command: 'CMD',
  error: 'ERR',
  discovery: 'DIS',
  procedure: 'PRO',
  warning: 'WRN',
}

interface MemoryTableProps {
  records: MemoryRecord[]
  onSelect: (record: MemoryRecord) => void
  emptyMessage?: string
}

export default function MemoryTable({ records, onSelect, emptyMessage }: MemoryTableProps) {
  if (records.length === 0) {
    return (
      <Card className="py-16 text-center text-sm text-muted-foreground">
        {emptyMessage ?? 'No memories found'}
      </Card>
    )
  }

  return (
    <Card>
      <Table>
        <TableHeader>
          <TableRow className="bg-surface-1 hover:bg-surface-1">
            <TableHead className="w-16 px-4">Type</TableHead>
            <TableHead className="px-4">Summary</TableHead>
            <TableHead className="w-32 px-4">Project</TableHead>
            <TableHead className="w-20 px-4">Scope</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {records.map(record => {
            const summary = truncateText(getMemorySummary(record), 90, { ellipsis: '…' })
            const typeColor = TYPE_COLORS[record.type]
            return (
              <TableRow
                key={record.id}
                onClick={() => onSelect(record)}
                className={`cursor-pointer ${record.deprecated ? 'opacity-50' : ''}`}
              >
                <TableCell className="px-4 py-2.5">
                  <span
                    className="inline-flex items-center justify-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide"
                    style={{
                      backgroundColor: `${typeColor}14`,
                      color: typeColor,
                    }}
                  >
                    {TYPE_LABELS[record.type] ?? record.type.slice(0, 3).toUpperCase()}
                  </span>
                </TableCell>
                <TableCell className="px-4 py-2.5">
                  <div className="font-medium text-foreground truncate">{summary}</div>
                </TableCell>
                <TableCell className="px-4 py-2.5 text-muted-foreground truncate text-[13px]">
                  {record.project ?? '—'}
                </TableCell>
                <TableCell className={`px-4 py-2.5 truncate text-[13px] ${record.scope === 'global' ? 'text-type-discovery font-medium' : 'text-muted-foreground'}`}>
                  {record.scope ?? 'project'}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </Card>
  )
}
