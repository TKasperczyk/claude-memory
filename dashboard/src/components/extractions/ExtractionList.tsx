import { ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import ListItem from '@/components/ListItem'
import { formatDuration, formatRelativeTimeShort, formatTokenCount, truncateText } from '@/lib/format'
import type { ExtractionRun } from '@/lib/api'

function getFirstSentence(text: string | undefined, maxLength = 60): string | undefined {
  if (!text) return undefined
  const trimmed = text.trim().replace(/\s+/g, ' ')
  const endMatch = trimmed.match(/[.!?](\s|$)/)
  const sentence = endMatch ? trimmed.slice(0, endMatch.index! + 1) : trimmed
  return truncateText(sentence, maxLength, { ellipsis: '…' })
}

function ExtractionRunCard({
  run,
  selected,
  onSelect
}: {
  run: ExtractionRun
  selected: boolean
  onSelect: (runId: string) => void
}) {
  const hasErrors = run.parseErrorCount > 0
  const isSkipped = !!run.skipReason
  const dotClass = isSkipped ? 'bg-warning' : hasErrors ? 'bg-destructive' : 'bg-success'
  const promptPreview = getFirstSentence(run.firstPrompt)
  const tokenTotal = run.tokenUsage
    ? run.tokenUsage.inputTokens + run.tokenUsage.outputTokens
    : null

  return (
    <ListItem onClick={() => onSelect(run.runId)} selected={selected}>
      {/* Row 1: Activity + badges + time */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`h-2 w-2 rounded-full shrink-0 ${dotClass}`} />
          <span className="text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-foreground/10 text-foreground/70">
            {run.recordCount} rec
          </span>
          <span className="text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-foreground/10 text-foreground/70">
            {formatDuration(run.duration)}
          </span>
          {tokenTotal !== null && (
            <span className="text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-foreground/10 text-foreground/70">
              {formatTokenCount(tokenTotal)} tok
            </span>
          )}
          {isSkipped && (
            <span className="text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-warning/15 text-warning">
              {run.skipReason === 'too_short' ? 'too short' : 'skipped'}
            </span>
          )}
          {run.hasRememberMarker && (
            <span className="text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-info/15 text-info">
              /remember
            </span>
          )}
          {hasErrors && (
            <span className="text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-destructive/15 text-destructive">
              {run.parseErrorCount} err
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 text-[11px] text-muted-foreground shrink-0">
          <span>{formatRelativeTimeShort(run.timestamp, { includeAgo: true })}</span>
          {selected && <ChevronRight className="w-3.5 h-3.5 text-foreground" />}
        </div>
      </div>
      {/* Row 2: First prompt preview */}
      {promptPreview && (
        <div className="text-[11px] text-muted-foreground/70 truncate mt-1" title={run.firstPrompt}>
          {promptPreview}
        </div>
      )}
    </ListItem>
  )
}

export default function ExtractionList({
  groupedRuns,
  selectedRunId,
  onSelect,
  page,
  onPreviousPage,
  onNextPage,
  pageInfo,
  disableNext
}: {
  groupedRuns: Array<{ name: string; runs: ExtractionRun[] }>
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
        <div className="text-[11px] text-muted-foreground/60 font-medium tabular-nums">{groupedRuns.reduce((acc, group) => acc + group.runs.length, 0)}</div>
      </div>
      <div className="space-y-3 flex-1 min-h-0 lg:overflow-y-auto lg:pr-1">
        {groupedRuns.length === 0 ? (
          <div className="py-6 text-center text-sm text-muted-foreground">
            No runs match filters.
          </div>
        ) : (
          groupedRuns.map(group => (
            <div key={group.name} className="space-y-1.5">
              <div
                className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground px-1 pt-1 truncate"
                title={group.name}
              >
                {group.name}
              </div>
              <div className="space-y-1.5">
                {group.runs.map(run => (
                  <ExtractionRunCard
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
        <Button
          variant="outline"
          size="xs"
          onClick={onPreviousPage}
          disabled={page === 0}
        >
          Previous
        </Button>
        <span className="text-[11px] text-muted-foreground">{pageInfo}</span>
        <Button
          variant="outline"
          size="xs"
          onClick={onNextPage}
          disabled={disableNext}
        >
          Next
        </Button>
      </div>
    </section>
  )
}
