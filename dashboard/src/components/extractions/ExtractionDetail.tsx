import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Trash2, RotateCcw, MessageSquare } from 'lucide-react'
import MetricTile from '@/components/MetricTile'
import ListItem from '@/components/ListItem'
import { Button } from '@/components/ui/button'
import { formatDateTime, formatDuration, formatRelativeTimeShort, formatTokenCount, truncateText } from '@/lib/format'
import { TYPE_COLORS, getMemorySummary } from '@/lib/memory-ui'
import { reExtract, type ExtractionRun, type MemoryRecord } from '@/lib/api'
import { useExtractionRunDetail, useExtractionReview } from '@/hooks/queries'
import ExtractionReviewPanel from './ExtractionReviewPanel'
import { RecordsSkeleton } from './ExtractionSkeletons'
import { extractProjectFromPath, getAccuracyBadge, truncateSessionId } from './utils'
import { formatExtractionFailureSummary, getRunStatus } from '../../../../src/lib/extraction-status.js'

function getOutcomeClass(outcome: string): string {
  if (outcome === 'failed') return 'bg-destructive/15 text-destructive'
  if (outcome === 'skipped') return 'bg-warning/15 text-warning'
  if (outcome === 'updated') return 'bg-info/15 text-info'
  return 'bg-success/15 text-success'
}

export default function ExtractionDetail({
  run,
  onSelectMemory,
  onDeleteRun,
  onSendToChat,
  deleteError,
  isDeleting,
  copy,
  isCopied
}: {
  run: ExtractionRun | null
  onSelectMemory: (recordId: string) => void
  onDeleteRun: (run: ExtractionRun) => void
  onSendToChat: (run: ExtractionRun) => void
  deleteError: string | null
  isDeleting: boolean
  copy: (id: string, value: string) => void
  isCopied: (id: string) => boolean
}) {
  const queryClient = useQueryClient()
  const [reExtracting, setReExtracting] = useState(false)
  const [reExtractResult, setReExtractResult] = useState<string | null>(null)

  const runId = run?.runId ?? null
  const { data: runDetail, isLoading: isLoadingRecords, error: runDetailError } = useExtractionRunDetail(runId)
  const { data: review, isLoading: reviewLoadingState, error: reviewQueryError } = useExtractionReview(runId)

  const runRecords: MemoryRecord[] = runDetail?.records ?? []
  const recordsById = new Map(runRecords.map(record => [record.id, record]))
  const extractedRecordSummaries = run?.extractedRecords ?? []
  const hasOutcomeRows = extractedRecordSummaries.some(record => record.outcome)
  const runError = runDetailError instanceof Error ? runDetailError.message : undefined
  const reviewError = reviewQueryError instanceof Error ? reviewQueryError.message : undefined
  const hasReviewLoaded = review !== undefined

  const invalidateRunData = () => {
    void queryClient.invalidateQueries({ queryKey: ['extraction-run', runId] })
    void queryClient.invalidateQueries({ queryKey: ['extraction-review', runId] })
    void queryClient.invalidateQueries({ queryKey: ['extractions'] })
  }

  const handleReviewUpdate = (_runId: string, nextReview: import('@/lib/api').ExtractionReview) => {
    queryClient.setQueryData(['extraction-review', runId], nextReview)
  }

  const handleReviewError = (_runId: string, _message: string) => {
    // Errors are handled by the query itself; clear on next successful fetch
  }

  if (!run) {
    return (
      <section className="rounded-xl border border-border bg-card p-4 flex flex-col min-h-0">
        <div className="flex-1 flex flex-col items-center justify-center text-center text-sm text-muted-foreground">
          Select an extraction run to view details.
        </div>
      </section>
    )
  }

  const accuracyBadge = review ? getAccuracyBadge(review.accuracyScore) : null
  const transcriptPath = run.transcriptPath || '—'
  const projectName = extractProjectFromPath(run.transcriptPath)
  const tokenTotal = run.tokenUsage
    ? run.tokenUsage.inputTokens + run.tokenUsage.outputTokens
    : null
  const runStatus = getRunStatus(run)
  const isFailedRun = runStatus === 'failed'
  const isPartialRun = runStatus === 'partial'
  const errorSummary = formatExtractionFailureSummary(run.error)
  const errorMessage = run.error && 'message' in run.error ? run.error.message : undefined
  const errorDetails: Array<[string, string | number]> = []
  if (run.error) {
    errorDetails.push(['Kind', run.error.kind])
    if (run.error.kind === 'api_error') {
      if (run.error.code) errorDetails.push(['Code', run.error.code])
      if (run.error.status !== undefined) errorDetails.push(['Status', run.error.status])
      if (run.error.requestId) errorDetails.push(['Request ID', run.error.requestId])
    }
    if (run.error.kind === 'max_tokens') {
      errorDetails.push(['Max tokens', run.error.maxTokens])
    }
  }

  const handleReExtract = async () => {
    if (reExtracting) return
    setReExtracting(true)
    setReExtractResult(null)
    try {
      const result = await reExtract(run.runId)
      setReExtractResult(`Done: ${result.inserted} inserted, ${result.updated} updated, ${result.skipped} skipped`)
      invalidateRunData()
    } catch (error) {
      setReExtractResult(`Failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setReExtracting(false)
    }
  }

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
                {runStatus === 'skipped' && run.skipReason && (
                  <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-warning/15 text-warning">
                    {run.skipReason === 'too_short' ? 'Skipped: too short' : 'Skipped: no records'}
                  </span>
                )}
                {(isFailedRun || isPartialRun) && run.error && (
                  <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-full ${isFailedRun ? 'bg-destructive/15 text-destructive' : 'bg-warning/15 text-warning'}`}>
                    {isFailedRun ? `Failed: ${errorSummary}` : `Partial: ${errorSummary}`}
                  </span>
                )}
                {run.hasRememberMarker && (
                  <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-info/15 text-info">
                    /remember
                  </span>
                )}
                {run.parseErrorCount > 0 && (
                  <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-destructive/15 text-destructive">
                    {run.parseErrorCount} parse {run.parseErrorCount === 1 ? 'error' : 'errors'}
                  </span>
                )}
              </div>
              <Button
                variant="outline"
                size="xs"
                onClick={() => onSendToChat(run)}
              >
                <MessageSquare className="w-3.5 h-3.5" />
                Chat
              </Button>
              <Button
                variant="outline"
                size="xs"
                onClick={handleReExtract}
                disabled={reExtracting}
              >
                <RotateCcw className={`w-3.5 h-3.5 ${reExtracting ? 'animate-spin' : ''}`} />
                {reExtracting ? 'Re-extracting...' : 'Re-extract'}
              </Button>
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
              label="Skipped"
              value={run.skippedRecordCount ?? '—'}
              valueClassName={(run.skippedRecordCount ?? 0) > 0 ? 'text-warning' : undefined}
            />
            <MetricTile
              label="Failed"
              value={run.failedRecordCount ?? '—'}
              valueClassName={(run.failedRecordCount ?? 0) > 0 ? 'text-destructive' : undefined}
            />
            <MetricTile
              label="Run error"
              value={isFailedRun ? 'failed' : isPartialRun ? 'partial' : '—'}
              valueClassName={isFailedRun ? 'text-destructive' : isPartialRun ? 'text-warning' : undefined}
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
          {reExtractResult && (
            <div className={`mt-2 text-xs ${reExtractResult.startsWith('Failed') ? 'text-destructive' : 'text-muted-foreground'}`}>
              {reExtractResult}
            </div>
          )}
          {(isFailedRun || isPartialRun) && run.error && (
            <div className={`mt-2 rounded-md border px-3 py-2 text-xs ${isFailedRun ? 'border-destructive/20 bg-destructive/10 text-destructive' : 'border-warning/20 bg-warning/10 text-warning'}`}>
              <div className="font-medium uppercase tracking-wide mb-1">
                {isFailedRun ? 'Extraction failed' : 'Extraction partial'}
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {errorDetails.map(([label, value]) => (
                  <span key={label}>
                    <span className="opacity-70">{label}</span>
                    <span className="ml-1 font-mono">{value}</span>
                  </span>
                ))}
              </div>
              {errorMessage && (
                <div className="mt-1 font-mono break-words">{errorMessage}</div>
              )}
            </div>
          )}
        </div>

        <div className="shrink-0">
          <ExtractionReviewPanel
            run={run}
            runRecords={runRecords}
            review={review ?? null}
            reviewLoadingState={reviewLoadingState}
            reviewError={reviewError}
            hasReviewLoaded={hasReviewLoaded}
            onSelect={onSelectMemory}
            onReviewUpdate={handleReviewUpdate}
            onReviewError={handleReviewError}
            copy={copy}
            isCopied={isCopied}
          />
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto space-y-3">
          <div className="rounded-lg border border-border bg-background/40 p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Records</div>
              <div className="text-[11px] text-muted-foreground">
                {hasOutcomeRows ? extractedRecordSummaries.length : run.recordCount}
              </div>
            </div>
            {isLoadingRecords ? (
              <RecordsSkeleton />
            ) : runError ? (
              <div className="text-xs text-destructive">{runError}</div>
            ) : !hasOutcomeRows && runRecords.length === 0 ? (
              <div className="text-xs text-muted-foreground">No records extracted.</div>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {hasOutcomeRows ? extractedRecordSummaries.map(summary => {
                  const storedRecord = recordsById.get(summary.storedRecordId ?? summary.id)
                  const type = storedRecord?.type ?? summary.type
                  const displayId = summary.storedRecordId ?? summary.id
                  const summaryText = truncateText(storedRecord ? getMemorySummary(storedRecord) : summary.summary, 100)
                  const excerpt = storedRecord?.sourceExcerpt
                    ? truncateText(storedRecord.sourceExcerpt, 220)
                    : summary.storeError
                      ? truncateText(summary.storeError, 220)
                      : 'No source excerpt available.'
                  const selectId = summary.storedRecordId ?? (summary.outcome === 'inserted' ? summary.id : undefined)

                  return (
                    <ListItem key={summary.id} onClick={selectId ? () => onSelectMemory(selectId) : undefined}>
                      <div className="flex items-center gap-2 mb-1">
                        <span
                          className="w-2 h-2 rounded-full"
                          style={{ backgroundColor: TYPE_COLORS[type] }}
                        />
                        <span className="text-[11px] text-muted-foreground uppercase tracking-wide">
                          {type}
                        </span>
                        <span className="text-[11px] text-muted-foreground font-mono truncate">
                          {displayId}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 mb-1">
                        {summary.outcome && (
                          <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-full ${getOutcomeClass(summary.outcome)}`}>
                            {summary.outcome}
                          </span>
                        )}
                        {typeof summary.dedupSimilarity === 'number' && (
                          <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-foreground/10 text-foreground/70">
                            {(summary.dedupSimilarity * 100).toFixed(1)}%
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-foreground mb-1 line-clamp-2">{summaryText}</div>
                      <div className="text-[10px] text-muted-foreground font-mono line-clamp-2">{excerpt}</div>
                    </ListItem>
                  )
                }) : runRecords.map(record => {
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
