import { Check, Copy, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import ListItem from '@/components/ListItem'
import ReviewSkeleton from '@/components/ReviewSkeleton'
import ThinkingPanel from '@/components/ThinkingPanel'
import { useStreamingReview } from '@/hooks/useStreamingReview'
import { formatDateTime } from '@/lib/format'
import { formatExtractionReview } from '@/lib/review-format'
import type { ExtractionReview, ExtractionRun, MemoryRecord } from '@/lib/api'
import { ISSUE_LABELS, RATING_STYLES, SEVERITY_STYLES, getAccuracyBadge } from './utils'

export default function ExtractionReviewPanel({
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
            <Button
              variant="outline"
              size="xs"
              onClick={() => copy(run.runId, formatExtractionReview(run, runRecords, review))}
              title="Copy review"
            >
              {isCopied(run.runId) ? (
                <Check className="w-2.5 h-2.5 text-success" />
              ) : (
                <Copy className="w-2.5 h-2.5" />
              )}
              Copy
            </Button>
          )}
          <Button
            variant="outline"
            size="xs"
            onClick={handleReview}
            disabled={isStreaming}
          >
            {isStreaming && <Loader2 className="w-3 h-3 animate-spin" />}
            {isStreaming ? 'Reviewing...' : 'Review'}
          </Button>
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
                        <div className="text-[10px] text-success font-mono mt-1">
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
                      <ListItem key={`${issue.type}-${recordId}-${index}`} onClick={() => onSelect(recordId)}>
                        {issueContent}
                      </ListItem>
                    )
                  }

                  return (
                    <div
                      key={`${issue.type}-missing-${index}`}
                      className="rounded-lg border border-border bg-secondary/80 px-3 py-2"
                    >
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
