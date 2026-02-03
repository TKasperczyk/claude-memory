import { Check, Copy, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import ListItem from '@/components/ListItem'
import ReviewSkeleton from '@/components/ReviewSkeleton'
import ThinkingPanel from '@/components/ThinkingPanel'
import { useStreamingReview } from '@/hooks/useStreamingReview'
import { formatDateTime } from '@/lib/format'
import { formatInjectionReview } from '@/lib/review-format'
import type { InjectedMemoryVerdict, InjectionReview, SessionRecord } from '@/lib/api'

const RATING_STYLES: Record<InjectionReview['overallRating'], { badge: string; label: string }> = {
  good: {
    badge: 'bg-success/15 text-success',
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

const VERDICT_STYLES: Record<InjectedMemoryVerdict['verdict'], { badge: string; label: string }> = {
  relevant: {
    badge: 'bg-success/15 text-success',
    label: 'Relevant'
  },
  partially_relevant: {
    badge: 'bg-foreground/10 text-foreground/70',
    label: 'Partial'
  },
  irrelevant: {
    badge: 'bg-muted-foreground/15 text-muted-foreground',
    label: 'Irrelevant'
  },
  unknown: {
    badge: 'bg-muted-foreground/15 text-muted-foreground',
    label: 'Unknown'
  }
}

export default function SessionReviewPanel({
  session,
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
  session: SessionRecord
  review: InjectionReview | null
  reviewLoadingState: boolean
  reviewError?: string
  hasReviewLoaded: boolean
  onSelect: (recordId: string) => void
  onReviewUpdate: (sessionId: string, nextReview: InjectionReview) => void
  onReviewError: (sessionId: string, message: string) => void
  copy: (id: string, value: string) => void
  isCopied: (id: string) => boolean
}) {
  const { trigger, thinking, isStreaming } = useStreamingReview<InjectionReview>({
    endpoint: `/api/sessions/${session.sessionId}/review`,
    onComplete: (nextReview) => {
      onReviewUpdate(session.sessionId, nextReview)
      onReviewError(session.sessionId, '')
    },
    onError: (err) => {
      onReviewError(session.sessionId, err.message || 'Failed to run review')
    }
  })

  const handleReview = () => {
    onReviewError(session.sessionId, '')
    trigger()
  }

  return (
    <div className="rounded-lg border border-border bg-background/40 p-3 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Opus review</div>
        <div className="flex items-center gap-1.5">
          {review && (
            <Button
              variant="outline"
              size="xs"
              onClick={() => copy(session.sessionId, formatInjectionReview(session, review))}
              title="Copy review"
            >
              {isCopied(session.sessionId) ? <Check className="w-2.5 h-2.5 text-success" /> : <Copy className="w-2.5 h-2.5" />}
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
              Score <span className="font-semibold tabular-nums text-foreground">{review.relevanceScore}</span>
            </span>
            <span className="text-[10px] text-muted-foreground">{formatDateTime(review.reviewedAt)}</span>
          </div>
          <div className="text-xs text-foreground">{review.summary}</div>

          {review.injectedVerdicts.length > 0 && (
            <div className="space-y-1">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Verdicts</div>
              <div className="space-y-1 max-h-32 overflow-y-auto">
                {review.injectedVerdicts.map((verdict, index) => (
                  <ListItem
                    key={`${verdict.id}-${index}`}
                    onClick={() => onSelect(verdict.id)}
                    compact
                  >
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <span className={`text-[9px] uppercase tracking-wide px-1 py-0.5 rounded ${VERDICT_STYLES[verdict.verdict].badge}`}>
                        {VERDICT_STYLES[verdict.verdict].label}
                      </span>
                      <span className="text-[10px] text-muted-foreground font-mono truncate">{verdict.id.slice(0, 8)}</span>
                    </div>
                    <div className="text-[11px] text-foreground line-clamp-1">{verdict.snippet}</div>
                  </ListItem>
                ))}
              </div>
            </div>
          )}

          {review.missedMemories.length > 0 && (
            <div className="space-y-1">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Missed</div>
              <div className="space-y-1 max-h-24 overflow-y-auto">
                {review.missedMemories.map((missed, index) => (
                  <ListItem
                    key={`${missed.id}-${index}`}
                    onClick={() => onSelect(missed.id)}
                    compact
                  >
                    <span className="text-[10px] text-muted-foreground font-mono">{missed.id.slice(0, 8)}</span>
                    <div className="text-[11px] text-foreground line-clamp-1">{missed.snippet}</div>
                  </ListItem>
                ))}
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
