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

interface MemoryTableProps {
  records: MemoryRecord[]
  onSelect: (record: MemoryRecord) => void
  emptyMessage?: string
}

export default function MemoryTable({ records, onSelect, emptyMessage }: MemoryTableProps) {
  if (records.length === 0) {
    return (
      <Card className="py-16 text-center text-sm text-muted-foreground/70">
        {emptyMessage ?? 'No memories found'}
      </Card>
    )
  }

  return (
    <Card>
      <Table>
        <TableHeader>
          <TableRow className="bg-secondary hover:bg-secondary">
            <TableHead className="w-8 px-4"></TableHead>
            <TableHead className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground px-4">Summary</TableHead>
            <TableHead className="w-32 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground px-4">Project</TableHead>
            <TableHead className="w-28 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground px-4">Domain</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {records.map(record => {
            const summary = truncateText(getMemorySummary(record), 90, { ellipsis: '…' })
            return (
              <TableRow
                key={record.id}
                onClick={() => onSelect(record)}
                className={`cursor-pointer ${record.deprecated ? 'opacity-50' : ''}`}
              >
                <TableCell className="px-4 py-3">
                  <span
                    className="block w-2.5 h-2.5 rounded-full shadow-sm"
                    style={{ backgroundColor: TYPE_COLORS[record.type] }}
                    title={record.type}
                  />
                </TableCell>
                <TableCell className="px-4 py-3">
                  <div className="font-medium text-foreground/95 truncate">{summary}</div>
                </TableCell>
                <TableCell className="px-4 py-3 text-muted-foreground/80 truncate text-[13px]">
                  {record.project ?? '—'}
                </TableCell>
                <TableCell className="px-4 py-3 text-muted-foreground/80 truncate text-[13px]">
                  {record.domain ?? '—'}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </Card>
  )
}
