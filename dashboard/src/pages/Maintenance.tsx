import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Check, Circle, Copy, Eye, Loader2, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import MemoryDetail from '@/components/MemoryDetail'
import Skeleton from '@/components/Skeleton'
import ThinkingPanel from '@/components/ThinkingPanel'
import { formatDateTime, formatDuration } from '@/lib/format'
import {
  ApiError,
  applyMaintenanceSuggestion,
  fetchMaintenanceOperations,
  fetchMaintenanceReview,
  runMaintenance,
  updateSetting,
  type ConflictVerdict,
  type MaintenanceAction,
  type MaintenanceActionType,
  type MaintenanceCandidateGroup,
  type MaintenanceCandidateRecord,
  type MaintenanceOperationInfo,
  type MaintenanceProgress,
  type MaintenanceReview,
  type OperationResult,
  type Settings
} from '@/lib/api'
import { useApi } from '@/hooks/useApi'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { useSelectedMemory } from '@/hooks/useSelectedMemory'
import { useStreamingReview } from '@/hooks/useStreamingReview'
import { formatMaintenanceReview } from '@/lib/review-format'

type MaintenanceOperation = MaintenanceOperationInfo['key']

type ConfirmState =
  | { mode: 'single'; operation: MaintenanceOperation }
  | { mode: 'all' }
  | null

type BulkProgressState = 'pending' | 'running' | 'completed'
type ApplyStatus = { state: 'loading' | 'success' | 'error'; message?: string }
type ApplyConfirmState = { key: string; action: MaintenanceAction } | null
type SettingsRecommendationItem = MaintenanceReview['settingsRecommendations'][number]
type SettingsApplyConfirmState = { key: string; recommendation: SettingsRecommendationItem } | null

const ACTION_STYLES: Record<MaintenanceActionType, { badge: string; dot: string; label: string }> = {
  deprecate: {
    badge: 'bg-destructive/15 text-destructive',
    dot: 'bg-destructive',
    label: 'Deprecate'
  },
  update: {
    badge: 'bg-info/15 text-info',
    dot: 'bg-info',
    label: 'Update'
  },
  merge: {
    badge: 'bg-primary/15 text-primary',
    dot: 'bg-primary',
    label: 'Merge'
  },
  promote: {
    badge: 'bg-success/15 text-success',
    dot: 'bg-success',
    label: 'Promote'
  },
  suggestion: {
    badge: 'bg-warning/15 text-warning',
    dot: 'bg-warning',
    label: 'Suggestion'
  }
}

const RATING_STYLES: Record<MaintenanceReview['overallRating'], { badge: string; label: string }> = {
  good: {
    badge: 'bg-success/15 text-success',
    label: 'Good'
  },
  mixed: {
    badge: 'bg-warning/15 text-warning',
    label: 'Mixed'
  },
  poor: {
    badge: 'bg-destructive/15 text-destructive',
    label: 'Poor'
  }
}

const VERDICT_STYLES: Record<MaintenanceReview['actionVerdicts'][number]['verdict'], { badge: string; label: string }> = {
  correct: {
    badge: 'bg-success/15 text-success',
    label: 'Correct'
  },
  questionable: {
    badge: 'bg-warning/15 text-warning',
    label: 'Questionable'
  },
  incorrect: {
    badge: 'bg-destructive/15 text-destructive',
    label: 'Incorrect'
  }
}

const SETTINGS_RECOMMENDATION_STYLES: Record<
  MaintenanceReview['settingsRecommendations'][number]['recommendation'],
  { badge: string; label: string }
> = {
  too_aggressive: {
    badge: 'bg-warning/15 text-warning',
    label: 'Too aggressive'
  },
  too_lenient: {
    badge: 'bg-destructive/15 text-destructive',
    label: 'Too lenient'
  },
  appropriate: {
    badge: 'bg-success/15 text-success',
    label: 'Appropriate'
  }
}

type ConflictStatus = 'kept' | 'deprecated'

const CONFLICT_STYLES: Record<ConflictVerdict, { badge: string; label: string; ring: string; background: string }> = {
  supersedes: {
    badge: 'bg-success/15 text-success',
    label: 'Supersedes',
    ring: 'ring-success/30',
    background: 'bg-success/5'
  },
  variant: {
    badge: 'bg-info/15 text-info',
    label: 'Variant',
    ring: 'ring-info/30',
    background: 'bg-info/5'
  },
  hallucination: {
    badge: 'bg-destructive/15 text-destructive',
    label: 'Hallucination',
    ring: 'ring-destructive/30',
    background: 'bg-destructive/5'
  }
}

const CONFLICT_STATUS_STYLES: Record<ConflictStatus, string> = {
  kept: 'bg-success/15 text-success',
  deprecated: 'bg-destructive/15 text-destructive'
}

function getConflictVerdict(details?: MaintenanceAction['details']): ConflictVerdict | null {
  const verdict = details?.verdict
  if (verdict === 'supersedes' || verdict === 'variant' || verdict === 'hallucination') {
    return verdict
  }
  return null
}

function formatSummaryKey(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]/g, ' ')
    .toLowerCase()
}

function buildOperationState<T>(
  operations: MaintenanceOperationInfo[],
  fallback: T,
  existing: Record<string, T> = {}
): Record<MaintenanceOperation, T> {
  return Object.fromEntries(
    operations.map(operation => [operation.key, existing[operation.key] ?? fallback])
  ) as Record<MaintenanceOperation, T>
}

function buildActionKey(operation: MaintenanceOperation, action: MaintenanceAction, index: number): string {
  const targetFile = typeof action.details?.targetFile === 'string' ? action.details?.targetFile : ''
  const actionType = typeof action.details?.action === 'string' ? action.details?.action : ''
  return `${operation}:${action.recordId ?? 'unknown'}:${actionType}:${targetFile}:${index}`
}

function buildSettingsRecommendationKey(
  operation: MaintenanceOperation,
  recommendation: SettingsRecommendationItem,
  index: number
): string {
  const suggestedValue = recommendation.suggestedValue === undefined ? 'none' : String(recommendation.suggestedValue)
  return `${operation}:${recommendation.setting}:${suggestedValue}:${index}`
}

function parseSsePayload(event: Event, eventName: string): Record<string, unknown> | null {
  if (!(event instanceof MessageEvent) || typeof event.data !== 'string') {
    return null
  }

  try {
    const payload = JSON.parse(event.data) as unknown
    if (payload && typeof payload === 'object') {
      return payload as Record<string, unknown>
    }
    console.error(`[maintenance] Ignoring malformed SSE payload for "${eventName}" event`)
    return null
  } catch (error) {
    console.error(`[maintenance] Failed to parse SSE payload for "${eventName}" event`, error)
    return null
  }
}

function isOperationResult(value: unknown): value is OperationResult {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<OperationResult>
  return typeof candidate.operation === 'string'
    && typeof candidate.dryRun === 'boolean'
    && Array.isArray(candidate.actions)
    && typeof candidate.summary === 'object'
    && candidate.summary !== null
    && Array.isArray(candidate.candidates)
    && typeof candidate.duration === 'number'
}

// Fallback hash for non-secure contexts where crypto.subtle is unavailable (HTTP, non-localhost)
function simpleHash(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash
  }
  return Math.abs(hash).toString(16).padStart(8, '0')
}

async function buildResultId(result: OperationResult): Promise<string> {
  const actionIds = result.actions.map(action => action.recordId).filter(Boolean).join(',')
  const candidateIds = result.candidates
    .map(group => {
      const recordIds = group.records.map(record => record.id).filter(Boolean).join(',')
      return `${group.id}:${recordIds}`
    })
    .join('|')
  const payload = [
    result.operation,
    String(result.dryRun),
    JSON.stringify(result.summary),
    actionIds,
    candidateIds
  ].join('|')

  if (crypto.subtle) {
    const data = new TextEncoder().encode(payload)
    const hashBuffer = await crypto.subtle.digest('SHA-256', data)
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    return hashArray.map(byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 16)
  }
  return simpleHash(payload).slice(0, 16)
}

function getSuggestionPayload(action: MaintenanceAction): {
  recordId: string
  action: 'new' | 'edit'
  targetFile: string
  diff: string
} | null {
  const details = action.details
  if (!details || typeof details !== 'object') return null
  if (!action.recordId || typeof action.recordId !== 'string') return null
  if (details.action !== 'new' && details.action !== 'edit') return null
  if (typeof details.targetFile !== 'string' || details.targetFile.trim().length === 0) return null
  if (typeof details.diff !== 'string' || details.diff.trim().length === 0) return null
  return {
    recordId: action.recordId,
    action: details.action,
    targetFile: details.targetFile,
    diff: details.diff
  }
}

function getDiffStats(diff: string): { addedLines: number; deletedLines: number; hasHunk: boolean } {
  const lines = diff.replace(/\r\n/g, '\n').split('\n')
  let inHunk = false
  let hasHunk = false
  let addedLines = 0
  let deletedLines = 0

  for (const line of lines) {
    if (line.startsWith('@@')) {
      inHunk = true
      hasHunk = true
      continue
    }
    if (!inHunk) continue
    if (line.startsWith('+++ ') || line.startsWith('--- ') || line.startsWith('diff ')) continue
    if (line.startsWith('+')) {
      addedLines += 1
      continue
    }
    if (line.startsWith('-')) {
      deletedLines += 1
    }
  }

  return { addedLines, deletedLines, hasHunk }
}

function RecordLink({
  id,
  onSelect,
  className,
  stopPropagation = false
}: {
  id: string
  onSelect?: (id: string) => void
  className?: string
  stopPropagation?: boolean
}) {
  const classes = [className, onSelect ? 'transition-base hover:text-foreground' : null]
    .filter(Boolean)
    .join(' ')

  if (!onSelect) {
    return <span className={classes}>{id}</span>
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (stopPropagation && (event.key === 'Enter' || event.key === ' ')) {
      event.stopPropagation()
    }
  }

  return (
    <button
      type="button"
      onClick={(event) => {
        if (stopPropagation) event.stopPropagation()
        onSelect(id)
      }}
      onKeyDown={handleKeyDown}
      className={classes}
    >
      {id}
    </button>
  )
}

function StatusBadge({ status }: { status: ConflictStatus }) {
  return (
    <span className={`text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full ${CONFLICT_STATUS_STYLES[status]}`}>
      {status}
    </span>
  )
}

function renderDetails(details?: MaintenanceAction['details'], onSelect?: (id: string) => void) {
  if (!details) return null

  const before = typeof details.before === 'string' ? details.before : null
  const after = typeof details.after === 'string' ? details.after : null
  const diff = typeof details.diff === 'string' ? details.diff : null
  const targetFile = typeof details.targetFile === 'string' ? details.targetFile : null
  const action = details.action === 'new' || details.action === 'edit' ? details.action : null
  const decisionReason = typeof details.decisionReason === 'string' ? details.decisionReason : null
  const verdict = getConflictVerdict(details)
  const candidateId = typeof details.candidateId === 'string' ? details.candidateId : null
  const existingId = typeof details.existingId === 'string' ? details.existingId : null
  const isCompleteConflict = Boolean(verdict && candidateId && existingId)
  const conflictStyle = isCompleteConflict && verdict ? CONFLICT_STYLES[verdict] : null
  const deprecatedRecords = Array.isArray(details.deprecatedRecords) ? details.deprecatedRecords : null
  const deprecatedIds = Array.isArray(details.deprecatedIds) ? details.deprecatedIds : null
  const keptId = typeof details.keptId === 'string' ? details.keptId : null
  const newerId = typeof details.newerId === 'string' ? details.newerId : null
  const similarity = typeof details.similarity === 'number' ? details.similarity : null
  const hasDeprecatedRecords = Boolean(deprecatedRecords && deprecatedRecords.length > 0)
  const hasDeprecatedIds = Boolean(!hasDeprecatedRecords && deprecatedIds && deprecatedIds.length > 0)

  if (
    !before
    && !after
    && !diff
    && !hasDeprecatedRecords
    && !hasDeprecatedIds
    && !newerId
    && similarity === null
    && !isCompleteConflict
  ) {
    return null
  }

  const diffLines = diff ? diff.split('\n') : []
  let candidateStatus: ConflictStatus | null = null
  let existingStatus: ConflictStatus | null = null
  let outcomeText: string | null = null

  if (verdict === 'supersedes') {
    candidateStatus = 'kept'
    existingStatus = 'deprecated'
    outcomeText = 'Outcome: New replaces existing.'
  } else if (verdict === 'hallucination') {
    candidateStatus = 'deprecated'
    existingStatus = 'kept'
    outcomeText = 'Outcome: Existing kept, new deprecated.'
  } else if (verdict === 'variant') {
    candidateStatus = 'kept'
    existingStatus = 'kept'
    outcomeText = 'Outcome: Keep both.'
  }

  return (
    <div className="mt-2 text-xs text-muted-foreground space-y-2">
      {isCompleteConflict && verdict && conflictStyle && (
        <div className="rounded-md border border-border/60 bg-background/60 px-3 py-2 space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground/70">
            <span>Conflict resolution</span>
            <span className={`text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full ${conflictStyle.badge}`}>
              {conflictStyle.label}
            </span>
          </div>
          <div className="space-y-1 text-[11px] text-muted-foreground/80">
            {candidateId && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">New</span>
                <RecordLink
                  id={candidateId}
                  onSelect={onSelect}
                  stopPropagation
                  className="font-mono text-[11px] text-muted-foreground"
                />
                {candidateStatus && <StatusBadge status={candidateStatus} />}
              </div>
            )}
            {existingId && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">Existing</span>
                <RecordLink
                  id={existingId}
                  onSelect={onSelect}
                  stopPropagation
                  className="font-mono text-[11px] text-muted-foreground"
                />
                {existingStatus && <StatusBadge status={existingStatus} />}
              </div>
            )}
            {outcomeText && (
              <div className="text-[11px] text-muted-foreground/80">{outcomeText}</div>
            )}
          </div>
        </div>
      )}
      {before && after && (
        <>
          <div className="font-mono">before: {before}</div>
          <div className="font-mono">after: {after}</div>
        </>
      )}
      {hasDeprecatedRecords && deprecatedRecords && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground/70">
            <span>Duplicates being merged</span>
            {keptId && (
              <span className="flex items-center gap-1 normal-case text-muted-foreground/60">
                <span aria-hidden="true">&rarr;</span>
                <span className="text-[10px] uppercase tracking-wide">kept</span>
                <RecordLink
                  id={keptId}
                  onSelect={onSelect}
                  stopPropagation
                  className="font-mono text-[11px] text-muted-foreground"
                />
              </span>
            )}
          </div>
          <div className="space-y-2">
            {deprecatedRecords.map(record => (
              <div
                key={record.id}
                className="rounded-md border border-border/60 bg-secondary/30 px-2 py-1.5"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-muted-foreground/50">&rarr;</span>
                  <RecordLink
                    id={record.id}
                    onSelect={onSelect}
                    stopPropagation
                    className="font-mono text-[11px] line-through text-muted-foreground/70"
                  />
                </div>
                {record.snippet && (
                  <div className="mt-1 text-muted-foreground/60">
                    {record.snippet}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      {hasDeprecatedIds && deprecatedIds && (
        <div className="font-mono">merged: {deprecatedIds.join(', ')}</div>
      )}
      {newerId && (
        <div className="font-mono">kept: {newerId}{similarity !== null ? ` (sim ${similarity.toFixed(2)})` : ''}</div>
      )}
      {(action || targetFile) && (
        <div className="flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground/70">
          {action && (
            <span className="rounded-full border border-border/60 px-2 py-0.5 text-[10px] uppercase tracking-wide">
              {action}
            </span>
          )}
          {targetFile && (
            <span className="font-mono normal-case text-muted-foreground">
              {targetFile}
            </span>
          )}
        </div>
      )}
      {decisionReason && (
        <div className="text-[11px] text-muted-foreground/80">Reason: {decisionReason}</div>
      )}
      {diff && (
        <div className="overflow-hidden rounded-md border border-border/60 bg-background/60">
          <div className="max-h-80 overflow-auto text-[11px] font-mono">
            {diffLines.map((line, index) => {
              const content = line || ' '
              let className = 'whitespace-pre px-3 py-0.5 text-muted-foreground/80'
              if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff')) {
                className = 'whitespace-pre px-3 py-0.5 text-muted-foreground'
              } else if (line.startsWith('@@')) {
                className = 'whitespace-pre px-3 py-0.5 text-muted-foreground'
              } else if (line.startsWith('+')) {
                className = 'whitespace-pre px-3 py-0.5 text-success bg-success/10'
              } else if (line.startsWith('-')) {
                className = 'whitespace-pre px-3 py-0.5 text-destructive bg-destructive/10'
              }
              return (
                <div key={`${index}-${line.slice(0, 8)}`} className={className}>
                  {content}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

function ActionRow({
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

  const content = (
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
        {renderDetails(action.details, onSelect)}
        {applyStatus?.message && (
          <div className={`mt-2 text-xs ${applyStatus.state === 'error' ? 'text-destructive' : 'text-success'}`}>
            {applyStatus.message}
          </div>
        )}
      </div>
    </div>
  )

  return (
    <div
      className={containerClasses}
      onClick={isSelectable ? handleSelect : undefined}
      onKeyDown={isSelectable ? handleKeyDown : undefined}
      role={isSelectable ? 'button' : undefined}
      tabIndex={isSelectable ? 0 : undefined}
    >
      {content}
    </div>
  )
}

function formatCandidateDetails(details?: MaintenanceCandidateRecord['details']): string[] {
  if (!details || typeof details !== 'object') return []
  const meta: string[] = []
  if (typeof details.similarity === 'number') {
    meta.push(`sim ${details.similarity.toFixed(2)}`)
  }
  if (typeof details.ageDays === 'number') {
    meta.push(`age ${details.ageDays}d`)
  }
  if (typeof details.scope === 'string') {
    meta.push(`scope ${details.scope}`)
  }
  if (typeof details.retrievalCount === 'number') {
    meta.push(`retrievals ${details.retrievalCount}`)
  }
  if (typeof details.usageCount === 'number') {
    meta.push(`usage ${details.usageCount}`)
  }
  if (typeof details.ratio === 'number') {
    meta.push(`ratio ${Math.round(details.ratio * 100)}%`)
  }
  if (typeof details.failureCount === 'number') {
    meta.push(`failures ${details.failureCount}`)
  }
  return meta
}

function CandidateRow({
  record,
  onSelect
}: {
  record: MaintenanceCandidateRecord
  onSelect?: (id: string) => void
}) {
  const meta = formatCandidateDetails(record.details)
  return (
    <div className="rounded-md border border-border bg-background/60 p-3 space-y-1">
      <div className="flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-wide text-muted-foreground/80">
        <span className="font-mono normal-case text-foreground/80">
          <RecordLink id={record.id} onSelect={onSelect} stopPropagation />
        </span>
        <span>{record.type}</span>
        {meta.length > 0 && (
          <span className="flex flex-wrap gap-1 text-[10px] normal-case">
            {meta.map((item, index) => (
              <span
                key={`${record.id}-${index}`}
                className="rounded-full border border-border/60 px-2 py-0.5 text-muted-foreground/80"
              >
                {item}
              </span>
            ))}
          </span>
        )}
      </div>
      <div className="text-sm text-foreground">{record.snippet}</div>
      <div className="text-xs text-muted-foreground">{record.reason}</div>
    </div>
  )
}

function CandidateGroup({
  group,
  onSelect
}: {
  group: MaintenanceCandidateGroup
  onSelect?: (id: string) => void
}) {
  return (
    <div className="rounded-md border border-border bg-secondary/20 p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground">
        <span>{group.label}</span>
        {group.reason && (
          <span className="text-xs normal-case text-muted-foreground/70">{group.reason}</span>
        )}
      </div>
      <div className="space-y-2">
        {group.records.map(record => (
          <CandidateRow key={record.id} record={record} onSelect={onSelect} />
        ))}
      </div>
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

function MaintenanceReviewDisplay({
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

function ResultPanel({
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
  }, [setReview, setReviewError])
  const handleReviewError = useCallback((err: Error) => {
    setReviewError(err.message || 'Failed to run review')
  }, [setReviewError])
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

  const handleReview = async () => {
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
                onApply={canApply && onApply ? (selectedAction) => onApply(actionKey, selectedAction) : undefined}
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

export default function Maintenance() {
  const { data: operationsData, error: operationsError, loading: operationsLoading } = useApi(fetchMaintenanceOperations, [])
  const operations = operationsData?.operations ?? []

  const [results, setResults] = useState<Record<MaintenanceOperation, OperationResult | null>>({})
  const [running, setRunning] = useState<Record<MaintenanceOperation, boolean>>({})
  const [runningMode, setRunningMode] = useState<Record<MaintenanceOperation, 'preview' | 'run' | null>>({})
  const [bulkRunning, setBulkRunning] = useState(false)
  const [bulkMode, setBulkMode] = useState<'preview' | 'run' | null>(null)
  const [bulkProgress, setBulkProgress] = useState<Record<MaintenanceOperation, BulkProgressState> | null>(null)
  const [detailedProgress, setDetailedProgress] = useState<Record<MaintenanceOperation, MaintenanceProgress> | null>(null)
  const [bulkError, setBulkError] = useState<string | null>(null)
  const [confirmState, setConfirmState] = useState<ConfirmState>(null)
  const [applyConfirm, setApplyConfirm] = useState<ApplyConfirmState>(null)
  const [applyStatuses, setApplyStatuses] = useState<Record<string, ApplyStatus>>({})
  const [applyError, setApplyError] = useState<string | null>(null)
  const [applyConflict, setApplyConflict] = useState(false)
  const [settingsApplyConfirm, setSettingsApplyConfirm] = useState<SettingsApplyConfirmState>(null)
  const [settingsApplyStatuses, setSettingsApplyStatuses] = useState<Record<string, ApplyStatus>>({})
  const [settingsAppliedValues, setSettingsAppliedValues] = useState<Record<string, string | number>>({})
  const [settingsApplyError, setSettingsApplyError] = useState<string | null>(null)
  const {
    selectedId,
    selected,
    detailLoading,
    detailError,
    handleSelect: selectMemory,
    handleClose: closeMemory
  } = useSelectedMemory()
  const eventSourceRef = useRef<EventSource | null>(null)
  const activeApply = applyConfirm
  const activeApplyKey = activeApply?.key ?? ''
  const applyLoading = activeApplyKey ? applyStatuses[activeApplyKey]?.state === 'loading' : false
  const applyPayload = activeApply ? getSuggestionPayload(activeApply.action) : null
  const applyStats = applyPayload ? getDiffStats(applyPayload.diff) : null
  const activeSettingsApply = settingsApplyConfirm
  const activeSettingsApplyKey = activeSettingsApply?.key ?? ''
  const settingsApplyLoading = activeSettingsApplyKey
    ? settingsApplyStatuses[activeSettingsApplyKey]?.state === 'loading'
    : false

  useEffect(() => {
    if (operations.length === 0) return
    setResults(prev => buildOperationState(operations, null, prev))
    setRunning(prev => buildOperationState(operations, false, prev))
    setRunningMode(prev => buildOperationState(operations, null, prev))
  }, [operations])

  useEffect(() => {
    return () => {
      eventSourceRef.current?.close()
      eventSourceRef.current = null
    }
  }, [])

  const setOperationRunning = (operation: MaintenanceOperation, isRunning: boolean) => {
    setRunning(prev => ({ ...prev, [operation]: isRunning }))
  }

  const handleRunOperation = async (operation: MaintenanceOperation, dryRun: boolean) => {
    setOperationRunning(operation, true)
    setRunningMode(prev => ({ ...prev, [operation]: dryRun ? 'preview' : 'run' }))

    // Use streaming for operations that support progress
    const supportsProgress = operation === 'consolidation' || operation === 'cross-type-consolidation'

    if (supportsProgress) {
      // Use SSE streaming for progress
      if (eventSourceRef.current) {
        eventSourceRef.current.close()
        eventSourceRef.current = null
      }

      const eventSource = new EventSource(`/api/maintenance/stream?dryRun=${dryRun}&operation=${operation}`)
      eventSourceRef.current = eventSource

      eventSource.addEventListener('detailed-progress', (event) => {
        const data = parseSsePayload(event, 'detailed-progress')
        if (!data || typeof data.operation !== 'string') return
        const current = data.current
        const total = data.total
        if (
          typeof current !== 'number' ||
          !Number.isFinite(current) ||
          typeof total !== 'number' ||
          !Number.isFinite(total)
        ) {
          return
        }

        const op = data.operation as MaintenanceOperation
        setDetailedProgress(prev => ({
          ...(prev || {}),
          [op]: {
            current,
            total,
            message: typeof data.message === 'string' ? data.message : undefined
          }
        }))
      })

      eventSource.addEventListener('result', (event) => {
        const data = parseSsePayload(event, 'result')
        if (!data || !isOperationResult(data)) return
        const result = data
        if (result.operation === operation) {
          setDetailedProgress(prev => {
            if (!prev) return null
            const { [operation]: _, ...rest } = prev
            return Object.keys(rest).length > 0 ? rest as Record<MaintenanceOperation, MaintenanceProgress> : null
          })
          setResults(prev => ({ ...prev, [operation]: result }))
        }
      })

      eventSource.addEventListener('error', (event) => {
        const data = parseSsePayload(event, 'error')
        if (data) {
          const message = typeof data.error === 'string'
            ? data.error
            : 'Failed to run maintenance operation'
          setResults(prev => ({
            ...prev,
            [operation]: {
              operation,
              dryRun,
              actions: [],
              summary: {},
              candidates: [],
              duration: 0,
              error: message
            }
          }))
        }
      })

      eventSource.addEventListener('complete', () => {
        setOperationRunning(operation, false)
        setRunningMode(prev => ({ ...prev, [operation]: null }))
        eventSource.close()
        eventSourceRef.current = null
      })

      eventSource.onerror = () => {
        setOperationRunning(operation, false)
        setRunningMode(prev => ({ ...prev, [operation]: null }))
        setDetailedProgress(prev => {
          if (!prev) return null
          const { [operation]: _, ...rest } = prev
          return Object.keys(rest).length > 0 ? rest as Record<MaintenanceOperation, MaintenanceProgress> : null
        })
        eventSource.close()
        eventSourceRef.current = null
      }
    } else {
      // Use non-streaming for operations without progress
      try {
        const result = await runMaintenance(operation, dryRun)
        setResults(prev => ({ ...prev, [operation]: result }))
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to run maintenance operation'
        setResults(prev => ({
          ...prev,
          [operation]: {
            operation,
            dryRun,
            actions: [],
            summary: {},
            candidates: [],
            duration: 0,
            error: message
          }
        }))
      } finally {
        setOperationRunning(operation, false)
        setRunningMode(prev => ({ ...prev, [operation]: null }))
      }
    }
  }

  const handleRunAll = (dryRun: boolean) => {
    if (operations.length === 0) return
    setBulkRunning(true)
    setBulkMode(dryRun ? 'preview' : 'run')
    setBulkError(null)
    // Initialize all operations as pending
    setBulkProgress(
      Object.fromEntries(operations.map(op => [op.key, 'pending'])) as Record<MaintenanceOperation, BulkProgressState>
    )

    // Use SSE streaming endpoint for real-time progress
    if (eventSourceRef.current) {
      eventSourceRef.current.close()
      eventSourceRef.current = null
    }

    const eventSource = new EventSource(`/api/maintenance/stream?dryRun=${dryRun}`)
    eventSourceRef.current = eventSource

    eventSource.addEventListener('progress', (event) => {
      const data = parseSsePayload(event, 'progress')
      if (data && typeof data.operation === 'string') {
        const op = data.operation as MaintenanceOperation
        setBulkProgress(prev => prev ? { ...prev, [op]: 'running' } : null)
      }
    })

    eventSource.addEventListener('detailed-progress', (event) => {
      const data = parseSsePayload(event, 'detailed-progress')
      if (!data || typeof data.operation !== 'string') return
      const current = data.current
      const total = data.total
      if (
        typeof current !== 'number' ||
        !Number.isFinite(current) ||
        typeof total !== 'number' ||
        !Number.isFinite(total)
      ) {
        return
      }

      const op = data.operation as MaintenanceOperation
      setDetailedProgress(prev => ({
        ...(prev || {}),
        [op]: {
          current,
          total,
          message: typeof data.message === 'string' ? data.message : undefined
        }
      }))
    })

    eventSource.addEventListener('result', (event) => {
      const data = parseSsePayload(event, 'result')
      if (!data || !isOperationResult(data)) return
      const result = data
      if (result.operation) {
        const op = result.operation as MaintenanceOperation
        setBulkProgress(prev => prev ? { ...prev, [op]: 'completed' } : null)
        setDetailedProgress(prev => {
          if (!prev) return null
          const { [op]: _, ...rest } = prev
          return Object.keys(rest).length > 0 ? rest as Record<MaintenanceOperation, MaintenanceProgress> : null
        })
        setResults(prev => ({
          ...prev,
          [op]: result
        }))
      }
    })

    eventSource.addEventListener('error', (event) => {
      const data = parseSsePayload(event, 'error')
      if (data) {
        setBulkError(typeof data.error === 'string' ? data.error : 'Unknown error')
      }
    })

    eventSource.addEventListener('complete', () => {
      setBulkRunning(false)
      setBulkProgress(null)
      setDetailedProgress(null)
      setBulkMode(null)
      eventSource.close()
      eventSourceRef.current = null
    })

    eventSource.onerror = () => {
      setBulkRunning(false)
      setBulkProgress(null)
      setDetailedProgress(null)
      setBulkMode(null)
      eventSource.close()
      eventSourceRef.current = null
    }
  }

  const requestExecute = (operation: MaintenanceOperation) => {
    setConfirmState({ mode: 'single', operation })
  }

  const requestExecuteAll = () => {
    setConfirmState({ mode: 'all' })
  }

  const requestApply = (key: string, action: MaintenanceAction) => {
    setApplyConfirm({ key, action })
    setApplyError(null)
    setApplyConflict(false)
  }

  const requestSettingApply = (key: string, recommendation: SettingsRecommendationItem) => {
    if (recommendation.suggestedValue === undefined) return
    setSettingsApplyConfirm({ key, recommendation })
    setSettingsApplyError(null)
  }

  const handleApplySuggestion = async (overwrite = false) => {
    if (!applyConfirm) return
    const currentApply = applyConfirm
    const payload = getSuggestionPayload(currentApply.action)
    if (!payload) {
      setApplyError('Suggestion details are incomplete.')
      return
    }

    setApplyError(null)
    setApplyConflict(false)
    setApplyStatuses(prev => ({
      ...prev,
      [currentApply.key]: { state: 'loading' }
    }))

    try {
      const result = await applyMaintenanceSuggestion({ ...payload, overwrite })
      const summary = result.addedLines === 1
        ? 'Applied (1 line added).'
        : `Applied (${result.addedLines} lines added).`
      setApplyStatuses(prev => ({
        ...prev,
        [currentApply.key]: { state: 'success', message: summary }
      }))
      setApplyConfirm(null)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to apply suggestion'
      if (error instanceof ApiError && error.status === 409) {
        setApplyConflict(true)
      }
      setApplyStatuses(prev => ({
        ...prev,
        [currentApply.key]: { state: 'error', message }
      }))
      setApplyError(message)
    }
  }

  const handleApplySetting = async () => {
    if (!settingsApplyConfirm) return
    const currentApply = settingsApplyConfirm
    const { recommendation } = currentApply
    if (recommendation.suggestedValue === undefined) {
      setSettingsApplyError('Suggested value is missing.')
      return
    }

    setSettingsApplyError(null)
    setSettingsApplyStatuses(prev => ({
      ...prev,
      [currentApply.key]: { state: 'loading' }
    }))

    try {
      const updatedSettings = await updateSetting(recommendation.setting, recommendation.suggestedValue)
      const updatedValue = updatedSettings[recommendation.setting as keyof Settings]
      const resolvedValue = (typeof updatedValue === 'string' || typeof updatedValue === 'number')
        ? updatedValue
        : recommendation.suggestedValue
      setSettingsAppliedValues(prev => ({
        ...prev,
        [recommendation.setting]: resolvedValue
      }))
      setSettingsApplyStatuses(prev => ({
        ...prev,
        [currentApply.key]: { state: 'success', message: `Updated to ${resolvedValue}.` }
      }))
      setSettingsApplyConfirm(null)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update setting'
      setSettingsApplyStatuses(prev => ({
        ...prev,
        [currentApply.key]: { state: 'error', message }
      }))
      setSettingsApplyError(message)
    }
  }

  const confirmRun = () => {
    if (!confirmState) return
    if (confirmState.mode === 'single') {
      handleRunOperation(confirmState.operation, false)
    } else {
      handleRunAll(false)
    }
    setConfirmState(null)
  }

  if (operationsLoading) {
    return (
      <div className="space-y-6">
        <section className="p-6 rounded-xl border border-border bg-card space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-2">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-64" />
            </div>
            <div className="flex items-center gap-2">
              <Skeleton className="h-9 w-28" />
              <Skeleton className="h-9 w-20" />
            </div>
          </div>
          <div className="flex flex-wrap gap-3">
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} className="h-6 w-32" />
            ))}
          </div>
        </section>

        <div className="space-y-6">
          {Array.from({ length: 3 }).map((_, index) => (
            <section key={index} className="p-6 rounded-xl border border-border bg-card space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="space-y-2">
                  <Skeleton className="h-4 w-48" />
                  <Skeleton className="h-3 w-64" />
                </div>
                <div className="flex items-center gap-2">
                  <Skeleton className="h-8 w-24" />
                  <Skeleton className="h-8 w-16" />
                </div>
              </div>
            </section>
          ))}
        </div>
      </div>
    )
  }

  if (operationsError) {
    return <div className="text-sm text-destructive">{operationsError.message}</div>
  }

  if (operations.length === 0) {
    return <div className="text-sm text-muted-foreground">No maintenance operations available.</div>
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto space-y-5">
      <section className="p-5 rounded-xl border border-border border-l-[3px] border-l-primary/50 bg-card space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-foreground/95 mb-1">Batch operations</h2>
            <p className="text-xs text-muted-foreground/70">Preview or execute all maintenance tasks in sequence.</p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              onClick={() => handleRunAll(true)}
              disabled={bulkRunning}
            >
              {bulkRunning && bulkMode === 'preview' ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Eye className="w-4 h-4 text-muted-foreground" />
              )}
              {bulkRunning && bulkMode === 'preview' ? 'Previewing...' : 'Preview all'}
            </Button>
            <Button
              onClick={requestExecuteAll}
              disabled={bulkRunning}
            >
              {bulkRunning && bulkMode === 'run' ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Play className="w-4 h-4" />
              )}
              {bulkRunning && bulkMode === 'run' ? 'Running...' : 'Run all'}
            </Button>
          </div>
        </div>
        {bulkProgress && (
          <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs">
            {operations.map(op => {
              const status = bulkProgress[op.key]
              const result = results[op.key]
              return (
                <div key={op.key} className="flex items-center gap-1.5">
                  {status === 'completed' ? (
                    <Check className="w-3.5 h-3.5 text-success" />
                  ) : status === 'running' ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-type-discovery" />
                  ) : (
                    <Circle className="w-3.5 h-3.5 text-muted-foreground/50" />
                  )}
                  <span className={status === 'running' ? 'text-type-discovery font-medium' : status === 'completed' ? 'text-muted-foreground' : 'text-muted-foreground/50'}>
                    {op.label}
                  </span>
                  {status === 'completed' && result && (
                    <span className="text-muted-foreground/60">
                      ({formatDuration(result.duration)})
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        )}
        {bulkError && (
          <div className="text-sm text-destructive">{bulkError}</div>
        )}
      </section>

      <div className="space-y-2">
        {operations.map((operation) => {
          const result = results[operation.key]
          const isRunning = running[operation.key]
          const mode = runningMode[operation.key]
          const isPreviewRunning = mode === 'preview'
          const isRunRunning = mode === 'run'
          const isDisabled = isRunning || bulkRunning
          const bulkStatus = bulkProgress?.[operation.key]
          const hasDetailedProgress = detailedProgress?.[operation.key] !== undefined
          const isCurrent = bulkStatus === 'running' || (isRunning && hasDetailedProgress)
          return (
            <section key={operation.key} className={`p-4 rounded-lg border border-l-[3px] border-l-primary/40 bg-card/60 space-y-3 transition-all ${isCurrent ? 'border-type-discovery/60 ring-1 ring-type-discovery/20 bg-card/80' : 'border-border/60'}`}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  {isCurrent && (
                    <Loader2 className="w-4 h-4 animate-spin text-type-discovery shrink-0" />
                  )}
                  <div>
                    <h3 className="text-sm font-semibold text-foreground/90">{operation.label}</h3>
                    <p className="text-xs text-muted-foreground/70">{operation.description}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handleRunOperation(operation.key, true)}
                    disabled={isDisabled}
                  >
                    {isPreviewRunning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Eye className="w-3.5 h-3.5 text-muted-foreground" />}
                    {isPreviewRunning ? 'Previewing...' : 'Preview'}
                  </Button>
                  {operation.allowExecute && (
                    <Button
                      size="sm"
                      onClick={() => requestExecute(operation.key)}
                      disabled={isDisabled}
                    >
                      {isRunRunning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                      {isRunRunning ? 'Running...' : 'Run'}
                    </Button>
                  )}
                </div>
              </div>

              {isCurrent && detailedProgress && detailedProgress[operation.key] && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">
                      {detailedProgress[operation.key].message || 'Processing...'}
                    </span>
                    <span className="text-muted-foreground font-mono">
                      {detailedProgress[operation.key].current}/{detailedProgress[operation.key].total}
                    </span>
                  </div>
                  <div className="h-1.5 bg-secondary/30 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-type-discovery transition-all duration-300 ease-out"
                      style={{
                        width: `${(detailedProgress[operation.key].current / detailedProgress[operation.key].total) * 100}%`
                      }}
                    />
                  </div>
                </div>
              )}

              {result && (
                <ResultPanel
                  result={result}
                  onSelect={selectMemory}
                  onApply={requestApply}
                  applyStatuses={applyStatuses}
                  onApplySetting={requestSettingApply}
                  settingsApplyStatuses={settingsApplyStatuses}
                  settingsAppliedValues={settingsAppliedValues}
                  applyDisabled={isDisabled}
                />
              )}
            </section>
          )
        })}
      </div>

      <Dialog open={Boolean(confirmState)} onOpenChange={() => setConfirmState(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm execution</DialogTitle>
            <DialogDescription>
              {confirmState?.mode === 'all'
                ? 'Run all maintenance operations now?'
                : `Run ${operations.find(op => op.key === (confirmState as { operation: MaintenanceOperation })?.operation)?.label} now?`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmState(null)}>
              Cancel
            </Button>
            <Button onClick={confirmRun}>
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(applyConfirm)}
        onOpenChange={(open) => {
          if (!open && !applyLoading) {
            setApplyConfirm(null)
            setApplyError(null)
            setApplyConflict(false)
          }
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Apply suggestion</DialogTitle>
            <DialogDescription>
              Confirm the changes before applying this diff.
            </DialogDescription>
          </DialogHeader>
          {(() => {
            if (!applyPayload) {
              return (
                <div className="text-sm text-destructive">
                  Suggestion details are incomplete.
                </div>
              )
            }
            const stats = applyStats ?? { addedLines: 0, deletedLines: 0, hasHunk: false }
            const actionLabel = applyPayload.action === 'new' ? 'Create new file' : 'Edit existing file'
            const summaryParts: string[] = []
            if (stats.addedLines > 0) {
              summaryParts.push(`add ${stats.addedLines} line${stats.addedLines === 1 ? '' : 's'}`)
            }
            if (stats.deletedLines > 0) {
              summaryParts.push(`remove ${stats.deletedLines} line${stats.deletedLines === 1 ? '' : 's'}`)
            }
            const summary = stats.hasHunk && summaryParts.length > 0
              ? `Will ${summaryParts.join(' and ')}.`
              : 'Diff summary unavailable.'
            return (
              <div className="space-y-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs uppercase tracking-wide text-muted-foreground">Action</span>
                  <span className="font-medium text-foreground">{actionLabel}</span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs uppercase tracking-wide text-muted-foreground">Target</span>
                  <span className="font-mono text-xs text-foreground">{applyPayload.targetFile}</span>
                </div>
                <div className="text-xs text-muted-foreground">{summary}</div>
                {applyPayload.action === 'new' ? (
                  <div className="text-xs text-warning">
                    This will create a new file. If the file already exists, you can overwrite it.
                  </div>
                ) : (
                  <div className="text-xs text-warning">
                    This will apply the diff to the existing file.
                  </div>
                )}
              </div>
            )
          })()}
          {applyError && (
            <div className="text-sm text-destructive">{applyError}</div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setApplyConfirm(null)
                setApplyError(null)
                setApplyConflict(false)
              }}
              disabled={applyLoading}
            >
              Cancel
            </Button>
            {applyConflict && (
              <Button
                variant="secondary"
                className="bg-warning hover:bg-warning/90 text-background"
                onClick={() => handleApplySuggestion(true)}
                disabled={applyLoading}
              >
                {applyLoading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Overwriting...
                  </>
                ) : (
                  'Overwrite'
                )}
              </Button>
            )}
            <Button
              onClick={() => handleApplySuggestion(false)}
              disabled={applyConflict || applyLoading}
            >
              {applyLoading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Applying...
                </>
              ) : (
                'Apply'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(settingsApplyConfirm)}
        onOpenChange={(open) => {
          if (!open && !settingsApplyLoading) {
            setSettingsApplyConfirm(null)
            setSettingsApplyError(null)
          }
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Apply setting change</DialogTitle>
            <DialogDescription>
              Confirm the update before applying Opus's recommendation.
            </DialogDescription>
          </DialogHeader>
          {settingsApplyConfirm && (() => {
            const recommendation = settingsApplyConfirm.recommendation
            const currentValue = settingsAppliedValues[recommendation.setting] ?? recommendation.currentValue
            return (
              <div className="space-y-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs uppercase tracking-wide text-muted-foreground">Setting</span>
                  <span className="font-mono text-xs text-foreground">{recommendation.setting}</span>
                </div>
                <div className="text-xs text-muted-foreground">
                  Current value <span className="font-mono text-foreground">{currentValue}</span>
                  <span className="mx-1">-&gt;</span>
                  New value <span className="font-mono text-foreground">{recommendation.suggestedValue}</span>
                </div>
                <div className="text-xs text-muted-foreground">{recommendation.reason}</div>
              </div>
            )
          })()}
          {settingsApplyError && (
            <div className="text-sm text-destructive">{settingsApplyError}</div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setSettingsApplyConfirm(null)
                setSettingsApplyError(null)
              }}
              disabled={settingsApplyLoading}
            >
              Cancel
            </Button>
            <Button
              onClick={handleApplySetting}
              disabled={settingsApplyLoading}
            >
              {settingsApplyLoading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Applying...
                </>
              ) : (
                'Apply'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <MemoryDetail
        record={selected}
        open={Boolean(selectedId)}
        loading={detailLoading}
        error={detailError}
        onClose={closeMemory}
      />
    </div>
  )
}
