import type { MaintenanceCandidateGroup, MaintenanceCandidateRecord } from '@/lib/api'
import RecordLink from './RecordLink'

function formatCandidateDetails(details?: MaintenanceCandidateRecord['details']): string[] {
  if (!details || typeof details !== 'object') return []
  const meta: string[] = []

  if (typeof details.similarity === 'number') {
    meta.push(`sim ${details.similarity.toFixed(2)}`)
  }
  if (typeof details.ageDays === 'number') {
    meta.push(`age ${details.ageDays}d`)
  }
  if (typeof details.scope === 'string') {
    meta.push(`scope ${details.scope}`)
  }
  if (typeof details.retrievalCount === 'number') {
    meta.push(`retrievals ${details.retrievalCount}`)
  }
  if (typeof details.usageCount === 'number') {
    meta.push(`usage ${details.usageCount}`)
  }
  if (typeof details.ratio === 'number') {
    meta.push(`ratio ${Math.round(details.ratio * 100)}%`)
  }
  if (typeof details.failureCount === 'number') {
    meta.push(`failures ${details.failureCount}`)
  }

  return meta
}

function CandidateRow({
  record,
  onSelect
}: {
  record: MaintenanceCandidateRecord
  onSelect?: (id: string) => void
}) {
  const meta = formatCandidateDetails(record.details)

  return (
    <div className="rounded-md border border-border bg-background/60 p-3 space-y-1">
      <div className="flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-wide text-muted-foreground/80">
        <span className="font-mono normal-case text-foreground/80">
          <RecordLink id={record.id} onSelect={onSelect} stopPropagation />
        </span>
        <span>{record.type}</span>
        {meta.length > 0 && (
          <span className="flex flex-wrap gap-1 text-[10px] normal-case">
            {meta.map((item, index) => (
              <span
                key={`${record.id}-${index}`}
                className="rounded-full border border-border/60 px-2 py-0.5 text-muted-foreground/80"
              >
                {item}
              </span>
            ))}
          </span>
        )}
      </div>
      <div className="text-sm text-foreground">{record.snippet}</div>
      <div className="text-xs text-muted-foreground">{record.reason}</div>
    </div>
  )
}

export default function CandidateGroup({
  group,
  onSelect
}: {
  group: MaintenanceCandidateGroup
  onSelect?: (id: string) => void
}) {
  return (
    <div className="rounded-md border border-border bg-secondary/20 p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground">
        <span>{group.label}</span>
        {group.reason && (
          <span className="text-xs normal-case text-muted-foreground/70">{group.reason}</span>
        )}
      </div>
      <div className="space-y-2">
        {group.records.map(record => (
          <CandidateRow key={record.id} record={record} onSelect={onSelect} />
        ))}
      </div>
    </div>
  )
}
