import { useEffect, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import MemoryDetail from '@/components/MemoryDetail'
import ExtractionDetail from '@/components/extractions/ExtractionDetail'
import ExtractionFilters from '@/components/extractions/ExtractionFilters'
import ExtractionList from '@/components/extractions/ExtractionList'
import ExtractionSummary from '@/components/extractions/ExtractionSummary'
import { ExtractionListSkeleton } from '@/components/extractions/ExtractionSkeletons'
import { extractProjectFromPath, TIME_FILTERS, type TimeFilterKey } from '@/components/extractions/utils'
import { useExtractions } from '@/hooks/queries'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { useSelectedMemory } from '@/hooks/useSelectedMemory'
import { useExtractionRunData } from '@/hooks/useExtractionRunData'

const PAGE_SIZE = 25

export default function Extractions() {
  const [page, setPage] = useState(0)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [timeFilter, setTimeFilter] = useState<TimeFilterKey>('12h')
  const { selectedId, selected, detailLoading, detailError, handleSelect, handleClose } = useSelectedMemory()
  const { copy, isCopied } = useCopyToClipboard(2000)

  const {
    recordsByRun,
    loadingRunId,
    runErrors,
    reviewsByRun,
    reviewLoading,
    reviewErrors,
    loadRunDetails,
    loadReview,
    handleReviewUpdate,
    handleReviewError
  } = useExtractionRunData()

  const { data, error, isPending, isFetching } = useExtractions({ page, limit: PAGE_SIZE })
  const allRuns = data?.runs ?? []
  const total = data?.total ?? null
  const errorMessage = error instanceof Error ? error.message : 'Failed to load extractions'

  const filteredRuns = useMemo(() => {
    const timeMs = TIME_FILTERS.find(filter => filter.key === timeFilter)?.ms ?? Number.POSITIVE_INFINITY
    return allRuns.filter(run => Date.now() - run.timestamp <= timeMs)
  }, [allRuns, timeFilter])

  const pageInfo = () => {
    if (isPending && !data) return 'Loading...'
    if (error && !data) return 'Error'
    if (!filteredRuns.length) return 'No results'
    return `${filteredRuns.length}/${allRuns.length}`
  }

  useEffect(() => {
    if (filteredRuns.length === 0) {
      setSelectedRunId(null)
      return
    }
    if (selectedRunId && filteredRuns.some(run => run.runId === selectedRunId)) return
    setSelectedRunId(filteredRuns[0].runId)
  }, [filteredRuns, selectedRunId])

  const selectedRun = useMemo(() => {
    if (!selectedRunId) return null
    return filteredRuns.find(run => run.runId === selectedRunId) ?? null
  }, [filteredRuns, selectedRunId])

  const summary = useMemo(() => {
    let totalRecords = 0
    let totalErrors = 0
    let totalDuration = 0
    let latestTimestamp = 0

    for (const run of filteredRuns) {
      totalRecords += run.recordCount
      totalErrors += run.parseErrorCount
      totalDuration += run.duration
      if (run.timestamp > latestTimestamp) {
        latestTimestamp = run.timestamp
      }
    }

    return {
      totalRuns: filteredRuns.length,
      totalRecords,
      totalErrors,
      avgDuration: filteredRuns.length ? totalDuration / filteredRuns.length : 0,
      latestTimestamp
    }
  }, [filteredRuns])

  const groupedRuns = useMemo(() => {
    const groups = new Map<string, typeof filteredRuns>()
    for (const run of filteredRuns) {
      const projectName = extractProjectFromPath(run.transcriptPath)
      if (!groups.has(projectName)) {
        groups.set(projectName, [])
      }
      groups.get(projectName)!.push(run)
    }
    return Array.from(groups.entries()).map(([name, runs]) => ({
      name,
      runs
    }))
  }, [filteredRuns])

  const isInitialLoading = isPending && allRuns.length === 0
  const isRefreshing = isFetching && !isInitialLoading

  if (error && !data) {
    return (
      <div className="text-sm text-destructive">{errorMessage}</div>
    )
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      {error && data && (
        <div className="bg-warning/10 text-warning text-sm px-4 py-2.5 rounded-lg border border-warning/20 shrink-0">
          Failed to refresh data. Showing cached results.
        </div>
      )}

      {isRefreshing && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground/70 shrink-0">
          <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />
          Updating runs...
        </div>
      )}

      {isInitialLoading ? (
        <ExtractionListSkeleton />
      ) : allRuns.length === 0 ? (
        <div className="py-16 text-center text-sm text-muted-foreground/70">
          No extraction runs logged yet.
        </div>
      ) : (
        <div className="flex flex-col flex-1 min-h-0 gap-4">
          <ExtractionSummary summary={summary} />

          <ExtractionFilters
            timeFilter={timeFilter}
            onTimeFilterChange={setTimeFilter}
            filteredCount={filteredRuns.length}
            totalCount={allRuns.length}
          />

          <div className="grid gap-4 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)] xl:grid-cols-[minmax(0,380px)_minmax(0,1fr)] 2xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)] flex-1 min-h-0">
            <ExtractionList
              groupedRuns={groupedRuns}
              selectedRunId={selectedRunId}
              reviewsByRun={reviewsByRun}
              onSelect={setSelectedRunId}
              page={page}
              onPreviousPage={() => setPage(p => Math.max(0, p - 1))}
              onNextPage={() => setPage(p => p + 1)}
              pageInfo={pageInfo()}
              disableNext={total !== null && (page + 1) * PAGE_SIZE >= total}
            />

            <ExtractionDetail
              run={selectedRun}
              recordsByRun={recordsByRun}
              loadingRunId={loadingRunId}
              runErrors={runErrors}
              reviewsByRun={reviewsByRun}
              reviewLoading={reviewLoading}
              reviewErrors={reviewErrors}
              onSelectMemory={handleSelect}
              onReviewUpdate={handleReviewUpdate}
              onReviewError={handleReviewError}
              onLoadRunDetails={loadRunDetails}
              onLoadReview={loadReview}
              copy={copy}
              isCopied={isCopied}
            />
          </div>
        </div>
      )}

      <MemoryDetail
        record={selected}
        open={Boolean(selectedId)}
        loading={detailLoading}
        error={detailError}
        onClose={handleClose}
      />
    </div>
  )
}
