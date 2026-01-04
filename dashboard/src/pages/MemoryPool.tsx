import { useEffect, useMemo, useState } from 'react'
import MemoryDetail from '@/components/MemoryDetail'
import MemoryTable from '@/components/MemoryTable'
import TypeBadge from '@/components/TypeBadge'
import { useApi } from '@/hooks/useApi'
import {
  fetchMemories,
  fetchStats,
  searchMemories,
  type MemoryRecord,
  type RecordType
} from '@/lib/api'

const PAGE_SIZE = 50
const SEARCH_LIMIT = 200

const TYPE_OPTIONS: Array<{ label: string; value: RecordType | 'all' }> = [
  { label: 'All types', value: 'all' },
  { label: 'Command', value: 'command' },
  { label: 'Error', value: 'error' },
  { label: 'Discovery', value: 'discovery' },
  { label: 'Procedure', value: 'procedure' }
]

export default function MemoryPool() {
  const [typeFilter, setTypeFilter] = useState<RecordType | 'all'>('all')
  const [projectFilter, setProjectFilter] = useState('all')
  const [showDeprecated, setShowDeprecated] = useState(false)
  const [searchInput, setSearchInput] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [records, setRecords] = useState<MemoryRecord[]>([])
  const [totalCount, setTotalCount] = useState<number | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [selected, setSelected] = useState<MemoryRecord | null>(null)

  const { data: stats } = useApi(fetchStats, [])

  const projectOptions = useMemo(() => {
    if (!stats?.byProject) return []
    return Object.entries(stats.byProject)
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name)
  }, [stats])

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearchQuery(searchInput.trim())
    }, 350)

    return () => clearTimeout(timer)
  }, [searchInput])

  useEffect(() => {
    setOffset(0)
  }, [typeFilter, projectFilter, showDeprecated, searchQuery])

  useEffect(() => {
    let active = true

    const run = async () => {
      setLoading(true)
      setError(null)

      try {
        if (searchQuery) {
          const searchResponse = await searchMemories({
            query: searchQuery,
            limit: SEARCH_LIMIT,
            type: typeFilter === 'all' ? undefined : typeFilter,
            project: projectFilter === 'all' ? undefined : projectFilter,
            deprecated: showDeprecated
          })
          if (!active) return
          const results = searchResponse.results.map(result => result.record)
          const total = searchResponse.total ?? results.length
          setTotalCount(total)
          setHasMore(offset + PAGE_SIZE < total)
          setRecords(results.slice(offset, offset + PAGE_SIZE))
        } else {
          const response = await fetchMemories({
            limit: PAGE_SIZE,
            offset,
            type: typeFilter === 'all' ? undefined : typeFilter,
            project: projectFilter === 'all' ? undefined : projectFilter,
            deprecated: showDeprecated
          })

          if (!active) return
          setRecords(response.records)
          setTotalCount(response.total)
          setHasMore(offset + PAGE_SIZE < response.total)
        }
      } catch (err) {
        if (!active) return
        setError(err as Error)
      } finally {
        if (!active) return
        setLoading(false)
      }
    }

    run()

    return () => {
      active = false
    }
  }, [typeFilter, projectFilter, showDeprecated, searchQuery, offset])

  const pageLabel = () => {
    if (loading) return 'Loading...'
    if (error) return 'Unable to load'
    if (!records.length) return 'No results'
    const start = offset + 1
    const end = offset + records.length
    if (totalCount !== null) {
      return `Showing ${start}-${end} of ${totalCount} results`
    }
    return `Showing ${start}-${end}`
  }

  return (
    <div className="space-y-6 animate-fade-up">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.3em] text-sky-300">Memory pool</p>
          <h1 className="mt-2 text-3xl font-semibold text-white">Filter every stored memory.</h1>
        </div>
        <div className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-xs uppercase tracking-[0.3em] text-slate-400">
          {pageLabel()}
        </div>
      </header>

      <div className="grid gap-4 rounded-2xl border border-white/10 bg-[color:var(--panel)] p-4 md:grid-cols-[1fr_1fr_auto_auto]">
        <label className="text-xs uppercase tracking-[0.2em] text-slate-400">
          Search
          <input
            value={searchInput}
            onChange={event => setSearchInput(event.target.value)}
            placeholder="Find commands, errors, procedures..."
            className="mt-2 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-emerald-400 focus:outline-none"
          />
        </label>
        <label className="text-xs uppercase tracking-[0.2em] text-slate-400">
          Type
          <select
            value={typeFilter}
            onChange={event => setTypeFilter(event.target.value as RecordType | 'all')}
            className="mt-2 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-100 focus:border-emerald-400 focus:outline-none"
          >
            {TYPE_OPTIONS.map(option => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs uppercase tracking-[0.2em] text-slate-400">
          Project
          <select
            value={projectFilter}
            onChange={event => setProjectFilter(event.target.value)}
            className="mt-2 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-100 focus:border-emerald-400 focus:outline-none"
          >
            <option value="all">All projects</option>
            {projectOptions.map(project => (
              <option key={project} value={project}>
                {project}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-end gap-2 text-xs uppercase tracking-[0.2em] text-slate-400">
          <input
            type="checkbox"
            checked={showDeprecated}
            onChange={event => setShowDeprecated(event.target.checked)}
            className="h-4 w-4 rounded border-white/20 bg-black/40 text-emerald-400"
          />
          Include deprecated
        </label>
      </div>

      {searchQuery ? (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-slate-300">
          <span>Search results for</span>
          <span className="rounded-full border border-emerald-400/40 bg-emerald-400/10 px-3 py-1 text-xs uppercase tracking-[0.2em] text-emerald-200">
            {searchQuery}
          </span>
          {totalCount !== null && totalCount >= SEARCH_LIMIT ? (
            <span className="text-xs uppercase tracking-[0.2em] text-slate-500">
              Showing top {SEARCH_LIMIT}
            </span>
          ) : null}
        </div>
      ) : null}

      {loading ? (
        <div className="rounded-2xl border border-white/10 bg-white/5 p-10 text-center text-sm text-slate-400">
          Loading memories...
        </div>
      ) : error ? (
        <div className="rounded-2xl border border-rose-500/30 bg-rose-500/10 p-10 text-center text-sm text-rose-200">
          Failed to load memories.
        </div>
      ) : (
        <MemoryTable
          records={records}
          onSelect={record => setSelected(record)}
          emptyMessage="No memories match these filters."
        />
      )}

      <div className="flex items-center justify-between">
        <button
          onClick={() => setOffset(current => Math.max(0, current - PAGE_SIZE))}
          disabled={offset === 0}
          className="rounded-full border border-white/10 px-4 py-2 text-xs uppercase tracking-[0.2em] text-slate-300 transition enabled:hover:border-white/30 disabled:opacity-40"
        >
          Previous
        </button>
        <div className="flex items-center gap-2 text-xs uppercase tracking-[0.2em] text-slate-500">
          <TypeBadge type="command" />
          <span>Tap a row for detail</span>
        </div>
        <button
          onClick={() => setOffset(current => current + PAGE_SIZE)}
          disabled={!hasMore}
          className="rounded-full border border-white/10 px-4 py-2 text-xs uppercase tracking-[0.2em] text-slate-300 transition enabled:hover:border-white/30 disabled:opacity-40"
        >
          Next
        </button>
      </div>

      <MemoryDetail record={selected} onClose={() => setSelected(null)} />
    </div>
  )
}
