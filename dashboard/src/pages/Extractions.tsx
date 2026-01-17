import { useEffect, useMemo, useRef, useState } from 'react'
import { Activity, Check, ChevronRight, Copy, Sparkles } from 'lucide-react'
import ButtonSpinner from '@/components/ButtonSpinner'
import MemoryDetail from '@/components/MemoryDetail'
import MetricTile from '@/components/MetricTile'
import ReviewSkeleton from '@/components/ReviewSkeleton'
import ThinkingPanel from '@/components/ThinkingPanel'
import { useExtractions } from '@/hooks/queries'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { useSelectedMemory } from '@/hooks/useSelectedMemory'
import { useStreamingReview } from '@/hooks/useStreamingReview'
import Skeleton from '@/components/Skeleton'
import {
  fetchExtractionReview,
  fetchExtractionRun,
  type ExtractionReview,
  type ExtractionReviewIssue,
  type ExtractionRun,
  type MemoryRecord
} from '@/lib/api'
import { formatDateTime, formatDuration, formatRelativeTimeShortAgo, truncateText } from '@/lib/format'
import { TYPE_COLORS, getMemorySummary } from '@/lib/memory-ui'
import { formatExtractionReview } from '@/lib/review-format'

const PAGE_SIZE = 25

const RATING_STYLES: Record<ExtractionReview['overallRating'], { badge: string; label: string }> = {
  good: {
    badge: 'bg-emerald-500/15 text-emerald-400',
    label: 'Good'
  },
  mixed: {
    badge: 'bg-foreground/10 text-foreground/70',
    label: 'Mixed'
  },
  poor: {
    badge: 'bg-muted-foreground/15 text-muted-foreground',
    label: 'Poor'
  }
}

const SEVERITY_STYLES: Record<ExtractionReviewIssue['severity'], string> = {
  critical: 'bg-destructive/15 text-destructive',
  major: 'bg-amber-500/15 text-amber-400',
  minor: 'bg-muted-foreground/15 text-muted-foreground'
}

const ISSUE_LABELS: Record<ExtractionReviewIssue['type'], string> = {
  inaccurate: 'Inaccurate',
  partial: 'Partial',
  hallucinated: 'Hallucinated',
  missed: 'Missed',
  duplicate: 'Duplicate'
}

function truncateSessionId(sessionId: string): string {
  if (sessionId.length <= 10) return sessionId
  return `${sessionId.slice(0, 10)}...`
}

/**
 * Extract project name from transcript path.
 * Path format: /home/user/.claude/projects/-home-user-Programming-project-name/session.jsonl
 * The project directory is encoded with dashes replacing path separators.
 */
function extractProjectFromPath(transcriptPath: string | undefined): string {
  if (!transcriptPath) return 'Unknown'

  // Split path and find the projects directory segment
  const parts = transcriptPath.split(/[\\/]/)
  const projectsIdx = parts.findIndex(p => p === 'projects')
  if (projectsIdx === -1 || projectsIdx >= parts.length - 1) return 'Unknown'

  // Get the encoded project directory (e.g., "-home-user-Programming-project-name")
  const encodedDir = parts[projectsIdx + 1]
  if (!encodedDir || encodedDir.startsWith('.')) return 'Unknown'

  // The last segment after splitting by dash is typically the project name
  // But we need to handle multi-word project names (e.g., "claude-memory")
  // Strategy: take the last meaningful segment(s) after common path prefixes
  const segments = encodedDir.split('-').filter(Boolean)

  // Find where the actual project name starts (skip home, user, common dirs)
  const commonPrefixes = ['home', 'users', 'programming', 'projects', 'code', 'dev', 'src', 'work']
  let startIdx = 0
  for (let i = 0; i < segments.length; i++) {
    if (commonPrefixes.includes(segments[i].toLowerCase())) {
      startIdx = i + 1
    } else {
      break
    }
  }

  // Return the remaining segments joined, or the last segment if nothing remains
  const projectParts = segments.slice(startIdx)
  if (projectParts.length === 0) {
    return segments[segments.length - 1] || 'Unknown'
  }
  return projectParts.join('-')
}

function getAccuracyBadge(
  score: number | null | undefined
): { badge: string; text: string; label: string; title: string } {
  if (typeof score !== 'number') {
    return {
      badge: 'bg-muted-foreground/15 text-muted-foreground',
      text: 'text-muted-foreground',
      label: '—',
      title: 'Accuracy unavailable'
    }
  }

  const label = String(score)
  const title = `Accuracy score ${score}/100`

  if (score >= 85) {
    return { badge: 'bg-emerald-500/15 text-emerald-400', text: 'text-emerald-400', label, title }
  }
  if (score >= 60) {
    return { badge: 'bg-amber-500/15 text-amber-400', text: 'text-amber-400', label, title }
  }
  return { badge: 'bg-destructive/15 text-destructive', text: 'text-destructive', label, title }
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

function ExtractionListSkeleton() {
  const cards = Array.from({ length: 4 })

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)] xl:grid-cols-[minmax(0,380px)_minmax(0,1fr)] 2xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
      <div className="rounded-xl border border-border bg-card p-3">
        <div className="flex items-center justify-between mb-2">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 w-6" />
        </div>
        <div className="space-y-2">
          {cards.map((_, index) => (
            <div key={index} className="rounded-lg border border-border bg-card p-3 space-y-2">
              <div className="flex items-center gap-3">
                <Skeleton className="h-2.5 w-2.5 rounded-full" />
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-3 w-16 ml-auto" />
              </div>
              <Skeleton className="h-3 w-40" />
              <div className="flex gap-2">
                <Skeleton className="h-5 w-14" />
                <Skeleton className="h-5 w-20" />
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="rounded-xl border border-border bg-card p-4 space-y-3">
        <div className="rounded-lg border border-border bg-background/50 p-3 space-y-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-48" />
          <div className="flex gap-3">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-3 w-14" />
          </div>
        </div>
        <ReviewSkeleton />
        <div className="rounded-lg border border-border bg-background/40 p-3">
          <RecordsSkeleton />
        </div>
      </div>
    </div>
  )
}

function ExtractionReviewPanel({
  run,
  runRecords,
  review,
  reviewLoadingState,
  reviewError,
  hasReviewLoaded,
  onSelect,
  onReviewUpdate,
  onReviewError,
  copy,
  isCopied
}: {
  run: ExtractionRun
  runRecords: MemoryRecord[]
  review: ExtractionReview | null
  reviewLoadingState: boolean
  reviewError?: string
  hasReviewLoaded: boolean
  onSelect: (recordId: string) => void
  onReviewUpdate: (runId: string, nextReview: ExtractionReview) => void
  onReviewError: (runId: string, message: string) => void
  copy: (id: string, value: string) => void
  isCopied: (id: string) => boolean
}) {
  const { trigger, thinking, isStreaming } = useStreamingReview<ExtractionReview>({
    endpoint: `/api/extractions/${run.runId}/review`,
    onComplete: (nextReview) => {
      onReviewUpdate(run.runId, nextReview)
      onReviewError(run.runId, '')
    },
    onError: (err) => {
      onReviewError(run.runId, err.message || 'Failed to run review')
    }
  })

  const handleReview = () => {
    onReviewError(run.runId, '')
    trigger()
  }

  const accuracyBadge = review ? getAccuracyBadge(review.accuracyScore) : null

  return (
    <div className="rounded-lg border border-border bg-background/40 p-3 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Opus review</div>
        <div className="flex items-center gap-1.5">
          {review && (
            <button
              onClick={() => copy(run.runId, formatExtractionReview(run, runRecords, review))}
              className="inline-flex items-center gap-1 h-6 px-2 text-[10px] rounded border border-border bg-background hover:bg-secondary transition-base"
              title="Copy review"
            >
              {isCopied(run.runId) ? (
                <Check className="w-2.5 h-2.5 text-emerald-400" />
              ) : (
                <Copy className="w-2.5 h-2.5" />
              )}
              Copy
            </button>
          )}
          <button
            onClick={handleReview}
            disabled={isStreaming}
            className="inline-flex items-center gap-1 h-6 px-2 text-[10px] rounded border border-border bg-background disabled:opacity-40 disabled:cursor-not-allowed hover:bg-secondary transition-base"
          >
            {isStreaming && <ButtonSpinner size="xs" />}
            {isStreaming ? 'Reviewing...' : 'Review'}
          </button>
        </div>
      </div>

      <ThinkingPanel thinking={thinking} isStreaming={isStreaming} />

      {reviewError && (
        <div className="text-xs text-destructive">{reviewError}</div>
      )}

      {review ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded-full ${RATING_STYLES[review.overallRating].badge}`}>
              {RATING_STYLES[review.overallRating].label}
            </span>
            <span className="text-[10px] text-muted-foreground">
              Accuracy <span className={`font-semibold tabular-nums ${accuracyBadge?.text ?? 'text-muted-foreground'}`}>{accuracyBadge?.label ?? '—'}</span>
            </span>
            <span className="text-[10px] text-muted-foreground">{formatDateTime(review.reviewedAt)}</span>
          </div>
          <div className="text-xs text-foreground">{review.summary}</div>

          {review.issues.length === 0 ? (
            <div className="text-[11px] text-muted-foreground">No issues flagged.</div>
          ) : (
            <div className="space-y-1">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Issues</div>
              <div className="space-y-2">
                {review.issues.map((issue, index) => {
                  const issueSelectable = Boolean(issue.recordId)
                  const issueClasses = `rounded border border-border bg-secondary/30 p-2 transition-base ${
                    issueSelectable ? 'cursor-pointer hover:bg-secondary/50' : ''
                  }`

                  const issueContent = (
                    <>
                      <div className="flex flex-wrap items-center gap-1.5 mb-1">
                        <span className={`text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded-full ${SEVERITY_STYLES[issue.severity]}`}>
                          {issue.severity}
                        </span>
                        <span className="text-[9px] uppercase tracking-wide text-muted-foreground">
                          {ISSUE_LABELS[issue.type]}
                        </span>
                        {issue.recordId && (
                          <span className="text-[10px] text-muted-foreground font-mono">{issue.recordId}</span>
                        )}
                      </div>
                      <div className="text-xs text-foreground">{issue.description}</div>
                      <div className="text-[10px] text-muted-foreground font-mono whitespace-pre-wrap mt-1">
                        {issue.evidence}
                      </div>
                      {issue.type === 'missed' && (
                        <div className="text-[10px] text-emerald-400 font-mono mt-1">
                          Suggested extraction: {issue.suggestedFix ?? issue.description}
                        </div>
                      )}
                      {issue.type !== 'missed' && issue.suggestedFix && (
                        <div className="text-[10px] text-muted-foreground font-mono mt-1">
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
                        onClick={() => onSelect(recordId)}
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
            </div>
          )}
        </div>
      ) : hasReviewLoaded ? (
        <div className="text-[11px] text-muted-foreground">No review yet.</div>
      ) : reviewLoadingState ? (
        <ReviewSkeleton />
      ) : null}
    </div>
  )
}

function ExtractionRunCard({
  run,
  selected,
  review,
  hasReview,
  onSelect
}: {
  run: ExtractionRun
  selected: boolean
  review: ExtractionReview | null | undefined
  hasReview: boolean
  onSelect: (runId: string) => void
}) {
  const projectName = extractProjectFromPath(run.transcriptPath)
  const accuracyBadge = review ? getAccuracyBadge(review.accuracyScore) : null
  const hasErrors = run.parseErrorCount > 0
  const dotClass = hasErrors ? 'bg-destructive' : 'bg-muted-foreground/50'

  return (
    <button
      type="button"
      onClick={() => onSelect(run.runId)}
      className={`w-full text-left rounded-lg border px-3 py-2 transition-base ${
        selected
          ? 'border-foreground/40 bg-foreground/5 ring-1 ring-foreground/10'
          : 'border-border bg-card hover:border-foreground/20'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`h-2 w-2 rounded-full shrink-0 ${dotClass}`} />
          <span
            className="font-medium truncate direction-rtl text-left"
            title={run.transcriptPath || run.sessionId}
            style={{ direction: 'rtl', textAlign: 'left' }}
          >
            {projectName}
          </span>
        </div>
        <div className="flex items-center gap-1 text-[11px] text-muted-foreground shrink-0">
          <span>{formatRelativeTimeShortAgo(run.timestamp)}</span>
          {selected && <ChevronRight className="w-3.5 h-3.5 text-foreground" />}
        </div>
      </div>

      <div className="mt-1 flex items-center gap-2 flex-wrap">
        {accuracyBadge ? (
          <span
            className={`text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded-full ${accuracyBadge.badge}`}
            title={accuracyBadge.title}
          >
            Acc {accuracyBadge.label}
          </span>
        ) : hasReview ? (
          <span className="text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-muted-foreground/15 text-muted-foreground">
            No review
          </span>
        ) : null}
        {hasErrors && (
          <span className="text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-destructive/15 text-destructive">
            {run.parseErrorCount} parse {run.parseErrorCount === 1 ? 'error' : 'errors'}
          </span>
        )}
        <span className="text-[10px] text-muted-foreground ml-auto">
          <span className="text-foreground tabular-nums">{run.recordCount}</span> rec
          <span className="mx-1 text-muted-foreground/50">·</span>
          <span className="text-foreground tabular-nums">{formatDuration(run.duration)}</span>
        </span>
      </div>
    </button>
  )
}

export default function Extractions() {
  const [page, setPage] = useState(0)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const { selectedId, selected, detailLoading, detailError, handleSelect, handleClose } = useSelectedMemory()
  const [recordsByRun, setRecordsByRun] = useState<Record<string, MemoryRecord[]>>({})
  const [loadingRunId, setLoadingRunId] = useState<string | null>(null)
  const [runErrors, setRunErrors] = useState<Record<string, string>>({})
  const [reviewsByRun, setReviewsByRun] = useState<Record<string, ExtractionReview | null>>({})
  const [reviewLoading, setReviewLoading] = useState<Record<string, boolean>>({})
  const [reviewErrors, setReviewErrors] = useState<Record<string, string>>({})
  const { copy, isCopied } = useCopyToClipboard(2000)
  const loadSeqRef = useRef(0)

  const { data, error, isPending, isFetching } = useExtractions({ page, limit: PAGE_SIZE })
  const runs = data?.runs ?? []
  const total = data?.total ?? null
  const displayOffset = data?.offset ?? page * PAGE_SIZE
  const errorMessage = error instanceof Error ? error.message : 'Failed to load extractions'

  const pageInfo = () => {
    if (isPending && !data) return 'Loading...'
    if (error && !data) return 'Error'
    if (!runs.length) return 'No results'
    const start = displayOffset + 1
    const end = displayOffset + runs.length
    return total ? `${start}-${end} of ${total}` : `${start}-${end}`
  }

  const loadRunDetails = async (run: ExtractionRun) => {
    if (recordsByRun[run.runId]) return

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

  const loadReview = async (run: ExtractionRun) => {
    if (reviewLoading[run.runId]) return
    if (Object.prototype.hasOwnProperty.call(reviewsByRun, run.runId)) return

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

  useEffect(() => {
    if (runs.length === 0) {
      setSelectedRunId(null)
      return
    }
    if (selectedRunId && runs.some(run => run.runId === selectedRunId)) return
    setSelectedRunId(runs[0].runId)
  }, [runs, selectedRunId])

  const selectedRun = useMemo(() => {
    if (!selectedRunId) return null
    return runs.find(run => run.runId === selectedRunId) ?? null
  }, [runs, selectedRunId])

  useEffect(() => {
    if (!selectedRun) return
    void loadRunDetails(selectedRun)
    void loadReview(selectedRun)
  }, [selectedRun])

  const handleReviewUpdate = (runId: string, review: ExtractionReview) => {
    setReviewsByRun(prev => ({ ...prev, [runId]: review }))
  }

  const handleReviewError = (runId: string, message: string) => {
    setReviewErrors(prev => ({ ...prev, [runId]: message }))
  }

  const summary = useMemo(() => {
    let totalRecords = 0
    let totalErrors = 0
    let totalDuration = 0
    let latestTimestamp = 0

    for (const run of runs) {
      totalRecords += run.recordCount
      totalErrors += run.parseErrorCount
      totalDuration += run.duration
      if (run.timestamp > latestTimestamp) {
        latestTimestamp = run.timestamp
      }
    }

    return {
      totalRuns: runs.length,
      totalRecords,
      totalErrors,
      avgDuration: runs.length ? totalDuration / runs.length : 0,
      latestTimestamp
    }
  }, [runs])

  const isInitialLoading = isPending && runs.length === 0
  const isRefreshing = isFetching && !isInitialLoading

  if (error && !data) {
    return (
      <div className="text-sm text-destructive">{errorMessage}</div>
    )
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      {error && data && (
        <div className="bg-amber-500/10 text-amber-400 text-sm px-3 py-2 rounded mb-4 shrink-0">
          Failed to refresh data. Showing cached results.
        </div>
      )}

      {isRefreshing && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground shrink-0">
          <ButtonSpinner size="xs" className="text-muted-foreground" />
          Updating runs...
        </div>
      )}

      {isInitialLoading ? (
        <ExtractionListSkeleton />
      ) : runs.length === 0 ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          No extraction runs logged yet.
        </div>
      ) : (
        <div className="flex flex-col flex-1 min-h-0 gap-4">
          <section className="rounded-xl border border-border bg-card px-4 py-3 shrink-0">
            <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Sparkles className="h-3.5 w-3.5 text-emerald-400" />
                <span className="uppercase tracking-wide">Extraction pulse</span>
              </div>
              <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs">
                <span className="flex items-center gap-1.5">
                  <Activity className="h-3.5 w-3.5 text-emerald-400" />
                  <span className="text-foreground font-medium tabular-nums">{summary.totalRuns}</span>
                  <span className="text-muted-foreground">runs</span>
                </span>
                <span className="text-muted-foreground">·</span>
                <span>
                  <span className="text-foreground font-medium tabular-nums">{summary.totalRecords}</span>
                  <span className="text-muted-foreground ml-1">records</span>
                </span>
                <span className="text-muted-foreground">·</span>
                <span>
                  <span className={`font-medium tabular-nums ${summary.totalErrors > 0 ? 'text-destructive' : 'text-foreground'}`}>
                    {summary.totalErrors}
                  </span>
                  <span className="text-muted-foreground ml-1">parse errors</span>
                </span>
                <span className="text-muted-foreground">·</span>
                <span>
                  <span className="text-foreground font-medium tabular-nums">{formatDuration(summary.avgDuration)}</span>
                  <span className="text-muted-foreground ml-1">avg</span>
                </span>
                <span className="text-muted-foreground">·</span>
                <span>
                  <span className="text-foreground font-medium tabular-nums">
                    {summary.latestTimestamp ? formatRelativeTimeShortAgo(summary.latestTimestamp) : '—'}
                  </span>
                  <span className="text-muted-foreground ml-1">latest</span>
                </span>
              </div>
            </div>
          </section>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)] xl:grid-cols-[minmax(0,380px)_minmax(0,1fr)] 2xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)] flex-1 min-h-0">
            <section className="rounded-xl border border-border bg-card p-3 flex flex-col min-h-0">
              <div className="flex items-center justify-between mb-2">
                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Runs</div>
                <div className="text-[11px] text-muted-foreground">{runs.length}</div>
              </div>
              <div className="space-y-2 flex-1 min-h-0 lg:overflow-y-auto lg:pr-1">
                {runs.map(run => {
                  const review = reviewsByRun[run.runId]
                  const hasReview = Object.prototype.hasOwnProperty.call(reviewsByRun, run.runId)

                  return (
                    <ExtractionRunCard
                      key={run.runId}
                      run={run}
                      selected={run.runId === selectedRunId}
                      review={review}
                      hasReview={hasReview}
                      onSelect={setSelectedRunId}
                    />
                  )
                })}
              </div>
              <div className="mt-3 flex items-center justify-between">
                <button
                  onClick={() => setPage(p => Math.max(0, p - 1))}
                  disabled={page === 0}
                  className="flex items-center gap-1 h-7 px-2.5 text-[11px] rounded border border-border bg-background disabled:opacity-40 disabled:cursor-not-allowed hover:bg-secondary transition-base"
                >
                  Previous
                </button>
                <span className="text-[11px] text-muted-foreground">{pageInfo()}</span>
                <button
                  onClick={() => setPage(p => p + 1)}
                  disabled={total !== null && (page + 1) * PAGE_SIZE >= total}
                  className="flex items-center gap-1 h-7 px-2.5 text-[11px] rounded border border-border bg-background disabled:opacity-40 disabled:cursor-not-allowed hover:bg-secondary transition-base"
                >
                  Next
                </button>
              </div>
            </section>

            <section className="rounded-xl border border-border bg-card p-4 flex flex-col min-h-0">
              {!selectedRun ? (
                <div className="flex-1 flex flex-col items-center justify-center text-center text-sm text-muted-foreground">
                  Select an extraction run to view details.
                </div>
              ) : (
                (() => {
                  const runRecords = recordsByRun[selectedRun.runId] ?? []
                  const isLoadingRecords = loadingRunId === selectedRun.runId
                  const runError = runErrors[selectedRun.runId]
                  const review = reviewsByRun[selectedRun.runId] ?? null
                  const reviewLoadingState = reviewLoading[selectedRun.runId] ?? false
                  const reviewError = reviewErrors[selectedRun.runId]
                  const hasReviewLoaded = Object.prototype.hasOwnProperty.call(reviewsByRun, selectedRun.runId)
                  const accuracyBadge = review ? getAccuracyBadge(review.accuracyScore) : null
                  const transcriptPath = selectedRun.transcriptPath || '—'
                  const projectName = extractProjectFromPath(selectedRun.transcriptPath)

                  return (
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
                              Session {truncateSessionId(selectedRun.sessionId)}
                            </div>
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            {accuracyBadge && (
                              <span
                                className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-full ${accuracyBadge.badge}`}
                                title={accuracyBadge.title}
                              >
                                Acc {accuracyBadge.label}
                              </span>
                            )}
                            {selectedRun.parseErrorCount > 0 && (
                              <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-destructive/15 text-destructive">
                                {selectedRun.parseErrorCount} parse {selectedRun.parseErrorCount === 1 ? 'error' : 'errors'}
                              </span>
                            )}
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-2">
                          <MetricTile label="Records" value={selectedRun.recordCount} />
                          <MetricTile label="Duration" value={formatDuration(selectedRun.duration)} />
                          <MetricTile
                            label="Errors"
                            value={selectedRun.parseErrorCount}
                            valueClassName={selectedRun.parseErrorCount > 0 ? 'text-destructive' : undefined}
                          />
                          <MetricTile
                            label="Reviewed"
                            value={review ? formatRelativeTimeShortAgo(review.reviewedAt) : '—'}
                          />
                        </div>

                        <div className="text-[11px] text-muted-foreground">
                          Run {formatDateTime(selectedRun.timestamp)}
                        </div>
                      </div>

                      <div className="shrink-0">
                        <ExtractionReviewPanel
                          run={selectedRun}
                          runRecords={runRecords}
                          review={review}
                          reviewLoadingState={reviewLoadingState}
                          reviewError={reviewError}
                          hasReviewLoaded={hasReviewLoaded}
                          onSelect={handleSelect}
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
                            <div className="text-[11px] text-muted-foreground">{selectedRun.recordCount}</div>
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
                                      <span className="text-[11px] text-muted-foreground uppercase tracking-wide">
                                        {record.type}
                                      </span>
                                      <span className="text-[11px] text-muted-foreground font-mono truncate">
                                        {record.id}
                                      </span>
                                    </div>
                                    <div className="text-xs text-foreground mb-1 line-clamp-2">{summaryText}</div>
                                    <div className="text-[10px] text-muted-foreground font-mono line-clamp-2">{excerpt}</div>
                                  </button>
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
                              <span className="ml-2 font-mono text-foreground">{selectedRun.sessionId}</span>
                            </div>
                            <div>
                              <span className="text-muted-foreground">Run ID</span>
                              <span className="ml-2 font-mono text-foreground">{selectedRun.runId}</span>
                            </div>
                            <div>
                              <span className="text-muted-foreground">Started</span>
                              <span className="ml-2 text-foreground">{formatDateTime(selectedRun.timestamp)}</span>
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
                  )
                })()
              )}
            </section>
          </div>
        </div>
      )}

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
