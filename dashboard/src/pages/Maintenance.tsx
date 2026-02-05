import { useState } from 'react'
import { Check, Circle, Eye, Loader2, Play } from 'lucide-react'
import MemoryDetail from '@/components/MemoryDetail'
import ResultPanel from '@/components/maintenance/ResultPanel'
import Skeleton from '@/components/Skeleton'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useApi } from '@/hooks/useApi'
import { useMaintenanceExecution } from '@/hooks/useMaintenanceExecution'
import { useSelectedMemory } from '@/hooks/useSelectedMemory'
import { formatDuration } from '@/lib/format'
import {
  ApiError,
  applyMaintenanceSuggestion,
  fetchMaintenanceOperations,
  updateSetting,
  type MaintenanceAction,
  type Settings
} from '@/lib/api'
import {
  getDiffStats,
  getSuggestionPayload,
  type ApplyStatus,
  type MaintenanceOperation,
  type SettingsRecommendationItem
} from '@/components/maintenance/shared'

type ConfirmState =
  | { mode: 'single'; operation: MaintenanceOperation }
  | { mode: 'all' }
  | null

type ApplyConfirmState = { key: string; action: MaintenanceAction } | null

type SettingsApplyConfirmState = { key: string; recommendation: SettingsRecommendationItem } | null

export default function Maintenance() {
  const { data: operationsData, error: operationsError, loading: operationsLoading } = useApi(fetchMaintenanceOperations, [])
  const operations = operationsData?.operations ?? []

  const {
    results,
    running,
    runningMode,
    bulkRunning,
    bulkMode,
    bulkProgress,
    detailedProgress,
    bulkError,
    handleRunOperation,
    handleRunAll
  } = useMaintenanceExecution(operations)
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
