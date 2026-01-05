import { useEffect, useState } from 'react'
import { Check, Circle, Eye, Loader2, Play } from 'lucide-react'
import { PageHeader } from '@/App'
import {
  fetchMaintenanceOperations,
  runMaintenance,
  type MaintenanceAction,
  type MaintenanceActionType,
  type MaintenanceOperationInfo,
  type OperationResult
} from '@/lib/api'
import { useApi } from '@/hooks/useApi'

type MaintenanceOperation = MaintenanceOperationInfo['key']

type ConfirmState =
  | { mode: 'single'; operation: MaintenanceOperation }
  | { mode: 'all' }
  | null

type BulkProgressState = 'pending' | 'running' | 'completed'

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

function formatDuration(durationMs: number): string {
  if (!durationMs || durationMs <= 0) return '0ms'
  if (durationMs < 1000) return `${durationMs}ms`
  return `${(durationMs / 1000).toFixed(1)}s`
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

function renderDetails(details?: Record<string, unknown>) {
  if (!details) return null

  const before = typeof details.before === 'string' ? details.before : null
  const after = typeof details.after === 'string' ? details.after : null
  const deprecatedIds = Array.isArray(details.deprecatedIds) ? details.deprecatedIds : null
  const newerId = typeof details.newerId === 'string' ? details.newerId : null
  const similarity = typeof details.similarity === 'number' ? details.similarity : null

  if (!before && !after && !deprecatedIds && !newerId && similarity === null) return null

  return (
    <div className="mt-2 text-xs text-muted-foreground space-y-1">
      {before && after && (
        <>
          <div className="font-mono">before: {before}</div>
          <div className="font-mono">after: {after}</div>
        </>
      )}
      {deprecatedIds && deprecatedIds.length > 0 && (
        <div className="font-mono">merged: {deprecatedIds.join(', ')}</div>
      )}
      {newerId && (
        <div className="font-mono">kept: {newerId}{similarity !== null ? ` (sim ${similarity.toFixed(2)})` : ''}</div>
      )}
    </div>
  )
}

function ActionRow({ action }: { action: MaintenanceAction }) {
  const style = ACTION_STYLES[action.type]

  return (
    <div className="p-3 rounded-md border border-border bg-secondary/30">
      <div className="flex items-start gap-3">
        <span className={`mt-1 w-2 h-2 rounded-full ${style.dot}`} />
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <span className={`text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full ${style.badge}`}>
              {style.label}
            </span>
            {action.recordId && (
              <span className="text-[11px] text-muted-foreground font-mono">{action.recordId}</span>
            )}
          </div>
          <div className="text-sm text-foreground">{action.snippet}</div>
          <div className="text-xs text-muted-foreground">{action.reason}</div>
          {renderDetails(action.details)}
        </div>
      </div>
    </div>
  )
}

function ResultPanel({ result }: { result: OperationResult }) {
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
          {result.actions.map((action, index) => (
            <ActionRow key={`${action.recordId ?? action.reason}-${index}`} action={action} />
          ))}
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
  const [bulkRunning, setBulkRunning] = useState(false)
  const [bulkProgress, setBulkProgress] = useState<Record<MaintenanceOperation, BulkProgressState> | null>(null)
  const [bulkError, setBulkError] = useState<string | null>(null)
  const [confirmState, setConfirmState] = useState<ConfirmState>(null)

  useEffect(() => {
    if (operations.length === 0) return
    setResults(prev => buildOperationState(operations, null, prev))
    setRunning(prev => buildOperationState(operations, false, prev))
  }, [operations])

  const setOperationRunning = (operation: MaintenanceOperation, isRunning: boolean) => {
    setRunning(prev => ({ ...prev, [operation]: isRunning }))
  }

  const handleRunOperation = async (operation: MaintenanceOperation, dryRun: boolean) => {
    setOperationRunning(operation, true)
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
    }
  }

  const handleRunAll = (dryRun: boolean) => {
    if (operations.length === 0) return
    setBulkRunning(true)
    setBulkError(null)
    // Initialize all operations as pending
    setBulkProgress(
      Object.fromEntries(operations.map(op => [op.key, 'pending'])) as Record<MaintenanceOperation, BulkProgressState>
    )

    // Use SSE streaming endpoint for real-time progress
    const eventSource = new EventSource(`/api/maintenance/stream?dryRun=${dryRun}`)

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
      eventSource.close()
    })

    eventSource.onerror = () => {
      setBulkRunning(false)
      setBulkProgress(null)
      eventSource.close()
    }
  }

  const requestExecute = (operation: MaintenanceOperation) => {
    setConfirmState({ mode: 'single', operation })
  }

  const requestExecuteAll = () => {
    setConfirmState({ mode: 'all' })
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
        <div className="text-sm text-muted-foreground">Loading maintenance operations...</div>
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
              <Eye className="w-4 h-4" />
              {bulkRunning ? 'Running...' : 'Preview all'}
            </button>
            <button
              onClick={requestExecuteAll}
              disabled={bulkRunning}
              className="flex items-center gap-2 h-9 px-3 rounded-md bg-foreground text-background text-sm font-medium disabled:opacity-50 hover:bg-foreground/90 transition-base"
            >
              <Play className="w-4 h-4" />
              Run all
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
          const isRunning = running[operation.key] || bulkRunning
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
                    disabled={isRunning}
                    className="flex items-center gap-2 h-8 px-3 rounded-md border border-border bg-background text-xs disabled:opacity-50 hover:bg-secondary/60 transition-base"
                  >
                    <Eye className="w-4 h-4" />
                    {isCurrent ? 'Running...' : 'Preview'}
                  </button>
                  {operation.allowExecute && (
                    <button
                      onClick={() => requestExecute(operation.key)}
                      disabled={isRunning}
                      className="flex items-center gap-2 h-8 px-3 rounded-md bg-foreground text-background text-xs font-medium disabled:opacity-50 hover:bg-foreground/90 transition-base"
                    >
                      <Play className="w-4 h-4" />
                      Run
                    </button>
                  )}
                </div>
              </div>

              {result && <ResultPanel result={result} />}
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
    </div>
  )
}
