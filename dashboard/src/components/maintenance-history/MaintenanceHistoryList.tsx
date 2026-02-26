import { ChevronRight } from 'lucide-react'
import ListItem from '@/components/ListItem'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { formatDuration, formatRelativeTimeShort } from '@/lib/format'
import type { MaintenanceRun } from '@/lib/api'
import { triggerColor, triggerLabel } from './utils'

function MaintenanceRunCard({
  run,
  selected,
  onSelect
}: {
  run: MaintenanceRun
  selected: boolean
  onSelect: (runId: string) => void
}) {
  const statusDot = run.hasErrors ? 'bg-destructive' : 'bg-success'
  const operationCount = run.operations.length
  const deprecatedCount = run.summary.totalDeprecated
  const mergedCount = run.summary.totalMerged

  return (
    <ListItem onClick={() => onSelect(run.runId)} selected={selected}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`h-2 w-2 rounded-full shrink-0 ${statusDot}`} />
          <Badge variant="secondary" className={triggerColor(run.trigger)}>
            {triggerLabel(run.trigger)}
          </Badge>
          {run.dryRun && (
            <Badge variant="secondary" className="bg-amber-500/15 text-amber-700 dark:text-amber-300">
              Dry run
            </Badge>
          )}
          <span className="text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-foreground/10 text-foreground/70">
            {operationCount} {operationCount === 1 ? 'op' : 'ops'}
          </span>
        </div>
        <div className="flex items-center gap-1 text-[11px] text-muted-foreground shrink-0">
          <span>{formatRelativeTimeShort(run.timestamp, { includeAgo: true })}</span>
          {selected && <ChevronRight className="w-3.5 h-3.5 text-foreground" />}
        </div>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground/80">
        <span>{deprecatedCount} deprecated</span>
        <span className="text-muted-foreground/40">·</span>
        <span>{mergedCount} merged</span>
        <span className="text-muted-foreground/40">·</span>
        <span>{formatDuration(run.duration)}</span>
      </div>
    </ListItem>
  )
}

export default function MaintenanceHistoryList({
  groupedRuns,
  selectedRunId,
  onSelect,
  page,
  onPreviousPage,
  onNextPage,
  pageInfo,
  disableNext
}: {
  groupedRuns: Array<{ name: string; runs: MaintenanceRun[] }>
  selectedRunId: string | null
  onSelect: (runId: string) => void
  page: number
  onPreviousPage: () => void
  onNextPage: () => void
  pageInfo: string
  disableNext: boolean
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-3 flex flex-col min-h-0">
      <div className="flex items-center justify-between mb-3">
        <div className="text-[11px] font-semibold text-muted-foreground/70 uppercase tracking-[0.1em]">Runs</div>
        <div className="text-[11px] text-muted-foreground/60 font-medium tabular-nums">
          {groupedRuns.reduce((count, group) => count + group.runs.length, 0)}
        </div>
      </div>
      <div className="space-y-3 flex-1 min-h-0 lg:overflow-y-auto lg:pr-1">
        {groupedRuns.length === 0 ? (
          <div className="py-6 text-center text-sm text-muted-foreground">No runs match filters.</div>
        ) : (
          groupedRuns.map(group => (
            <div key={group.name} className="space-y-1.5">
              <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground px-1 pt-1">
                {group.name}
              </div>
              <div className="space-y-1.5">
                {group.runs.map(run => (
                  <MaintenanceRunCard
                    key={run.runId}
                    run={run}
                    selected={run.runId === selectedRunId}
                    onSelect={onSelect}
                  />
                ))}
              </div>
            </div>
          ))
        )}
      </div>
      <div className="mt-3 flex items-center justify-between">
        <Button variant="outline" size="xs" onClick={onPreviousPage} disabled={page === 0}>
          Previous
        </Button>
        <span className="text-[11px] text-muted-foreground">{pageInfo}</span>
        <Button variant="outline" size="xs" onClick={onNextPage} disabled={disableNext}>
          Next
        </Button>
      </div>
    </section>
  )
}
