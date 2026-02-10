import { useEffect } from 'react'
import { Trash2 } from 'lucide-react'
import MetricTile from '@/components/MetricTile'
import ListItem from '@/components/ListItem'
import { Button } from '@/components/ui/button'
import { formatDateTime, formatDuration, formatRelativeTimeShort, formatTokenCount, truncateText } from '@/lib/format'
import { TYPE_COLORS, getMemorySummary } from '@/lib/memory-ui'
import type { ExtractionReview, ExtractionRun, MemoryRecord } from '@/lib/api'
import ExtractionReviewPanel from './ExtractionReviewPanel'
import { RecordsSkeleton } from './ExtractionSkeletons'
import { extractProjectFromPath, getAccuracyBadge, truncateSessionId } from './utils'

export default function ExtractionDetail({
  run,
  recordsByRun,
  loadingRunIds,
  runErrors,
  reviewsByRun,
  reviewLoading,
  reviewErrors,
  onSelectMemory,
  onReviewUpdate,
  onReviewError,
  onLoadRunDetails,
  onLoadReview,
  onDeleteRun,
  deleteError,
  isDeleting,
  copy,
  isCopied
}: {
  run: ExtractionRun | null
  recordsByRun: Record<string, MemoryRecord[]>
  loadingRunIds: Record<string, boolean>
  runErrors: Record<string, string>
  reviewsByRun: Record<string, ExtractionReview | null>
  reviewLoading: Record<string, boolean>
  reviewErrors: Record<string, string>
  onSelectMemory: (recordId: string) => void
  onReviewUpdate: (runId: string, nextReview: ExtractionReview) => void
  onReviewError: (runId: string, message: string) => void
  onLoadRunDetails: (run: ExtractionRun) => void
  onLoadReview: (run: ExtractionRun) => void
  onDeleteRun: (run: ExtractionRun) => void
  deleteError: string | null
  isDeleting: boolean
  copy: (id: string, value: string) => void
  isCopied: (id: string) => boolean
}) {
  useEffect(() => {
    if (!run) return
    void onLoadRunDetails(run)
    void onLoadReview(run)
  }, [run, onLoadRunDetails, onLoadReview])

  if (!run) {
    return (
      <section className="rounded-xl border border-border bg-card p-4 flex flex-col min-h-0">
        <div className="flex-1 flex flex-col items-center justify-center text-center text-sm text-muted-foreground">
          Select an extraction run to view details.
        </div>
      </section>
    )
  }

  const runRecords = recordsByRun[run.runId] ?? []
  const isLoadingRecords = loadingRunIds[run.runId] === true
  const runError = runErrors[run.runId]
  const review = reviewsByRun[run.runId] ?? null
  const reviewLoadingState = reviewLoading[run.runId] ?? false
  const reviewError = reviewErrors[run.runId]
  const hasReviewLoaded = Object.prototype.hasOwnProperty.call(reviewsByRun, run.runId)
  const accuracyBadge = review ? getAccuracyBadge(review.accuracyScore) : null
  const transcriptPath = run.transcriptPath || '—'
  const projectName = extractProjectFromPath(run.transcriptPath)
  const tokenTotal = run.tokenUsage
    ? run.tokenUsage.inputTokens + run.tokenUsage.outputTokens
    : null

  const handleDelete = () => {
    if (isDeleting) return
    onDeleteRun(run)
  }

  return (
    <section className="rounded-xl border border-border bg-card p-4 flex flex-col min-h-0">
      <div className="flex flex-col flex-1 min-h-0 gap-3">
        <div className="rounded-lg border border-border bg-background/50 p-3 shrink-0">
          <div className="flex items-start justify-between gap-3 mb-2">
            <div className="min-w-0">
              <div
                className="text-lg font-semibold truncate"
                title={transcriptPath}
                style={{ direction: 'rtl', textAlign: 'left' }}
              >
                {projectName}
              </div>
              <div className="text-[11px] text-muted-foreground truncate">
                Session {truncateSessionId(run.sessionId)}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <div className="flex items-center gap-1.5">
                {accuracyBadge && (
                  <span
                    className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-full ${accuracyBadge.badge}`}
                    title={accuracyBadge.title}
                  >
                    Acc {accuracyBadge.label}
                  </span>
                )}
                {run.parseErrorCount > 0 && (
                  <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-destructive/15 text-destructive">
                    {run.parseErrorCount} parse {run.parseErrorCount === 1 ? 'error' : 'errors'}
                  </span>
                )}
              </div>
              <Button
                variant="destructive"
                size="xs"
                onClick={handleDelete}
                disabled={isDeleting}
              >
                <Trash2 className="w-3.5 h-3.5" />
                {isDeleting ? 'Deleting...' : 'Delete'}
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-2">
            <MetricTile label="Records" value={run.recordCount} />
            <MetricTile label="Duration" value={formatDuration(run.duration)} />
            {tokenTotal !== null && (
              <MetricTile label="Tokens" value={formatTokenCount(tokenTotal)} />
            )}
            <MetricTile
              label="Errors"
              value={run.parseErrorCount}
              valueClassName={run.parseErrorCount > 0 ? 'text-destructive' : undefined}
            />
            <MetricTile
              label="Reviewed"
              value={review ? formatRelativeTimeShort(review.reviewedAt, { includeAgo: true }) : '—'}
            />
          </div>

          <div className="text-[11px] text-muted-foreground">
            Run {formatDateTime(run.timestamp)}
          </div>
          {deleteError && (
            <div className="mt-2 text-xs text-destructive">{deleteError}</div>
          )}
        </div>

        <div className="shrink-0">
          <ExtractionReviewPanel
            run={run}
            runRecords={runRecords}
            review={review}
            reviewLoadingState={reviewLoadingState}
            reviewError={reviewError}
            hasReviewLoaded={hasReviewLoaded}
            onSelect={onSelectMemory}
            onReviewUpdate={onReviewUpdate}
            onReviewError={onReviewError}
            copy={copy}
            isCopied={isCopied}
          />
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto space-y-3">
          <div className="rounded-lg border border-border bg-background/40 p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Records</div>
              <div className="text-[11px] text-muted-foreground">{run.recordCount}</div>
            </div>
            {isLoadingRecords ? (
              <RecordsSkeleton />
            ) : runError ? (
              <div className="text-xs text-destructive">{runError}</div>
            ) : runRecords.length === 0 ? (
              <div className="text-xs text-muted-foreground">No records extracted.</div>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {runRecords.map(record => {
                  const summaryText = truncateText(getMemorySummary(record), 100)
                  const excerpt = record.sourceExcerpt
                    ? truncateText(record.sourceExcerpt, 220)
                    : 'No source excerpt available.'

                  return (
                    <ListItem key={record.id} onClick={() => onSelectMemory(record.id)}>
                      <div className="flex items-center gap-2 mb-1">
                        <span
                          className="w-2 h-2 rounded-full"
                          style={{ backgroundColor: TYPE_COLORS[record.type] }}
                        />
                        <span className="text-[11px] text-muted-foreground uppercase tracking-wide">
                          {record.type}
                        </span>
                        <span className="text-[11px] text-muted-foreground font-mono truncate">
                          {record.id}
                        </span>
                      </div>
                      <div className="text-xs text-foreground mb-1 line-clamp-2">{summaryText}</div>
                      <div className="text-[10px] text-muted-foreground font-mono line-clamp-2">{excerpt}</div>
                    </ListItem>
                  )
                })}
              </div>
            )}
          </div>

          <div className="rounded-lg border border-border bg-background/40 p-3 space-y-2">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Run details</div>
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
              <div>
                <span className="text-muted-foreground">Session</span>
                <span className="ml-2 font-mono text-foreground">{run.sessionId}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Run ID</span>
                <span className="ml-2 font-mono text-foreground">{run.runId}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Started</span>
                <span className="ml-2 text-foreground">{formatDateTime(run.timestamp)}</span>
              </div>
              {review && (
                <>
                  <div>
                    <span className="text-muted-foreground">Review model</span>
                    <span className="ml-2 font-mono text-foreground">{review.model}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Review time</span>
                    <span className="ml-2 text-foreground">{formatDuration(review.durationMs)}</span>
                  </div>
                </>
              )}
            </div>
            <div className="text-xs">
              <span className="text-muted-foreground">Transcript</span>
              <span className="ml-2 font-mono text-foreground break-all">{transcriptPath}</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
