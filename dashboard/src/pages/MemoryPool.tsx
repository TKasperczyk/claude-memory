import { useEffect, useMemo, useState } from 'react'
import { Search, ChevronLeft, ChevronRight } from 'lucide-react'
import { PageHeader } from '@/App'
import MemoryDetail from '@/components/MemoryDetail'
import MemoryTable from '@/components/MemoryTable'
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

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => setSearchQuery(searchInput.trim()), 300)
    return () => clearTimeout(timer)
  }, [searchInput])

  // Reset offset on filter change
  useEffect(() => {
    setOffset(0)
  }, [typeFilter, projectFilter, showDeprecated, searchQuery])

  // Fetch data
  useEffect(() => {
    let active = true

    const run = async () => {
      setLoading(true)
      setError(null)

      try {
        if (searchQuery) {
          const response = await searchMemories({
            query: searchQuery,
            limit: SEARCH_LIMIT,
            type: typeFilter === 'all' ? undefined : typeFilter,
            project: projectFilter === 'all' ? undefined : projectFilter,
            deprecated: showDeprecated
          })
          if (!active) return
          const results = response.results.map(r => r.record)
          const total = response.total ?? results.length
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
        if (active) setLoading(false)
      }
    }

    run()
    return () => { active = false }
  }, [typeFilter, projectFilter, showDeprecated, searchQuery, offset])

  const pageInfo = () => {
    if (loading) return 'Loading…'
    if (error) return 'Error'
    if (!records.length) return 'No results'
    const start = offset + 1
    const end = offset + records.length
    return totalCount ? `${start}–${end} of ${totalCount}` : `${start}–${end}`
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Memories"
        description="Browse and search stored memory records"
      />

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-4">
        {/* Search */}
        <div className="flex-1 min-w-[200px]">
          <label className="block text-xs text-muted-foreground mb-1.5">Search</label>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input
              type="text"
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              placeholder="Search memories…"
              className="w-full h-9 pl-9 pr-3 rounded-md border border-border bg-background text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
        </div>

        {/* Type */}
        <div className="w-32">
          <label className="block text-xs text-muted-foreground mb-1.5">Type</label>
          <select
            value={typeFilter}
            onChange={e => setTypeFilter(e.target.value as RecordType | 'all')}
            className="w-full h-9 px-3 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          >
            {TYPE_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        {/* Project */}
        <div className="w-40">
          <label className="block text-xs text-muted-foreground mb-1.5">Project</label>
          <select
            value={projectFilter}
            onChange={e => setProjectFilter(e.target.value)}
            className="w-full h-9 px-3 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          >
            <option value="all">All projects</option>
            {projectOptions.map(p => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </div>

        {/* Deprecated toggle */}
        <label className="flex items-center gap-2 h-9 px-3 rounded-md border border-border bg-background cursor-pointer">
          <input
            type="checkbox"
            checked={showDeprecated}
            onChange={e => setShowDeprecated(e.target.checked)}
            className="w-4 h-4 rounded border-border"
          />
          <span className="text-sm text-muted-foreground">Deprecated</span>
        </label>
      </div>

      {/* Search indicator */}
      {searchQuery && (
        <div className="text-sm text-muted-foreground">
          Searching for "<span className="text-foreground">{searchQuery}</span>"
          {totalCount !== null && totalCount >= SEARCH_LIMIT && (
            <span className="ml-2">(showing top {SEARCH_LIMIT})</span>
          )}
        </div>
      )}

      {/* Table */}
      {loading ? (
        <div className="py-12 text-center text-sm text-muted-foreground">Loading…</div>
      ) : error ? (
        <div className="py-12 text-center text-sm text-destructive">Failed to load memories</div>
      ) : (
        <MemoryTable
          records={records}
          onSelect={setSelected}
          emptyMessage="No memories match these filters"
        />
      )}

      {/* Pagination */}
      <div className="flex items-center justify-between">
        <button
          onClick={() => setOffset(o => Math.max(0, o - PAGE_SIZE))}
          disabled={offset === 0}
          className="flex items-center gap-1 h-8 px-3 text-sm rounded-md border border-border bg-background disabled:opacity-40 disabled:cursor-not-allowed hover:bg-secondary transition-base"
        >
          <ChevronLeft className="w-4 h-4" />
          Previous
        </button>
        <span className="text-sm text-muted-foreground">{pageInfo()}</span>
        <button
          onClick={() => setOffset(o => o + PAGE_SIZE)}
          disabled={!hasMore}
          className="flex items-center gap-1 h-8 px-3 text-sm rounded-md border border-border bg-background disabled:opacity-40 disabled:cursor-not-allowed hover:bg-secondary transition-base"
        >
          Next
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>

      {/* Detail modal */}
      <MemoryDetail record={selected} onClose={() => setSelected(null)} />
    </div>
  )
}
