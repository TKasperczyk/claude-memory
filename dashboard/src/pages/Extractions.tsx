import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react'
import { Link } from 'react-router-dom'
import { PageHeader } from '@/App'
import { fetchExtractionRun, fetchExtractions, type ExtractionRun, type MemoryRecord } from '@/lib/api'
import { formatDateTime, formatDuration } from '@/lib/format'

const PAGE_SIZE = 25

const TYPE_COLORS: Record<string, string> = {
  command: '#2dd4bf',
  error: '#f43f5e',
  discovery: '#60a5fa',
  procedure: '#a78bfa',
}

function truncateSessionId(sessionId: string): string {
  if (sessionId.length <= 10) return sessionId
  return `${sessionId.slice(0, 10)}...`
}

function getRecordSummary(record: MemoryRecord): string {
  switch (record.type) {
    case 'command': return record.command
    case 'error': return record.errorText
    case 'discovery': return record.what
    case 'procedure': return record.name
  }
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, max - 3)}...`
}

export default function Extractions() {
  const [runs, setRuns] = useState<ExtractionRun[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [offset, setOffset] = useState(0)
  const [total, setTotal] = useState<number | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [recordsByRun, setRecordsByRun] = useState<Record<string, MemoryRecord[]>>({})
  const [loadingRunId, setLoadingRunId] = useState<string | null>(null)
  const [runErrors, setRunErrors] = useState<Record<string, string>>({})

  useEffect(() => {
    let active = true

    const loadRuns = async () => {
      setLoading(true)
      setError(null)
      try {
        const response = await fetchExtractions({ limit: PAGE_SIZE, offset })
        if (!active) return
        setRuns(response.runs)
        setTotal(response.total)
      } catch (err) {
        if (!active) return
        setError(err instanceof Error ? err.message : 'Failed to load extractions')
      } finally {
        if (active) setLoading(false)
      }
    }

    loadRuns()
    return () => { active = false }
  }, [offset])

  const handleToggle = async (run: ExtractionRun) => {
    const isOpen = expanded === run.runId
    setExpanded(isOpen ? null : run.runId)

    if (!isOpen && !recordsByRun[run.runId] && !loadingRunId) {
      setLoadingRunId(run.runId)
      setRunErrors(prev => ({ ...prev, [run.runId]: '' }))
      try {
        const response = await fetchExtractionRun(run.runId)
        setRecordsByRun(prev => ({ ...prev, [run.runId]: response.records }))
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to load extraction'
        setRunErrors(prev => ({ ...prev, [run.runId]: message }))
      } finally {
        setLoadingRunId(null)
      }
    }
  }

  const pageInfo = () => {
    if (loading) return 'Loading...'
    if (error) return 'Error'
    if (!runs.length) return 'No results'
    const start = offset + 1
    const end = offset + runs.length
    return total ? `${start}-${end} of ${total}` : `${start}-${end}`
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Extractions"
        description="Monitor extraction runs and review extracted records"
      />

      {loading && runs.length === 0 ? (
        <div className="text-sm text-muted-foreground">Loading...</div>
      ) : error ? (
        <div className="text-sm text-destructive">{error}</div>
      ) : runs.length === 0 ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          No extraction runs logged yet.
        </div>
      ) : (
        <div className="space-y-2">
          {runs.map(run => {
            const isOpen = expanded === run.runId
            const runRecords = recordsByRun[run.runId] ?? []
            const isLoadingRecords = loadingRunId === run.runId
            const runError = runErrors[run.runId]

            return (
              <div
                key={run.runId}
                className="rounded-xl border border-border bg-card"
              >
                <button
                  onClick={() => handleToggle(run)}
                  className="w-full px-4 py-3 flex items-center gap-3 text-left"
                >
                  {isOpen ? (
                    <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
                  )}

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium truncate" title={run.sessionId}>
                        {truncateSessionId(run.sessionId)}
                      </span>
                      {run.parseErrorCount > 0 && (
                        <span className="text-[10px] uppercase tracking-wide text-destructive">
                          {run.parseErrorCount} parse errors
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {formatDateTime(run.timestamp)}
                    </div>
                  </div>

                  <div className="flex items-center gap-4 text-xs text-muted-foreground shrink-0">
                    <span>{run.recordCount} records</span>
                    <span>{formatDuration(run.duration)}</span>
                  </div>
                </button>

                <div className={`accordion-content ${isOpen ? 'open' : ''}`}>
                  <div className="accordion-inner">
                    <div className="px-4 pb-4 pt-0 space-y-3">
                      <div className="text-xs text-muted-foreground">
                        Transcript: <span className="font-mono break-all">{run.transcriptPath}</span>
                      </div>

                      {isLoadingRecords ? (
                        <div className="text-sm text-muted-foreground">Loading records...</div>
                      ) : runError ? (
                        <div className="text-sm text-destructive">{runError}</div>
                      ) : runRecords.length === 0 ? (
                        <div className="text-sm text-muted-foreground">No records extracted.</div>
                      ) : (
                        <div className="space-y-2">
                          {runRecords.map(record => {
                            const summary = truncate(getRecordSummary(record), 100)
                            const excerpt = record.sourceExcerpt
                              ? truncate(record.sourceExcerpt, 220)
                              : 'No source excerpt available.'

                            return (
                              <Link
                                key={record.id}
                                to={`/memories?id=${encodeURIComponent(record.id)}`}
                                className="block rounded-md border border-border bg-secondary/30 px-3 py-2 hover:bg-secondary/50 transition-base"
                              >
                                <div className="flex items-center gap-2 mb-1">
                                  <span
                                    className="w-2 h-2 rounded-full"
                                    style={{ backgroundColor: TYPE_COLORS[record.type] }}
                                  />
                                  <span className="text-xs text-muted-foreground uppercase tracking-wide">
                                    {record.type}
                                  </span>
                                  <span className="text-xs text-muted-foreground font-mono truncate">
                                    {record.id}
                                  </span>
                                  <ExternalLink className="w-3 h-3 text-muted-foreground ml-auto" />
                                </div>
                                <div className="text-sm text-foreground mb-1 truncate">{summary}</div>
                                <div className="text-xs text-muted-foreground font-mono">{excerpt}</div>
                              </Link>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div className="flex items-center justify-between">
        <button
          onClick={() => setOffset(o => Math.max(0, o - PAGE_SIZE))}
          disabled={offset === 0}
          className="flex items-center gap-1 h-8 px-3 text-sm rounded-md border border-border bg-background disabled:opacity-40 disabled:cursor-not-allowed hover:bg-secondary transition-base"
        >
          Previous
        </button>
        <span className="text-sm text-muted-foreground">{pageInfo()}</span>
        <button
          onClick={() => setOffset(o => o + PAGE_SIZE)}
          disabled={total !== null && offset + PAGE_SIZE >= total}
          className="flex items-center gap-1 h-8 px-3 text-sm rounded-md border border-border bg-background disabled:opacity-40 disabled:cursor-not-allowed hover:bg-secondary transition-base"
        >
          Next
        </button>
      </div>
    </div>
  )
}
