import { useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Check, Copy } from 'lucide-react'
import { PageHeader } from '@/App'
import ButtonSpinner from '@/components/ButtonSpinner'
import MemoryDetail from '@/components/MemoryDetail'
import { useExtractions } from '@/hooks/queries'
import { useSelectedMemory } from '@/hooks/useSelectedMemory'
import Skeleton from '@/components/Skeleton'
import {
  fetchExtractionReview,
  fetchExtractionRun,
  runExtractionReview,
  type ExtractionReview,
  type ExtractionReviewIssue,
  type ExtractionRun,
  type MemoryRecord
} from '@/lib/api'
import { formatDateTime, formatDuration } from '@/lib/format'
import { TYPE_COLORS } from '@/lib/memory-ui'
import { formatExtractionReview } from '@/lib/review-format'

const PAGE_SIZE = 25

const ACCURACY_STYLES: Record<ExtractionReview['overallAccuracy'], { badge: string; label: string }> = {
  good: {
    badge: 'bg-emerald-500/15 text-emerald-300',
    label: 'Good'
  },
  acceptable: {
    badge: 'bg-amber-500/15 text-amber-300',
    label: 'Acceptable'
  },
  poor: {
    badge: 'bg-destructive/15 text-destructive',
    label: 'Poor'
  }
}

const SEVERITY_STYLES: Record<ExtractionReviewIssue['severity'], string> = {
  critical: 'bg-destructive/15 text-destructive',
  major: 'bg-amber-500/15 text-amber-300',
  minor: 'bg-sky-500/15 text-sky-300'
}

const ISSUE_LABELS: Record<ExtractionReviewIssue['type'], string> = {
  inaccurate: 'Inaccurate',
  partial: 'Partial',
  hallucinated: 'Hallucinated',
  missed: 'Missed'
}

function truncateSessionId(sessionId: string): string {
  if (sessionId.length <= 10) return sessionId
  return `${sessionId.slice(0, 10)}...`
}

function getRecordSummary(record: MemoryRecord): string {
  switch (record.type) {
    case 'command': return record.command
    case 'error': return record.errorText
    case 'discovery': return record.what
    case 'procedure': return record.name
  }
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, max - 3)}...`
}

function ExtractionListSkeleton() {
  const cards = Array.from({ length: 3 })

  return (
    <div className="space-y-2">
      {cards.map((_, index) => (
        <div key={index} className="rounded-xl border border-border bg-card p-4 space-y-3">
          <div className="flex items-center gap-3">
            <Skeleton className="h-4 w-4" />
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-3 w-24 ml-auto" />
          </div>
          <Skeleton className="h-3 w-40" />
          <div className="flex gap-4">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-3 w-20" />
          </div>
        </div>
      ))}
    </div>
  )
}

function ReviewSkeleton() {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-3 w-28" />
      </div>
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-4 w-4/6" />
    </div>
  )
}

function RecordsSkeleton() {
  const items = Array.from({ length: 3 })

  return (
    <div className="space-y-2">
      {items.map((_, index) => (
        <div key={index} className="rounded-md border border-border bg-secondary/30 px-3 py-2 space-y-2">
          <div className="flex items-center gap-2">
            <Skeleton className="h-2 w-2 rounded-full" />
            <Skeleton className="h-3 w-12" />
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-3 w-3 ml-auto" />
          </div>
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-3 w-full" />
        </div>
      ))}
    </div>
  )
}

export default function Extractions() {
  const [page, setPage] = useState(0)
  const [expanded, setExpanded] = useState<string | null>(null)
  const { selectedId, selected, detailLoading, detailError, handleSelect, handleClose } = useSelectedMemory()
  const [recordsByRun, setRecordsByRun] = useState<Record<string, MemoryRecord[]>>({})
  const [loadingRunId, setLoadingRunId] = useState<string | null>(null)
  const [runErrors, setRunErrors] = useState<Record<string, string>>({})
  const [reviewsByRun, setReviewsByRun] = useState<Record<string, ExtractionReview | null>>({})
  const [reviewLoading, setReviewLoading] = useState<Record<string, boolean>>({})
  const [reviewRunning, setReviewRunning] = useState<Record<string, boolean>>({})
  const [reviewErrors, setReviewErrors] = useState<Record<string, string>>({})
  const [copied, setCopied] = useState<Record<string, boolean>>({})
  const loadSeqRef = useRef(0)

  const { data, error, isPending, isFetching } = useExtractions({ page, limit: PAGE_SIZE })
  const runs = data?.runs ?? []
  const total = data?.total ?? null
  const displayOffset = data?.offset ?? page * PAGE_SIZE
  const errorMessage = error instanceof Error ? error.message : 'Failed to load extractions'

  const handleToggle = async (run: ExtractionRun) => {
    const isOpen = expanded === run.runId
    setExpanded(isOpen ? null : run.runId)

    if (!isOpen && !recordsByRun[run.runId]) {
      const loadSeq = loadSeqRef.current + 1
      loadSeqRef.current = loadSeq
      setLoadingRunId(run.runId)
      setRunErrors(prev => ({ ...prev, [run.runId]: '' }))
      try {
        const response = await fetchExtractionRun(run.runId)
        if (loadSeqRef.current !== loadSeq) return
        setRecordsByRun(prev => ({ ...prev, [run.runId]: response.records }))
      } catch (err) {
        if (loadSeqRef.current !== loadSeq) return
        const message = err instanceof Error ? err.message : 'Failed to load extraction'
        setRunErrors(prev => ({ ...prev, [run.runId]: message }))
      } finally {
        if (loadSeqRef.current === loadSeq) {
          setLoadingRunId(null)
        }
      }
    }

    if (!isOpen && !Object.prototype.hasOwnProperty.call(reviewsByRun, run.runId)) {
      setReviewLoading(prev => ({ ...prev, [run.runId]: true }))
      setReviewErrors(prev => ({ ...prev, [run.runId]: '' }))
      try {
        const review = await fetchExtractionReview(run.runId)
        setReviewsByRun(prev => ({ ...prev, [run.runId]: review }))
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to load review'
        setReviewErrors(prev => ({ ...prev, [run.runId]: message }))
      } finally {
        setReviewLoading(prev => ({ ...prev, [run.runId]: false }))
      }
    }
  }

  const handleReview = async (runId: string) => {
    setReviewRunning(prev => ({ ...prev, [runId]: true }))
    setReviewErrors(prev => ({ ...prev, [runId]: '' }))
    try {
      const review = await runExtractionReview(runId)
      setReviewsByRun(prev => ({ ...prev, [runId]: review }))
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to run review'
      setReviewErrors(prev => ({ ...prev, [runId]: message }))
    } finally {
      setReviewRunning(prev => ({ ...prev, [runId]: false }))
    }
  }

  const handleCopy = async (run: ExtractionRun, runRecords: MemoryRecord[], review: ExtractionReview) => {
    const text = formatExtractionReview(run, runRecords, review)
    await navigator.clipboard.writeText(text)
    setCopied(prev => ({ ...prev, [run.runId]: true }))
    setTimeout(() => {
      setCopied(prev => ({ ...prev, [run.runId]: false }))
    }, 2000)
  }

  const pageInfo = () => {
    if (isPending && !data) return 'Loading...'
    if (error && !data) return 'Error'
    if (!runs.length) return 'No results'
    const start = displayOffset + 1
    const end = displayOffset + runs.length
    return total ? `${start}-${end} of ${total}` : `${start}-${end}`
  }

  const isInitialLoading = isPending && runs.length === 0
  const isRefreshing = isFetching && !isInitialLoading

  return (
    <div className="space-y-6">
      <PageHeader
        title="Extractions"
        description="Monitor extraction runs and review extracted records"
      />

      {error && data && (
        <div className="bg-amber-500/10 text-amber-400 text-sm px-3 py-2 rounded mb-4">
          Failed to refresh data. Showing cached results.
        </div>
      )}

      {isRefreshing && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <ButtonSpinner size="xs" className="text-muted-foreground" />
          Updating runs...
        </div>
      )}

      {isInitialLoading ? (
        <ExtractionListSkeleton />
      ) : error && !data ? (
        <div className="text-sm text-destructive">{errorMessage}</div>
      ) : runs.length === 0 ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          No extraction runs logged yet.
        </div>
      ) : (
        <div className="space-y-2">
          {runs.map(run => {
            const isOpen = expanded === run.runId
            const runRecords = recordsByRun[run.runId] ?? []
            const isLoadingRecords = loadingRunId === run.runId
            const runError = runErrors[run.runId]
            const review = reviewsByRun[run.runId]
            const reviewLoadingState = reviewLoading[run.runId] ?? false
            const reviewRunningState = reviewRunning[run.runId] ?? false
            const reviewError = reviewErrors[run.runId]
            const hasReviewLoaded = Object.prototype.hasOwnProperty.call(reviewsByRun, run.runId)

            return (
              <div
                key={run.runId}
                className="rounded-xl border border-border bg-card"
              >
                <button
                  onClick={() => handleToggle(run)}
                  className="w-full px-4 py-3 flex items-center gap-3 text-left"
                >
                  {isOpen ? (
                    <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
                  )}

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium truncate" title={run.sessionId}>
                        {truncateSessionId(run.sessionId)}
                      </span>
                      {run.parseErrorCount > 0 && (
                        <span className="text-[10px] uppercase tracking-wide text-destructive">
                          {run.parseErrorCount} parse errors
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {formatDateTime(run.timestamp)}
                    </div>
                  </div>

                  <div className="flex items-center gap-4 text-xs text-muted-foreground shrink-0">
                    <span>{run.recordCount} records</span>
                    <span>{formatDuration(run.duration)}</span>
                  </div>
                </button>

                <div className={`accordion-content ${isOpen ? 'open' : ''}`}>
                  <div className="accordion-inner">
                    <div className="px-4 pb-4 pt-0 space-y-3">
                      <div className="text-xs text-muted-foreground">
                        Transcript: <span className="font-mono break-all">{run.transcriptPath}</span>
                      </div>

                      <div className="rounded-lg border border-border bg-background/40 p-4 space-y-3">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div className="text-xs text-muted-foreground">
                            Opus review
                          </div>
                          <div className="flex items-center gap-2">
                            {review && (
                              <button
                                onClick={() => handleCopy(run, runRecords, review)}
                                className="inline-flex items-center gap-2 h-8 px-3 text-xs rounded-md border border-border bg-background hover:bg-secondary transition-base"
                                title="Copy review for Claude analysis"
                              >
                                {copied[run.runId] ? (
                                  <>
                                    <Check className="w-3 h-3 text-emerald-400" />
                                    Copied
                                  </>
                                ) : (
                                  <>
                                    <Copy className="w-3 h-3" />
                                    Copy Review
                                  </>
                                )}
                              </button>
                            )}
                            <button
                              onClick={() => handleReview(run.runId)}
                              disabled={reviewRunningState}
                              className="inline-flex items-center gap-2 h-8 px-3 text-xs rounded-md border border-border bg-background disabled:opacity-40 disabled:cursor-not-allowed hover:bg-secondary transition-base"
                            >
                              {reviewRunningState && <ButtonSpinner size="xs" />}
                              {reviewRunningState ? 'Reviewing...' : 'Review with Opus'}
                            </button>
                          </div>
                        </div>

                        {reviewError && (
                          <div className="text-xs text-destructive">{reviewError}</div>
                        )}

                        {review ? (
                          <div className="space-y-3">
                            <div className="flex flex-wrap items-center gap-3">
                              <span className={`text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full ${ACCURACY_STYLES[review.overallAccuracy].badge}`}>
                                {ACCURACY_STYLES[review.overallAccuracy].label}
                              </span>
                              <span className="text-xs text-muted-foreground">
                                Accuracy score <span className="font-semibold tabular-nums text-foreground">{review.accuracyScore}</span>
                              </span>
                              <span className="text-xs text-muted-foreground">
                                Reviewed {formatDateTime(review.reviewedAt)}
                              </span>
                            </div>
                            <div className="text-sm text-foreground">{review.summary}</div>

                            {review.issues.length === 0 ? (
                              <div className="text-xs text-muted-foreground">No issues flagged.</div>
                            ) : (
                              <div className="space-y-2">
                                {review.issues.map((issue, index) => {
                                  const issueSelectable = Boolean(issue.recordId)
                                  const issueClasses = `rounded-md border border-border bg-secondary/30 p-3 transition-base ${
                                    issueSelectable ? 'cursor-pointer hover:bg-secondary/50' : ''
                                  }`

                                  const issueContent = (
                                    <>
                                      <div className="flex flex-wrap items-center gap-2 mb-1">
                                        <span className={`text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full ${SEVERITY_STYLES[issue.severity]}`}>
                                          {issue.severity}
                                        </span>
                                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                                          {ISSUE_LABELS[issue.type]}
                                        </span>
                                        {issue.recordId && (
                                          <span className="text-[11px] text-muted-foreground font-mono">{issue.recordId}</span>
                                        )}
                                      </div>
                                      <div className="text-sm text-foreground">{issue.description}</div>
                                      <div className="text-xs text-muted-foreground font-mono whitespace-pre-wrap mt-1">
                                        {issue.evidence}
                                      </div>
                                      {issue.type === 'missed' && (
                                        <div className="text-xs text-emerald-300 font-mono mt-1">
                                          Suggested extraction: {issue.suggestedFix ?? issue.description}
                                        </div>
                                      )}
                                      {issue.type !== 'missed' && issue.suggestedFix && (
                                        <div className="text-xs text-muted-foreground font-mono mt-1">
                                          Suggested fix: {issue.suggestedFix}
                                        </div>
                                      )}
                                    </>
                                  )

                                  const recordId = issue.recordId
                                  if (issueSelectable && recordId) {
                                    return (
                                      <button
                                        key={`${issue.type}-${recordId}-${index}`}
                                        type="button"
                                        onClick={() => handleSelect(recordId)}
                                        className={`w-full text-left ${issueClasses}`}
                                      >
                                        {issueContent}
                                      </button>
                                    )
                                  }

                                  return (
                                    <div key={`${issue.type}-missing-${index}`} className={issueClasses}>
                                      {issueContent}
                                    </div>
                                  )
                                })}
                              </div>
                            )}
                          </div>
                        ) : hasReviewLoaded ? (
                          <div className="text-xs text-muted-foreground">No review yet.</div>
                        ) : reviewLoadingState ? (
                          <ReviewSkeleton />
                        ) : null}
                      </div>

                      {isLoadingRecords ? (
                        <RecordsSkeleton />
                      ) : runError ? (
                        <div className="text-sm text-destructive">{runError}</div>
                      ) : runRecords.length === 0 ? (
                        <div className="text-sm text-muted-foreground">No records extracted.</div>
                      ) : (
                        <div className="space-y-2">
                          {runRecords.map(record => {
                            const summary = truncate(getRecordSummary(record), 100)
                            const excerpt = record.sourceExcerpt
                              ? truncate(record.sourceExcerpt, 220)
                              : 'No source excerpt available.'

                            return (
                              <button
                                key={record.id}
                                type="button"
                                onClick={() => handleSelect(record.id)}
                                className="w-full text-left rounded-md border border-border bg-secondary/30 px-3 py-2 cursor-pointer hover:bg-secondary/50 transition-base"
                              >
                                <div className="flex items-center gap-2 mb-1">
                                  <span
                                    className="w-2 h-2 rounded-full"
                                    style={{ backgroundColor: TYPE_COLORS[record.type] }}
                                  />
                                  <span className="text-xs text-muted-foreground uppercase tracking-wide">
                                    {record.type}
                                  </span>
                                  <span className="text-xs text-muted-foreground font-mono truncate">
                                    {record.id}
                                  </span>
                                </div>
                                <div className="text-sm text-foreground mb-1 truncate">{summary}</div>
                                <div className="text-xs text-muted-foreground font-mono">{excerpt}</div>
                              </button>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div className="flex items-center justify-between">
        <button
          onClick={() => setPage(p => Math.max(0, p - 1))}
          disabled={page === 0}
          className="flex items-center gap-1 h-8 px-3 text-sm rounded-md border border-border bg-background disabled:opacity-40 disabled:cursor-not-allowed hover:bg-secondary transition-base"
        >
          Previous
        </button>
        <span className="text-sm text-muted-foreground">{pageInfo()}</span>
        <button
          onClick={() => setPage(p => p + 1)}
          disabled={total !== null && (page + 1) * PAGE_SIZE >= total}
          className="flex items-center gap-1 h-8 px-3 text-sm rounded-md border border-border bg-background disabled:opacity-40 disabled:cursor-not-allowed hover:bg-secondary transition-base"
        >
          Next
        </button>
      </div>

      <MemoryDetail
        record={selected}
        open={Boolean(selectedId)}
        loading={detailLoading}
        error={detailError}
        onClose={handleClose}
      />
    </div>
  )
}
