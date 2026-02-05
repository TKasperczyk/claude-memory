import { Check, Copy, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { formatDateTime } from '@/lib/format'
import { formatMaintenanceReview } from '@/lib/review-format'
import type { MaintenanceReview, OperationResult } from '@/lib/api'
import {
  ACTION_STYLES,
  buildSettingsRecommendationKey,
  RATING_STYLES,
  SETTINGS_RECOMMENDATION_STYLES,
  VERDICT_STYLES,
  type ApplyStatus,
  type MaintenanceOperation,
  type SettingsRecommendationItem
} from './shared'

export default function MaintenanceReviewDisplay({
  result,
  review,
  onSelect,
  onApplySetting,
  settingsApplyStatuses,
  settingsAppliedValues,
  applyDisabled = false
}: {
  result: OperationResult
  review: MaintenanceReview
  onSelect?: (id: string) => void
  onApplySetting?: (key: string, recommendation: SettingsRecommendationItem) => void
  settingsApplyStatuses?: Record<string, ApplyStatus>
  settingsAppliedValues?: Record<string, string | number>
  applyDisabled?: boolean
}) {
  const { copy, isCopied } = useCopyToClipboard(2000)
  const verdictGroups: Record<string, typeof review.actionVerdicts> = {}
  const operationKey = result.operation as MaintenanceOperation

  for (const verdict of review.actionVerdicts) {
    verdictGroups[verdict.verdict] = verdictGroups[verdict.verdict] || []
    verdictGroups[verdict.verdict].push(verdict)
  }

  return (
    <div className="rounded-lg border border-border bg-background/40 p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-xs text-muted-foreground">Opus review</div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => copy(result.operation, formatMaintenanceReview(result, review))}
          title="Copy review for Claude analysis"
        >
          {isCopied(result.operation) ? (
            <>
              <Check className="w-3 h-3 text-success" />
              Copied
            </>
          ) : (
            <>
              <Copy className="w-3 h-3" />
              Copy Review
            </>
          )}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <span className={`text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full ${RATING_STYLES[review.overallRating].badge}`}>
          {RATING_STYLES[review.overallRating].label}
        </span>
        <span className="text-xs text-muted-foreground">
          Assessment score <span className="font-semibold tabular-nums text-foreground">{review.assessmentScore}</span>
        </span>
        <span className="text-xs text-muted-foreground">
          Reviewed {formatDateTime(review.reviewedAt)}
        </span>
      </div>
      <div className="text-sm text-foreground">{review.summary}</div>

      <details className="rounded-md border border-border bg-secondary/20 p-3">
        <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Action verdicts ({review.actionVerdicts.length})
        </summary>
        <div className="mt-3 space-y-3">
          {review.actionVerdicts.length === 0 ? (
            <div className="text-xs text-muted-foreground">No action verdicts returned.</div>
          ) : (
            (['correct', 'questionable', 'incorrect'] as const).map(verdict => {
              const items = verdictGroups[verdict]
              if (!items?.length) return null

              return (
                <div key={verdict} className="space-y-2">
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">
                    {VERDICT_STYLES[verdict].label} ({items.length})
                  </div>
                  <div className="space-y-2">
                    {items.map((item, index) => {
                      const actionStyle = ACTION_STYLES[item.action]
                      const verdictStyle = VERDICT_STYLES[item.verdict]
                      const itemSelectable = Boolean(item.recordId && onSelect)
                      const itemClasses = `rounded-md border border-border bg-secondary/30 p-3 transition-base ${
                        itemSelectable ? 'cursor-pointer hover:bg-secondary/50' : ''
                      }`

                      const content = (
                        <>
                          <div className="flex flex-wrap items-center gap-2 mb-1">
                            <span className={`text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full ${verdictStyle.badge}`}>
                              {verdictStyle.label}
                            </span>
                            <span className={`text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full ${actionStyle.badge}`}>
                              {actionStyle.label}
                            </span>
                            {item.recordId && (
                              <span className="text-[11px] text-muted-foreground font-mono">{item.recordId}</span>
                            )}
                          </div>
                          <div className="text-sm text-foreground">{item.snippet}</div>
                          <div className="text-xs text-muted-foreground mt-1">{item.reason}</div>
                        </>
                      )

                      if (itemSelectable && item.recordId) {
                        const recordId = item.recordId
                        return (
                          <button
                            key={`${recordId}-${index}`}
                            type="button"
                            onClick={() => onSelect?.(recordId)}
                            className={`w-full text-left ${itemClasses}`}
                          >
                            {content}
                          </button>
                        )
                      }

                      return (
                        <div key={`${item.action}-${index}`} className={itemClasses}>
                          {content}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })
          )}
        </div>
      </details>

      <details className="rounded-md border border-border bg-secondary/20 p-3">
        <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Settings recommendations ({review.settingsRecommendations.length})
        </summary>
        <div className="mt-3 space-y-2">
          {review.settingsRecommendations.length === 0 ? (
            <div className="text-xs text-muted-foreground">No settings recommendations.</div>
          ) : (
            review.settingsRecommendations.map((rec, index) => {
              const style = SETTINGS_RECOMMENDATION_STYLES[rec.recommendation]
              const hasSuggestion = rec.suggestedValue !== undefined
              const applyKey = hasSuggestion
                ? buildSettingsRecommendationKey(operationKey, rec, index)
                : ''
              const status = applyKey ? settingsApplyStatuses?.[applyKey] : undefined
              const isApplying = status?.state === 'loading'
              const isApplied = status?.state === 'success'
              const currentValue = settingsAppliedValues?.[rec.setting] ?? rec.currentValue

              return (
                <div key={`${rec.setting}-${index}`} className="rounded-md border border-border bg-secondary/30 p-3 space-y-1">
                  <div className="flex flex-wrap items-center gap-2 mb-1">
                    <span className={`text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full ${style.badge}`}>
                      {style.label}
                    </span>
                    <span className="text-[11px] text-muted-foreground font-mono">{rec.setting}</span>
                    {isApplied && (
                      <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-success/15 text-success">
                        <Check className="w-3 h-3" aria-hidden="true" />
                        Applied
                      </span>
                    )}
                    {hasSuggestion && (
                      <span className="ml-auto flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="xs"
                          onClick={() => onApplySetting?.(applyKey, rec)}
                          disabled={applyDisabled || isApplying || isApplied}
                        >
                          {isApplying ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Apply'}
                        </Button>
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Current value <span className="font-mono text-foreground">{currentValue}</span>
                  </div>
                  {rec.suggestedValue !== undefined && (
                    <div className="text-xs text-muted-foreground">
                      Suggested value <span className="font-mono text-foreground">{rec.suggestedValue}</span>
                    </div>
                  )}
                  <div className="text-xs text-muted-foreground">{rec.reason}</div>
                  {status?.message && (
                    <div className={`text-xs ${status.state === 'error' ? 'text-destructive' : 'text-success'}`}>
                      {status.message}
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>
      </details>
    </div>
  )
}
