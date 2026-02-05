import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import Skeleton from '@/components/Skeleton'
import ThinkingPanel from '@/components/ThinkingPanel'
import { useStreamingReview } from '@/hooks/useStreamingReview'
import { formatDuration } from '@/lib/format'
import {
  fetchMaintenanceReview,
  type MaintenanceAction,
  type MaintenanceReview,
  type OperationResult
} from '@/lib/api'
import ActionRow from './ActionRow'
import CandidateGroup from './CandidateGroup'
import MaintenanceReviewDisplay from './MaintenanceReviewDisplay'
import {
  buildActionKey,
  buildResultId,
  formatSummaryKey,
  getSuggestionPayload,
  type ApplyStatus,
  type MaintenanceOperation,
  type SettingsRecommendationItem
} from './shared'

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

export default function ResultPanel({
  result,
  onSelect,
  onApply,
  applyStatuses,
  applyDisabled = false,
  onApplySetting,
  settingsApplyStatuses,
  settingsAppliedValues
}: {
  result: OperationResult
  onSelect?: (id: string) => void
  onApply?: (key: string, action: MaintenanceAction) => void
  applyStatuses?: Record<string, ApplyStatus>
  applyDisabled?: boolean
  onApplySetting?: (key: string, recommendation: SettingsRecommendationItem) => void
  settingsApplyStatuses?: Record<string, ApplyStatus>
  settingsAppliedValues?: Record<string, string | number>
}) {
  const summaryEntries = Object.entries(result.summary)
  const candidateGroups = result.candidates ?? []
  const candidateCount = candidateGroups.reduce((total, group) => total + group.records.length, 0)
  const [review, setReview] = useState<MaintenanceReview | null>(null)
  const [cacheLoading, setCacheLoading] = useState(false)
  const [reviewError, setReviewError] = useState<string | null>(null)

  const reviewBody = useMemo(() => ({ result }), [result])

  const handleReviewComplete = useCallback((nextReview: MaintenanceReview) => {
    setReview(nextReview)
    setReviewError(null)
  }, [])

  const handleReviewError = useCallback((err: Error) => {
    setReviewError(err.message || 'Failed to run review')
  }, [])

  const {
    trigger: triggerReview,
    thinking,
    isStreaming,
    reset: resetStreaming
  } = useStreamingReview<MaintenanceReview>({
    endpoint: `/api/maintenance/${result.operation}/review`,
    body: reviewBody,
    onComplete: handleReviewComplete,
    onError: handleReviewError
  })

  const isReviewRunning = isStreaming
  const isReviewPending = (isReviewRunning || cacheLoading) && !review

  useEffect(() => {
    let isActive = true
    setReview(null)
    setReviewError(null)
    setCacheLoading(false)
    resetStreaming()

    const loadCachedReview = async () => {
      setCacheLoading(true)
      try {
        const resultId = await buildResultId(result)
        const cached = await fetchMaintenanceReview(result.operation, resultId)
        if (!isActive) return
        if (cached) {
          setReview(cached)
        }
      } catch (error) {
        if (!isActive) return
        const message = error instanceof Error ? error.message : 'Failed to load cached review'
        setReviewError(message)
      } finally {
        if (isActive) setCacheLoading(false)
      }
    }

    void loadCachedReview()

    return () => {
      isActive = false
    }
  }, [result, resetStreaming])

  const handleReview = () => {
    setReviewError(null)
    triggerReview()
  }

  return (
    <div className="mt-4 space-y-4 rounded-lg border border-border bg-background/40 p-4">
      <h4 className="section-header">Results</h4>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span>
            {result.dryRun ? 'Preview' : 'Executed'} in {formatDuration(result.duration)}
          </span>
          <Button
            variant="outline"
            size="xs"
            onClick={handleReview}
            disabled={isReviewRunning}
          >
            {isReviewRunning && <Loader2 className="w-3 h-3 animate-spin" />}
            {isReviewRunning ? 'Reviewing...' : 'Review with Opus'}
          </Button>
        </div>
        <div className="text-xs text-muted-foreground">
          {result.actions.length} actions
        </div>
      </div>

      {result.error && (
        <div className="text-sm text-destructive">Error: {result.error}</div>
      )}

      {summaryEntries.length > 0 && (
        <div className="flex flex-wrap gap-3">
          {summaryEntries.map(([key, value]) => (
            <div key={key} className="px-3 py-1.5 rounded-md border border-border bg-secondary/40">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                {formatSummaryKey(key)}
              </div>
              <div className="text-sm font-semibold tabular-nums">{value}</div>
            </div>
          ))}
        </div>
      )}

      {candidateCount > 0 && (
        <details className="rounded-md border border-border bg-secondary/20 p-3">
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            View candidates ({candidateCount})
          </summary>
          <div className="mt-3 space-y-3">
            {candidateGroups.map(group => (
              <CandidateGroup key={group.id} group={group} onSelect={onSelect} />
            ))}
          </div>
        </details>
      )}

      <ThinkingPanel thinking={thinking} isStreaming={isReviewRunning} />

      {reviewError && (
        <div className="text-xs text-destructive">{reviewError}</div>
      )}

      {review ? (
        <MaintenanceReviewDisplay
          result={result}
          review={review}
          onSelect={onSelect}
          onApplySetting={onApplySetting}
          settingsApplyStatuses={settingsApplyStatuses}
          settingsAppliedValues={settingsAppliedValues}
          applyDisabled={applyDisabled}
        />
      ) : (
        <div className="rounded-lg border border-border bg-background/40 p-4">
          {isReviewPending ? (
            <ReviewSkeleton />
          ) : (
            <div className="text-xs text-muted-foreground">No review yet.</div>
          )}
        </div>
      )}

      {result.actions.length === 0 ? (
        <div className="text-sm text-muted-foreground">No actions for this run.</div>
      ) : (
        <div className="space-y-2">
          {result.actions.map((action, index) => {
            const operationKey = result.operation as MaintenanceOperation
            const actionKey = buildActionKey(operationKey, action, index)
            const canApply = action.type === 'suggestion' && Boolean(getSuggestionPayload(action))
            const status = applyStatuses?.[actionKey]

            return (
              <ActionRow
                key={`${action.recordId ?? action.reason}-${index}`}
                action={action}
                onSelect={onSelect}
                executed={!result.dryRun}
                onApply={canApply && onApply ? selectedAction => onApply(actionKey, selectedAction) : undefined}
                applyStatus={status}
                applyDisabled={applyDisabled}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}
