import type { KeyboardEvent } from 'react'
import { Check, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { MaintenanceAction } from '@/lib/api'
import ActionDetails from './ActionDetails'
import { ACTION_STYLES, CONFLICT_STYLES, getConflictVerdict, type ApplyStatus } from './shared'

export default function ActionRow({
  action,
  onSelect,
  executed = false,
  onApply,
  applyStatus,
  applyDisabled = false
}: {
  action: MaintenanceAction
  onSelect?: (id: string) => void
  executed?: boolean
  onApply?: (action: MaintenanceAction) => void
  applyStatus?: ApplyStatus
  applyDisabled?: boolean
}) {
  const style = ACTION_STYLES[action.type]
  const recordId = action.recordId
  const conflictVerdict = getConflictVerdict(action.details)
  const candidateId = typeof action.details?.candidateId === 'string' ? action.details.candidateId : null
  const existingId = typeof action.details?.existingId === 'string' ? action.details.existingId : null
  const isCompleteConflict = Boolean(conflictVerdict && candidateId && existingId)
  const conflictStyle = isCompleteConflict && conflictVerdict ? CONFLICT_STYLES[conflictVerdict] : null
  const isSelectable = Boolean(recordId && onSelect)
  const isApplying = applyStatus?.state === 'loading'
  const isApplied = applyStatus?.state === 'success'
  const canApply = Boolean(onApply)

  const conflictClasses = conflictStyle
    ? `ring-1 ring-inset ${conflictStyle.ring} ${conflictStyle.background}`
    : ''

  const executedClasses = executed
    ? conflictStyle
      ? 'border-success/20'
      : 'border-success/20 bg-success/5 opacity-80'
    : ''

  const hoverClasses = isSelectable
    ? executed
      ? conflictStyle
        ? 'cursor-pointer hover:opacity-100'
        : 'cursor-pointer hover:bg-success/10 hover:opacity-100'
      : 'cursor-pointer hover:bg-secondary/50'
    : ''

  const containerClasses = `p-3 rounded-md border border-border bg-secondary/30 transition-base ${conflictClasses} ${
    hoverClasses
  } ${executedClasses}`

  const handleSelect = () => {
    if (recordId) {
      onSelect?.(recordId)
    }
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!isSelectable) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      handleSelect()
    }
  }

  return (
    <div
      className={containerClasses}
      onClick={isSelectable ? handleSelect : undefined}
      onKeyDown={isSelectable ? handleKeyDown : undefined}
      role={isSelectable ? 'button' : undefined}
      tabIndex={isSelectable ? 0 : undefined}
    >
      <div className="flex items-start gap-3">
        <span className={`mt-1 w-2 h-2 rounded-full ${style.dot}`} />
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <span className={`text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full ${style.badge}`}>
              {style.label}
            </span>
            {conflictStyle && (
              <span className={`text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full ${conflictStyle.badge}`}>
                {conflictStyle.label}
              </span>
            )}
            {executed && (
              <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-success/15 text-success">
                <Check className="w-3 h-3" aria-hidden="true" />
                Done
              </span>
            )}
            {isApplied && (
              <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-success/15 text-success">
                <Check className="w-3 h-3" aria-hidden="true" />
                Applied
              </span>
            )}
            {recordId && (
              <span className="text-[11px] text-muted-foreground font-mono">
                {recordId}
              </span>
            )}
            {canApply && (
              <span className="ml-auto flex items-center gap-2">
                <Button
                  variant="outline"
                  size="xs"
                  onClick={(event) => {
                    event.stopPropagation()
                    onApply?.(action)
                  }}
                  disabled={applyDisabled || isApplying || isApplied}
                >
                  {isApplying ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Apply'}
                </Button>
              </span>
            )}
          </div>
          <div className="text-sm text-foreground">{action.snippet}</div>
          <div className="text-xs text-muted-foreground">
            {conflictVerdict ? `LLM reason: ${action.reason}` : action.reason}
          </div>
          <ActionDetails details={action.details} onSelect={onSelect} />
          {applyStatus?.message && (
            <div className={`mt-2 text-xs ${applyStatus.state === 'error' ? 'text-destructive' : 'text-success'}`}>
              {applyStatus.message}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
