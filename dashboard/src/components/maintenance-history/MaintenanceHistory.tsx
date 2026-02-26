import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import FilterChip from '@/components/FilterChip'
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
import { useMaintenanceRuns } from '@/hooks/queries'
import {
  deleteMaintenanceRun,
  fetchMaintenanceOperations,
  type MaintenanceRun
} from '@/lib/api'
import MaintenanceHistoryDetail from './MaintenanceHistoryDetail'
import MaintenanceHistoryList from './MaintenanceHistoryList'
import MaintenanceHistorySummary from './MaintenanceHistorySummary'
import { groupRunsByDate, TIME_FILTERS, type TimeFilterKey } from './utils'

const PAGE_SIZE = 25

export default function MaintenanceHistory() {
  const [page, setPage] = useState(0)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [timeFilter, setTimeFilter] = useState<TimeFilterKey>('12h')
  const [deletingRunId, setDeletingRunId] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [deleteConfirmRun, setDeleteConfirmRun] = useState<MaintenanceRun | null>(null)

  const queryClient = useQueryClient()
  const skipAutoSelectRef = useRef(false)

  const { data, error, isPending, isFetching } = useMaintenanceRuns({ page, limit: PAGE_SIZE })
  const { data: operationsData } = useApi(fetchMaintenanceOperations, [])

  const allRuns = data?.runs ?? []
  const total = data?.total ?? null
  const errorMessage = error instanceof Error ? error.message : 'Failed to load maintenance runs'

  const filteredRuns = useMemo(() => {
    const timeMs = TIME_FILTERS.find(filter => filter.key === timeFilter)?.ms ?? Number.POSITIVE_INFINITY
    return allRuns.filter(run => Date.now() - run.timestamp <= timeMs)
  }, [allRuns, timeFilter])

  const operationLabels = useMemo(() => {
    const operations = operationsData?.operations ?? []
    return Object.fromEntries(operations.map(operation => [operation.key, operation.label]))
  }, [operationsData])

  const pageInfo = () => {
    if (isPending && !data) return 'Loading...'
    if (error && !data) return 'Error'
    if (!filteredRuns.length) return 'No results'
    return `${filteredRuns.length}/${allRuns.length}`
  }

  useEffect(() => {
    if (skipAutoSelectRef.current) {
      skipAutoSelectRef.current = false
      return
    }
    if (filteredRuns.length === 0) {
      setSelectedRunId(null)
      return
    }
    if (selectedRunId && filteredRuns.some(run => run.runId === selectedRunId)) return
    setSelectedRunId(filteredRuns[0].runId)
  }, [filteredRuns, selectedRunId])

  useEffect(() => {
    setDeleteError(null)
  }, [selectedRunId])

  const selectedRun = useMemo(() => {
    if (!selectedRunId) return null
    return filteredRuns.find(run => run.runId === selectedRunId) ?? null
  }, [filteredRuns, selectedRunId])

  const handleDeleteRun = (run: MaintenanceRun) => {
    if (deletingRunId) return
    setDeleteConfirmRun(run)
  }

  const confirmDelete = async () => {
    if (!deleteConfirmRun || deletingRunId) return
    const run = deleteConfirmRun

    setDeleteError(null)
    setDeletingRunId(run.runId)

    try {
      await deleteMaintenanceRun(run.runId)
      skipAutoSelectRef.current = true
      setSelectedRunId(prev => (prev === run.runId ? null : prev))
      setDeleteConfirmRun(null)
      queryClient.invalidateQueries({ queryKey: ['maintenanceRuns'] })
    } catch (nextError) {
      const message = nextError instanceof Error ? nextError.message : 'Failed to delete maintenance run'
      setDeleteError(message)
    } finally {
      setDeletingRunId(null)
    }
  }

  const summary = useMemo(() => {
    let totalActions = 0
    let totalDeprecated = 0
    let totalMerged = 0
    let totalDuration = 0
    let latestTimestamp = 0

    for (const run of filteredRuns) {
      totalActions += run.summary.totalActions
      totalDeprecated += run.summary.totalDeprecated
      totalMerged += run.summary.totalMerged
      totalDuration += run.duration
      if (run.timestamp > latestTimestamp) {
        latestTimestamp = run.timestamp
      }
    }

    return {
      totalRuns: filteredRuns.length,
      totalActions,
      totalDeprecated,
      totalMerged,
      avgDuration: filteredRuns.length ? totalDuration / filteredRuns.length : 0,
      latestTimestamp
    }
  }, [filteredRuns])

  const groupedRuns = useMemo(() => groupRunsByDate(filteredRuns), [filteredRuns])

  const isInitialLoading = isPending && allRuns.length === 0
  const isRefreshing = isFetching && !isInitialLoading

  if (error && !data) {
    return <div className="text-sm text-destructive">{errorMessage}</div>
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      {error && data && (
        <div className="bg-warning/10 text-warning text-sm px-4 py-2.5 rounded-lg border border-warning/20 shrink-0">
          Failed to refresh data. Showing cached results.
        </div>
      )}

      {deleteError && (
        <div className="bg-destructive/10 text-destructive text-sm px-4 py-2.5 rounded-lg border border-destructive/20 shrink-0">
          {deleteError}
        </div>
      )}

      {isRefreshing && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground/70 shrink-0">
          <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />
          Updating runs...
        </div>
      )}

      {isInitialLoading ? (
        <div className="py-16 text-center text-sm text-muted-foreground/70">
          Loading maintenance history...
        </div>
      ) : allRuns.length === 0 ? (
        <div className="py-16 text-center text-sm text-muted-foreground/70">
          No maintenance runs logged yet.
        </div>
      ) : (
        <div className="flex flex-col flex-1 min-h-0 gap-4">
          <MaintenanceHistorySummary summary={summary} />

          <section className="rounded-xl border border-border bg-card px-4 py-3 shrink-0">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-1">
                {TIME_FILTERS.map(filter => (
                  <FilterChip
                    key={filter.key}
                    active={timeFilter === filter.key}
                    onClick={() => setTimeFilter(filter.key)}
                  >
                    {filter.label}
                  </FilterChip>
                ))}
              </div>
              <div className="ml-auto text-xs text-muted-foreground/70 font-medium tabular-nums">
                {filteredRuns.length}/{allRuns.length}
              </div>
            </div>
          </section>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)] xl:grid-cols-[minmax(0,380px)_minmax(0,1fr)] 2xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)] flex-1 min-h-0">
            <MaintenanceHistoryList
              groupedRuns={groupedRuns}
              selectedRunId={selectedRunId}
              onSelect={setSelectedRunId}
              page={page}
              onPreviousPage={() => setPage(prev => Math.max(0, prev - 1))}
              onNextPage={() => setPage(prev => prev + 1)}
              pageInfo={pageInfo()}
              disableNext={total !== null && (page + 1) * PAGE_SIZE >= total}
            />

            <MaintenanceHistoryDetail
              run={selectedRun}
              operationLabels={operationLabels}
              onDeleteRun={handleDeleteRun}
              isDeleting={deletingRunId === selectedRun?.runId}
            />
          </div>
        </div>
      )}

      <Dialog open={Boolean(deleteConfirmRun)} onOpenChange={(open) => !open && setDeleteConfirmRun(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete maintenance run</DialogTitle>
            <DialogDescription>
              This will permanently remove the saved maintenance run history entry.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirmRun(null)} disabled={deletingRunId !== null}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={deletingRunId !== null}>
              {deletingRunId ? 'Deleting...' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
