import { Check, Copy, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { formatDateTime, formatDuration } from '@/lib/format'
import type { MaintenanceRun } from '@/lib/api'
import { ACTION_STYLES, triggerColor, triggerLabel } from './utils'

function SummaryCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-border bg-secondary/20 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold tabular-nums text-foreground">{value}</div>
    </div>
  )
}

export default function MaintenanceHistoryDetail({
  run,
  operationLabels,
  onDeleteRun,
  isDeleting
}: {
  run: MaintenanceRun | null
  operationLabels: Record<string, string>
  onDeleteRun: (run: MaintenanceRun) => void
  isDeleting: boolean
}) {
  const { copy, isCopied } = useCopyToClipboard(2000)

  if (!run) {
    return (
      <section className="rounded-xl border border-border bg-card p-4 flex flex-col min-h-0">
        <div className="flex-1 flex flex-col items-center justify-center text-center text-sm text-muted-foreground">
          Select a maintenance run to view details.
        </div>
      </section>
    )
  }

  const truncatedRunId = run.runId.length <= 12 ? run.runId : `${run.runId.slice(0, 12)}...`

  return (
    <section className="rounded-xl border border-border bg-card p-4 flex flex-col min-h-0">
      <div className="flex flex-col gap-3 min-h-0 flex-1">
        <div className="rounded-lg border border-border bg-background/50 p-3 shrink-0 space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-lg font-semibold truncate" title={run.runId}>Run {truncatedRunId}</div>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>{formatDateTime(run.timestamp)}</span>
                <Badge variant="secondary" className={triggerColor(run.trigger)}>
                  {triggerLabel(run.trigger)}
                </Badge>
                {run.dryRun && (
                  <Badge variant="secondary" className="bg-amber-500/15 text-amber-700 dark:text-amber-300">
                    Dry run
                  </Badge>
                )}
                {run.hasErrors && (
                  <Badge variant="destructive">Errors</Badge>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="xs"
                onClick={() => copy(run.runId, run.runId)}
              >
                {isCopied(run.runId) ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
                {isCopied(run.runId) ? 'Copied' : 'Copy ID'}
              </Button>
              <Button
                variant="destructive"
                size="xs"
                onClick={() => onDeleteRun(run)}
                disabled={isDeleting}
              >
                <Trash2 className="w-3.5 h-3.5" />
                {isDeleting ? 'Deleting...' : 'Delete'}
              </Button>
            </div>
          </div>
          <div className="text-[11px] text-muted-foreground">
            Duration <span className="ml-1 text-foreground font-medium tabular-nums">{formatDuration(run.duration)}</span>
          </div>
        </div>

        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3 shrink-0">
          <SummaryCard label="Deprecated" value={run.summary.totalDeprecated} />
          <SummaryCard label="Updated" value={run.summary.totalUpdated} />
          <SummaryCard label="Merged" value={run.summary.totalMerged} />
          <SummaryCard label="Promoted" value={run.summary.totalPromoted} />
          <SummaryCard label="Suggestions" value={run.summary.totalSuggestions} />
          <SummaryCard label="Errors" value={run.summary.operationsFailed} />
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto rounded-lg border border-border bg-background/40 p-3">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-2">Operations</div>
          {run.results.length === 0 ? (
            <div className="text-xs text-muted-foreground">No operation results recorded.</div>
          ) : (
            <Accordion type="multiple" className="w-full space-y-2">
              {run.results.map((result, index) => {
                const summaryEntries = Object.entries(result.summary)
                const operationLabel = operationLabels[result.operation] ?? result.operation
                const actionCount = result.actions.length
                const hasError = Boolean(result.error)

                return (
                  <AccordionItem
                    key={`${result.operation}-${index}`}
                    value={`${result.operation}-${index}`}
                    className="rounded-md border border-border bg-secondary/20 px-3"
                  >
                    <AccordionTrigger className="hover:no-underline py-3">
                      <div className="flex flex-wrap items-center gap-2 text-left">
                        <span className="text-sm font-medium text-foreground">{operationLabel}</span>
                        <Badge variant="secondary" className="bg-foreground/10 text-foreground/80">
                          {formatDuration(result.duration)}
                        </Badge>
                        <Badge variant="secondary" className="bg-foreground/10 text-foreground/80">
                          {actionCount} {actionCount === 1 ? 'action' : 'actions'}
                        </Badge>
                        {hasError && <Badge variant="destructive">Error</Badge>}
                      </div>
                    </AccordionTrigger>
                    <AccordionContent className="pb-3 space-y-3">
                      {result.error && (
                        <div className="text-xs text-destructive">{result.error}</div>
                      )}

                      {summaryEntries.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                          {summaryEntries.map(([key, value]) => (
                            <div key={key} className="rounded-md border border-border bg-background/60 px-2 py-1 text-[11px]">
                              <span className="text-muted-foreground">{key}</span>
                              <span className="ml-1 font-medium tabular-nums text-foreground">{value}</span>
                            </div>
                          ))}
                        </div>
                      )}

                      {result.actions.length === 0 ? (
                        <div className="text-xs text-muted-foreground">No actions recorded for this operation.</div>
                      ) : (
                        <div className="space-y-2">
                          {result.actions.map((action, actionIndex) => (
                            <div key={`${action.recordId ?? action.reason}-${actionIndex}`} className="rounded-md border border-border bg-background/60 p-2">
                              <div className="flex flex-wrap items-center gap-2 mb-1">
                                <Badge variant="secondary" className={ACTION_STYLES[action.type]?.badge}>
                                  {ACTION_STYLES[action.type]?.label ?? action.type}
                                </Badge>
                                {action.recordId && (
                                  <span className="text-[11px] font-mono text-muted-foreground">{action.recordId}</span>
                                )}
                              </div>
                              <div className="text-xs text-foreground">{action.snippet}</div>
                              <div className="text-[11px] text-muted-foreground mt-1">{action.reason}</div>
                            </div>
                          ))}
                        </div>
                      )}
                    </AccordionContent>
                  </AccordionItem>
                )
              })}
            </Accordion>
          )}
        </div>
      </div>
    </section>
  )
}
