import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, ExternalLink, Loader2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import { PageHeader } from '@/App'
import {
  fetchExtractionReview,
  fetchExtractionRun,
  fetchExtractions,
  runExtractionReview,
  type ExtractionReview,
  type ExtractionReviewIssue,
  type ExtractionRun,
  type MemoryRecord
} from '@/lib/api'
import { formatDateTime, formatDuration } from '@/lib/format'

const PAGE_SIZE = 25

const TYPE_COLORS: Record<string, string> = {
  command: '#2dd4bf',
  error: '#f43f5e',
  discovery: '#60a5fa',
  procedure: '#a78bfa',
}

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

export default function Extractions() {
  const [runs, setRuns] = useState<ExtractionRun[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [offset, setOffset] = useState(0)
  const [total, setTotal] = useState<number | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [recordsByRun, setRecordsByRun] = useState<Record<string, MemoryRecord[]>>({})
  const [loadingRunId, setLoadingRunId] = useState<string | null>(null)
  const [runErrors, setRunErrors] = useState<Record<string, string>>({})
  const [reviewsByRun, setReviewsByRun] = useState<Record<string, ExtractionReview | null>>({})
  const [reviewLoading, setReviewLoading] = useState<Record<string, boolean>>({})
  const [reviewRunning, setReviewRunning] = useState<Record<string, boolean>>({})
  const [reviewErrors, setReviewErrors] = useState<Record<string, string>>({})

  useEffect(() => {
    let active = true

    const loadRuns = async () => {
      setLoading(true)
      setError(null)
      try {
        const response = await fetchExtractions({ limit: PAGE_SIZE, offset })
        if (!active) return
        setRuns(response.runs)
        setTotal(response.total)
      } catch (err) {
        if (!active) return
        setError(err instanceof Error ? err.message : 'Failed to load extractions')
      } finally {
        if (active) setLoading(false)
      }
    }

    loadRuns()
    return () => { active = false }
  }, [offset])

  const handleToggle = async (run: ExtractionRun) => {
    const isOpen = expanded === run.runId
    setExpanded(isOpen ? null : run.runId)

    if (!isOpen && !recordsByRun[run.runId] && !loadingRunId) {
      setLoadingRunId(run.runId)
      setRunErrors(prev => ({ ...prev, [run.runId]: '' }))
      try {
        const response = await fetchExtractionRun(run.runId)
        setRecordsByRun(prev => ({ ...prev, [run.runId]: response.records }))
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to load extraction'
        setRunErrors(prev => ({ ...prev, [run.runId]: message }))
      } finally {
        setLoadingRunId(null)
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

  const pageInfo = () => {
    if (loading) return 'Loading...'
    if (error) return 'Error'
    if (!runs.length) return 'No results'
    const start = offset + 1
    const end = offset + runs.length
    return total ? `${start}-${end} of ${total}` : `${start}-${end}`
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Extractions"
        description="Monitor extraction runs and review extracted records"
      />

      {loading && runs.length === 0 ? (
        <div className="text-sm text-muted-foreground">Loading...</div>
      ) : error ? (
        <div className="text-sm text-destructive">{error}</div>
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
                          <button
                            onClick={() => handleReview(run.runId)}
                            disabled={reviewRunningState}
                            className="inline-flex items-center gap-2 h-8 px-3 text-xs rounded-md border border-border bg-background disabled:opacity-40 disabled:cursor-not-allowed hover:bg-secondary transition-base"
                          >
                            {reviewRunningState && <Loader2 className="w-3 h-3 animate-spin" />}
                            {reviewRunningState ? 'Reviewing...' : 'Review with Opus'}
                          </button>
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
                                {review.issues.map((issue, index) => (
                                  <div
                                    key={`${issue.type}-${issue.recordId ?? 'missing'}-${index}`}
                                    className="rounded-md border border-border bg-secondary/30 p-3"
                                  >
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
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        ) : hasReviewLoaded ? (
                          <div className="text-xs text-muted-foreground">No review yet.</div>
                        ) : reviewLoadingState ? (
                          <div className="text-xs text-muted-foreground">Loading review...</div>
                        ) : null}
                      </div>

                      {isLoadingRecords ? (
                        <div className="text-sm text-muted-foreground">Loading records...</div>
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
                              <Link
                                key={record.id}
                                to={`/memories?id=${encodeURIComponent(record.id)}`}
                                className="block rounded-md border border-border bg-secondary/30 px-3 py-2 hover:bg-secondary/50 transition-base"
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
                                  <ExternalLink className="w-3 h-3 text-muted-foreground ml-auto" />
                                </div>
                                <div className="text-sm text-foreground mb-1 truncate">{summary}</div>
                                <div className="text-xs text-muted-foreground font-mono">{excerpt}</div>
                              </Link>
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
          onClick={() => setOffset(o => Math.max(0, o - PAGE_SIZE))}
          disabled={offset === 0}
          className="flex items-center gap-1 h-8 px-3 text-sm rounded-md border border-border bg-background disabled:opacity-40 disabled:cursor-not-allowed hover:bg-secondary transition-base"
        >
          Previous
        </button>
        <span className="text-sm text-muted-foreground">{pageInfo()}</span>
        <button
          onClick={() => setOffset(o => o + PAGE_SIZE)}
          disabled={total !== null && offset + PAGE_SIZE >= total}
          className="flex items-center gap-1 h-8 px-3 text-sm rounded-md border border-border bg-background disabled:opacity-40 disabled:cursor-not-allowed hover:bg-secondary transition-base"
        >
          Next
        </button>
      </div>
    </div>
  )
}
