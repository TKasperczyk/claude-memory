import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import MemoryDetail, { type RetrievalContext } from '@/components/MemoryDetail'
import SessionDetail from '@/components/sessions/SessionDetail'
import SessionFilters from '@/components/sessions/SessionFilters'
import SessionList, { SessionListSkeleton } from '@/components/sessions/SessionList'
import SessionSummary from '@/components/sessions/SessionSummary'
import { useSessions } from '@/hooks/queries'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { useSelectedMemory } from '@/hooks/useSelectedMemory'
import { useSessionReviews } from '@/hooks/useSessionReviews'
import { useSessionsState } from '@/hooks/useSessionsState'

export default function Sessions() {
  const navigate = useNavigate()
  const [retrievalContext, setRetrievalContext] = useState<RetrievalContext | null>(null)
  const { selectedId, selected, detailLoading, detailError, handleSelect: selectMemory, handleClose: closeMemory } = useSelectedMemory()
  const { copy, isCopied } = useCopyToClipboard(2000)
  const { data, error, isPending } = useSessions()
  const sessions = data?.sessions ?? []
  const errorMessage = error instanceof Error ? error.message : 'Failed to load sessions'

  const {
    reviewsBySession,
    reviewLoading,
    reviewErrors,
    loadReview,
    handleReviewUpdate,
    handleReviewError
  } = useSessionReviews()

  const {
    selectedSessionId,
    setSelectedSessionId,
    selectedSession,
    summary,
    projectOptions,
    sortedSessions,
    groupedSessions,
    searchQuery,
    setSearchQuery,
    timeFilter,
    setTimeFilter,
    projectFilter,
    setProjectFilter,
    hasMemoriesOnly,
    setHasMemoriesOnly,
    hasReviewsOnly,
    setHasReviewsOnly,
    activeOnly,
    setActiveOnly,
    sortKey,
    setSortKey
  } = useSessionsState(sessions, reviewsBySession)

  useEffect(() => {
    if (!selectedId) {
      setRetrievalContext(null)
      return
    }

    let nextContext: RetrievalContext | null = null
    for (const session of sessions) {
      const memory = session.memories.find(item => item.id === selectedId)
      if (memory) {
        nextContext = {
          prompt: memory.prompt,
          similarity: memory.similarity,
          keywordMatch: memory.keywordMatch,
          score: memory.score
        }
        break
      }
    }
    setRetrievalContext(nextContext)
  }, [selectedId, sessions])

  const handleSelect = (id: string, context?: RetrievalContext | null) => {
    setRetrievalContext(context ?? null)
    selectMemory(id)
  }

  const handleClose = () => {
    setRetrievalContext(null)
    closeMemory()
  }

  const handleSendToSimulator = (prompt: string, cwd?: string) => {
    navigate('/preview', { state: { prompt, cwd } })
  }

  const selectedReview = selectedSession ? (reviewsBySession[selectedSession.sessionId] ?? null) : null
  const reviewLoadingState = selectedSession ? (reviewLoading[selectedSession.sessionId] ?? false) : false
  const reviewError = selectedSession ? reviewErrors[selectedSession.sessionId] : undefined
  const hasReviewLoaded = selectedSession
    ? Object.prototype.hasOwnProperty.call(reviewsBySession, selectedSession.sessionId)
    : false

  const isInitialLoading = isPending && sessions.length === 0

  if (error && !data) {
    return (
      <div className="text-sm text-destructive">{errorMessage}</div>
    )
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      {error && data && (
        <div className="bg-warning/10 text-warning text-sm px-4 py-2.5 rounded-lg border border-warning/20">
          Failed to refresh data. Showing cached results.
        </div>
      )}

      {isInitialLoading ? (
        <SessionListSkeleton />
      ) : sessions.length === 0 ? (
        <div className="py-16 text-center text-sm text-muted-foreground/70">
          No sessions tracked yet. Sessions appear when Claude Code runs with memory hooks enabled.
        </div>
      ) : (
        <div className="flex flex-col flex-1 min-h-0 gap-4">
          <SessionSummary
            summary={{
              totalSessions: summary.totalSessions,
              activeCount: summary.activeCount,
              totalPrompts: summary.totalPrompts,
              totalInjections: summary.totalInjections,
              totalMemories: summary.totalMemories,
              injectionRate: summary.injectionRate
            }}
          />

          <SessionFilters
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            projectFilter={projectFilter}
            onProjectFilterChange={setProjectFilter}
            projectOptions={projectOptions}
            sortKey={sortKey}
            onSortChange={setSortKey}
            timeFilter={timeFilter}
            onTimeFilterChange={setTimeFilter}
            hasMemoriesOnly={hasMemoriesOnly}
            onHasMemoriesOnlyChange={setHasMemoriesOnly}
            hasReviewsOnly={hasReviewsOnly}
            onHasReviewsOnlyChange={setHasReviewsOnly}
            activeOnly={activeOnly}
            onActiveOnlyChange={setActiveOnly}
            filteredCount={sortedSessions.length}
            totalCount={sessions.length}
          />

          <div className="grid gap-4 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)] xl:grid-cols-[minmax(0,380px)_minmax(0,1fr)] 2xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)] flex-1 min-h-0">
            <SessionList
              groupedSessions={groupedSessions}
              selectedSessionId={selectedSessionId}
              onSelect={setSelectedSessionId}
              totalCount={sortedSessions.length}
            />

            <SessionDetail
              session={selectedSession}
              review={selectedReview}
              reviewLoadingState={reviewLoadingState}
              reviewError={reviewError}
              hasReviewLoaded={hasReviewLoaded}
              onSelectMemory={handleSelect}
              onReviewUpdate={handleReviewUpdate}
              onReviewError={handleReviewError}
              onLoadReview={loadReview}
              onSendToSimulator={handleSendToSimulator}
              copy={copy}
              isCopied={isCopied}
            />
          </div>
        </div>
      )}

      <MemoryDetail
        record={selected}
        retrievalContext={retrievalContext}
        open={Boolean(selectedId)}
        loading={detailLoading}
        error={detailError}
        onClose={handleClose}
      />
    </div>
  )
}
