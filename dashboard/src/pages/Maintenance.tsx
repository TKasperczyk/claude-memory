import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Check, Circle, Eye, Loader2, Play } from 'lucide-react'
import { PageHeader } from '@/App'
import ButtonSpinner from '@/components/ButtonSpinner'
import MemoryDetail from '@/components/MemoryDetail'
import Skeleton from '@/components/Skeleton'
import { formatDuration } from '@/lib/format'
import {
  ApiError,
  applyMaintenanceSuggestion,
  fetchMaintenanceOperations,
  runMaintenance,
  type MaintenanceAction,
  type MaintenanceActionType,
  type MaintenanceOperationInfo,
  type OperationResult
} from '@/lib/api'
import { useApi } from '@/hooks/useApi'
import { useSelectedMemory } from '@/hooks/useSelectedMemory'

type MaintenanceOperation = MaintenanceOperationInfo['key']

type ConfirmState =
  | { mode: 'single'; operation: MaintenanceOperation }
  | { mode: 'all' }
  | null

type BulkProgressState = 'pending' | 'running' | 'completed'
type ApplyStatus = { state: 'loading' | 'success' | 'error'; message?: string }
type ApplyConfirmState = { key: string; action: MaintenanceAction } | null

const ACTION_STYLES: Record<MaintenanceActionType, { badge: string; dot: string; label: string }> = {
  deprecate: {
    badge: 'bg-destructive/15 text-destructive',
    dot: 'bg-destructive',
    label: 'Deprecate'
  },
  update: {
    badge: 'bg-sky-500/15 text-sky-300',
    dot: 'bg-sky-400',
    label: 'Update'
  },
  merge: {
    badge: 'bg-purple-500/15 text-purple-300',
    dot: 'bg-purple-400',
    label: 'Merge'
  },
  promote: {
    badge: 'bg-emerald-500/15 text-emerald-300',
    dot: 'bg-emerald-400',
    label: 'Promote'
  },
  suggestion: {
    badge: 'bg-amber-500/15 text-amber-300',
    dot: 'bg-amber-400',
    label: 'Suggestion'
  }
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

function getDiffStats(diff: string): { addedLines: number; hasDeletion: boolean; hasHunk: boolean } {
  const lines = diff.replace(/\r\n/g, '\n').split('\n')
  let inHunk = false
  let hasHunk = false
  let hasDeletion = false
  let addedLines = 0

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
      hasDeletion = true
    }
  }

  return { addedLines, hasDeletion, hasHunk }
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

  return (
    <button
      type="button"
      onClick={(event) => {
        if (stopPropagation) event.stopPropagation()
        onSelect(id)
      }}
      className={classes}
    >
      {id}
    </button>
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
  const deprecatedRecords = Array.isArray(details.deprecatedRecords) ? details.deprecatedRecords : null
  const deprecatedIds = Array.isArray(details.deprecatedIds) ? details.deprecatedIds : null
  const keptId = typeof details.keptId === 'string' ? details.keptId : null
  const newerId = typeof details.newerId === 'string' ? details.newerId : null
  const similarity = typeof details.similarity === 'number' ? details.similarity : null
  const hasDeprecatedRecords = Boolean(deprecatedRecords && deprecatedRecords.length > 0)
  const hasDeprecatedIds = Boolean(!hasDeprecatedRecords && deprecatedIds && deprecatedIds.length > 0)

  if (!before && !after && !diff && !hasDeprecatedRecords && !hasDeprecatedIds && !newerId && similarity === null) return null

  const diffLines = diff ? diff.split('\n') : []

  return (
    <div className="mt-2 text-xs text-muted-foreground space-y-2">
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
                className = 'whitespace-pre px-3 py-0.5 text-sky-200'
              } else if (line.startsWith('@@')) {
                className = 'whitespace-pre px-3 py-0.5 text-purple-200'
              } else if (line.startsWith('+')) {
                className = 'whitespace-pre px-3 py-0.5 text-emerald-200 bg-emerald-500/10'
              } else if (line.startsWith('-')) {
                className = 'whitespace-pre px-3 py-0.5 text-rose-200 bg-rose-500/10'
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
  const isSelectable = Boolean(recordId && onSelect)
  const isApplying = applyStatus?.state === 'loading'
  const isApplied = applyStatus?.state === 'success'
  const canApply = Boolean(onApply)
  const containerClasses = `p-3 rounded-md border border-border bg-secondary/30 transition-base ${
    isSelectable
      ? executed
        ? 'cursor-pointer hover:bg-emerald-500/10 hover:opacity-100'
        : 'cursor-pointer hover:bg-secondary/50'
      : ''
  } ${executed ? 'border-emerald-500/30 bg-emerald-500/5 opacity-80' : ''}`
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
          {executed && (
            <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300">
              <Check className="w-3 h-3" aria-hidden="true" />
              Done
            </span>
          )}
          {isApplied && (
            <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300">
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
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  onApply?.(action)
                }}
                disabled={applyDisabled || isApplying || isApplied}
                className="flex items-center gap-2 h-7 px-2.5 rounded-md border border-border bg-background text-[11px] uppercase tracking-wide disabled:opacity-50 hover:bg-secondary/60 transition-base"
              >
                {isApplying ? <ButtonSpinner size="xs" /> : 'Apply'}
              </button>
            </span>
          )}
        </div>
        <div className="text-sm text-foreground">{action.snippet}</div>
        <div className="text-xs text-muted-foreground">{action.reason}</div>
        {renderDetails(action.details, onSelect)}
        {applyStatus?.message && (
          <div className={`mt-2 text-xs ${applyStatus.state === 'error' ? 'text-destructive' : 'text-emerald-300'}`}>
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

function ResultPanel({
  result,
  onSelect,
  onApply,
  applyStatuses,
  applyDisabled = false
}: {
  result: OperationResult
  onSelect?: (id: string) => void
  onApply?: (key: string, action: MaintenanceAction) => void
  applyStatuses?: Record<string, ApplyStatus>
  applyDisabled?: boolean
}) {
  const summaryEntries = Object.entries(result.summary)

  return (
    <div className="mt-4 space-y-4 rounded-lg border border-border bg-background/40 p-4">
      <h4 className="section-header">Results</h4>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-xs text-muted-foreground">
          {result.dryRun ? 'Preview' : 'Executed'} in {formatDuration(result.duration)}
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
  const [bulkError, setBulkError] = useState<string | null>(null)
  const [confirmState, setConfirmState] = useState<ConfirmState>(null)
  const [applyConfirm, setApplyConfirm] = useState<ApplyConfirmState>(null)
  const [applyStatuses, setApplyStatuses] = useState<Record<string, ApplyStatus>>({})
  const [applyError, setApplyError] = useState<string | null>(null)
  const [applyConflict, setApplyConflict] = useState(false)
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
  const applyBlocked = Boolean(applyStats?.hasDeletion)

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
          duration: 0,
          error: message
        }
      }))
    } finally {
      setOperationRunning(operation, false)
      setRunningMode(prev => ({ ...prev, [operation]: null }))
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
      const data = JSON.parse(event.data)
      if (data.operation) {
        const op = data.operation as MaintenanceOperation
        setBulkProgress(prev => prev ? { ...prev, [op]: 'running' } : null)
      }
    })

    eventSource.addEventListener('result', (event) => {
      const result = JSON.parse(event.data) as OperationResult
      if (result.operation) {
        const op = result.operation as MaintenanceOperation
        setBulkProgress(prev => prev ? { ...prev, [op]: 'completed' } : null)
        setResults(prev => ({
          ...prev,
          [op]: result
        }))
      }
    })

    eventSource.addEventListener('error', (event) => {
      if (event instanceof MessageEvent) {
        const data = JSON.parse(event.data)
        setBulkError(data.error || 'Unknown error')
      }
    })

    eventSource.addEventListener('complete', () => {
      setBulkRunning(false)
      setBulkProgress(null)
      setBulkMode(null)
      eventSource.close()
      eventSourceRef.current = null
    })

    eventSource.onerror = () => {
      setBulkRunning(false)
      setBulkProgress(null)
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
      <div className="space-y-8">
        <PageHeader
          title="Maintenance"
          description="Run maintenance operations manually with dry-run previews"
        />
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
    return (
      <div className="space-y-8">
        <PageHeader
          title="Maintenance"
          description="Run maintenance operations manually with dry-run previews"
        />
        <div className="text-sm text-destructive">{operationsError.message}</div>
      </div>
    )
  }

  if (operations.length === 0) {
    return (
      <div className="space-y-8">
        <PageHeader
          title="Maintenance"
          description="Run maintenance operations manually with dry-run previews"
        />
        <div className="text-sm text-muted-foreground">No maintenance operations available.</div>
      </div>
    )
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title="Maintenance"
        description="Run maintenance operations manually with dry-run previews"
      />

      <section className="p-6 rounded-xl border border-border bg-card space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="section-header">Batch operations</h2>
            <p className="text-xs text-muted-foreground">Preview or execute all maintenance tasks in sequence.</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => handleRunAll(true)}
              disabled={bulkRunning}
              className="flex items-center gap-2 h-9 px-3 rounded-md border border-border bg-background text-sm disabled:opacity-50 hover:bg-secondary/60 transition-base"
            >
              {bulkRunning && bulkMode === 'preview' ? (
                <ButtonSpinner size="sm" />
              ) : (
                <Eye className="w-4 h-4" />
              )}
              {bulkRunning && bulkMode === 'preview' ? 'Previewing...' : 'Preview all'}
            </button>
            <button
              onClick={requestExecuteAll}
              disabled={bulkRunning}
              className="flex items-center gap-2 h-9 px-3 rounded-md bg-foreground text-background text-sm font-medium disabled:opacity-50 hover:bg-foreground/90 transition-base"
            >
              {bulkRunning && bulkMode === 'run' ? (
                <ButtonSpinner size="sm" />
              ) : (
                <Play className="w-4 h-4" />
              )}
              {bulkRunning && bulkMode === 'run' ? 'Running...' : 'Run all'}
            </button>
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
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
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

      <div className="space-y-6">
        {operations.map(operation => {
          const result = results[operation.key]
          const isRunning = running[operation.key]
          const mode = runningMode[operation.key]
          const isPreviewRunning = mode === 'preview'
          const isRunRunning = mode === 'run'
          const isDisabled = isRunning || bulkRunning
          const bulkStatus = bulkProgress?.[operation.key]
          const isCurrent = bulkStatus === 'running'
          return (
            <section key={operation.key} className={`p-6 rounded-xl border bg-card space-y-4 transition-base ${isCurrent ? 'border-type-discovery ring-1 ring-type-discovery/30' : 'border-border'}`}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  {isCurrent && (
                    <Loader2 className="w-4 h-4 animate-spin text-type-discovery" />
                  )}
                  <div>
                    <h3 className="text-base font-semibold">{operation.label}</h3>
                    <p className="text-sm text-muted-foreground">{operation.description}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleRunOperation(operation.key, true)}
                    disabled={isDisabled}
                    className="flex items-center gap-2 h-8 px-3 rounded-md border border-border bg-background text-xs disabled:opacity-50 hover:bg-secondary/60 transition-base"
                  >
                    {isPreviewRunning ? <ButtonSpinner size="xs" /> : <Eye className="w-4 h-4" />}
                    {isPreviewRunning ? 'Previewing...' : 'Preview'}
                  </button>
                  {operation.allowExecute && (
                    <button
                      onClick={() => requestExecute(operation.key)}
                      disabled={isDisabled}
                      className="flex items-center gap-2 h-8 px-3 rounded-md bg-foreground text-background text-xs font-medium disabled:opacity-50 hover:bg-foreground/90 transition-base"
                    >
                      {isRunRunning ? <ButtonSpinner size="xs" /> : <Play className="w-4 h-4" />}
                      {isRunRunning ? 'Running...' : 'Run'}
                    </button>
                  )}
                </div>
              </div>

              {result && (
                <ResultPanel
                  result={result}
                  onSelect={selectMemory}
                  onApply={requestApply}
                  applyStatuses={applyStatuses}
                  applyDisabled={isDisabled}
                />
              )}
            </section>
          )
        })}
      </div>

      {confirmState && (
        <div className="fixed inset-0 z-50">
          <div
            className="absolute inset-0 bg-black/60 panel-backdrop open"
            onClick={() => setConfirmState(null)}
          />
          <div className="absolute inset-0 flex items-center justify-center px-4">
            <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 space-y-4">
              <div>
                <h2 className="text-lg font-semibold">Confirm execution</h2>
                <p className="text-sm text-muted-foreground">
                  {confirmState.mode === 'all'
                    ? 'Run all maintenance operations now?'
                    : `Run ${operations.find(op => op.key === confirmState.operation)?.label} now?`}
                </p>
              </div>
              <div className="flex items-center justify-end gap-3">
                <button
                  onClick={() => setConfirmState(null)}
                  className="h-9 px-4 rounded-md border border-border bg-background text-sm hover:bg-secondary/60 transition-base"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmRun}
                  className="h-9 px-4 rounded-md bg-foreground text-background text-sm font-medium hover:bg-foreground/90 transition-base"
                >
                  Confirm
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {applyConfirm && (
        <div className="fixed inset-0 z-50">
          <div
            className="absolute inset-0 bg-black/60 panel-backdrop open"
            onClick={() => {
              if (applyLoading) return
              setApplyConfirm(null)
              setApplyError(null)
              setApplyConflict(false)
            }}
          />
          <div className="absolute inset-0 flex items-center justify-center px-4">
            <div className="w-full max-w-lg rounded-xl border border-border bg-card p-6 space-y-4">
              <div>
                <h2 className="text-lg font-semibold">Apply suggestion</h2>
                <p className="text-sm text-muted-foreground">
                  Confirm the changes before applying this diff.
                </p>
              </div>
              {(() => {
                if (!applyPayload) {
                  return (
                    <div className="text-sm text-destructive">
                      Suggestion details are incomplete.
                    </div>
                  )
                }
                const stats = applyStats ?? { addedLines: 0, hasDeletion: false, hasHunk: false }
                const actionLabel = applyPayload.action === 'new' ? 'Create new file' : 'Edit existing file'
                const summary = stats.hasHunk && stats.addedLines > 0
                  ? `Will add ${stats.addedLines} line${stats.addedLines === 1 ? '' : 's'}.`
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
                      <div className="text-xs text-amber-300">
                        This will create a new file. If the file already exists, you can overwrite it.
                      </div>
                    ) : (
                      <div className="text-xs text-amber-300">
                        This will append content to the existing file.
                      </div>
                    )}
                    {stats.hasDeletion && (
                      <div className="text-xs text-amber-300">
                        Diff contains deletions and cannot be applied.
                      </div>
                    )}
                  </div>
                )
              })()}
              {applyError && (
                <div className="text-sm text-destructive">{applyError}</div>
              )}
              <div className="flex items-center justify-end gap-3">
                <button
                  onClick={() => {
                    setApplyConfirm(null)
                    setApplyError(null)
                    setApplyConflict(false)
                  }}
                  disabled={applyLoading}
                  className="h-9 px-4 rounded-md border border-border bg-background text-sm hover:bg-secondary/60 transition-base disabled:opacity-50"
                >
                  Cancel
                </button>
                {applyConflict && (
                  <button
                    onClick={() => handleApplySuggestion(true)}
                    disabled={applyLoading || applyBlocked}
                    className="flex items-center gap-2 h-9 px-4 rounded-md bg-amber-500 text-background text-sm font-medium hover:bg-amber-500/90 transition-base disabled:opacity-50"
                  >
                    {applyLoading ? (
                      <>
                        <ButtonSpinner size="md" />
                        Overwriting...
                      </>
                    ) : (
                      'Overwrite'
                    )}
                  </button>
                )}
                <button
                  onClick={() => handleApplySuggestion(false)}
                  disabled={applyConflict || applyLoading || applyBlocked}
                  className="flex items-center gap-2 h-9 px-4 rounded-md bg-foreground text-background text-sm font-medium hover:bg-foreground/90 transition-base disabled:opacity-50"
                >
                  {applyLoading ? (
                    <>
                      <ButtonSpinner size="md" />
                      Applying...
                    </>
                  ) : (
                    'Apply'
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

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
