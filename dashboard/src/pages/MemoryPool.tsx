import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Search, ChevronLeft, ChevronRight } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { PageHeader } from '@/App'
import MemoryDetail from '@/components/MemoryDetail'
import MemoryTable from '@/components/MemoryTable'
import { SEARCH_LIMIT, useMemories, useMemoryTypes, useStats } from '@/hooks/queries'
import {
  fetchMemory,
  type MemoryRecord,
  type RecordType
} from '@/lib/api'

const PAGE_SIZE = 50
export default function MemoryPool() {
  const [typeFilter, setTypeFilter] = useState<RecordType | 'all'>('all')
  const [projectFilter, setProjectFilter] = useState('all')
  const [showDeprecated, setShowDeprecated] = useState(false)
  const [searchInput, setSearchInput] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [page, setPage] = useState(0)
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const [selected, setSelected] = useState<MemoryRecord | null>(null)
  const [searchParams, setSearchParams] = useSearchParams()
  const selectedId = searchParams.get('id')
  const queryClient = useQueryClient()

  const { data: stats } = useStats()
  const { data: memoryTypes } = useMemoryTypes()

  const projectOptions = useMemo(() => {
    if (!stats?.byProject) return []
    return Object.entries(stats.byProject)
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name)
  }, [stats])

  const typeOptions = useMemo(() => {
    const types = memoryTypes?.length ? memoryTypes : ['command', 'error', 'discovery', 'procedure']
    return [
      { label: 'All types', value: 'all' as const },
      ...types.map(type => ({ label: type[0].toUpperCase() + type.slice(1), value: type }))
    ]
  }, [memoryTypes])

  const pageOffset = page * PAGE_SIZE
  const { data: memoriesData, error: memoriesError, isPending, isFetching } = useMemories({
    page,
    limit: PAGE_SIZE,
    type: typeFilter === 'all' ? undefined : typeFilter,
    search: searchQuery || undefined,
    project: projectFilter === 'all' ? undefined : projectFilter,
    deprecated: showDeprecated
  })
  const records = memoriesData?.records ?? []
  const totalCount = memoriesData?.total ?? null
  const hasMore = totalCount !== null && pageOffset + PAGE_SIZE < totalCount

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => setSearchQuery(searchInput.trim()), 300)
    return () => clearTimeout(timer)
  }, [searchInput])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 3500)
    return () => clearTimeout(timer)
  }, [notice])

  // Reset page on filter change
  useEffect(() => {
    setPage(0)
  }, [typeFilter, projectFilter, showDeprecated, searchQuery])

  useEffect(() => {
    let active = true

    const loadSelected = async () => {
      if (!selectedId) {
        if (selected) setSelected(null)
        return
      }

      if (selected?.id === selectedId) return

      try {
        const record = await fetchMemory(selectedId)
        if (active) setSelected(record)
      } catch {
        if (active) setSelected(null)
      }
    }

    loadSelected()
    return () => { active = false }
  }, [selectedId, selected])

  const handleSelect = (record: MemoryRecord) => {
    setSelected(record)
    const next = new URLSearchParams(searchParams)
    next.set('id', record.id)
    setSearchParams(next)
  }

  const handleClose = () => {
    setSelected(null)
    if (selectedId) {
      const next = new URLSearchParams(searchParams)
      next.delete('id')
      setSearchParams(next)
    }
  }

  const handleDeleted = (id: string) => {
    setNotice({ type: 'success', message: `Deleted memory ${id}` })
    queryClient.invalidateQueries({ queryKey: ['memories'] })
    queryClient.invalidateQueries({ queryKey: ['stats'] })
  }

  const pageInfo = () => {
    if (isPending || isFetching) return 'Loading…'
    if (memoriesError && !memoriesData) return 'Error'
    if (!records.length) return 'No results'
    const start = pageOffset + 1
    const end = pageOffset + records.length
    return totalCount ? `${start}–${end} of ${totalCount}` : `${start}–${end}`
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Memories"
        description="Browse and search stored memory records"
      />

      {memoriesError && memoriesData && (
        <div className="bg-amber-500/10 text-amber-400 text-sm px-3 py-2 rounded mb-4">
          Failed to refresh data. Showing cached results.
        </div>
      )}

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
            {typeOptions.map(opt => (
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

      {notice && (
        <div className={`text-sm ${notice.type === 'success' ? 'text-emerald-400' : 'text-destructive'}`}>
          {notice.message}
        </div>
      )}

      {/* Table */}
      {isPending ? (
        <div className="py-12 text-center text-sm text-muted-foreground">Loading…</div>
      ) : memoriesError && !memoriesData ? (
        <div className="py-12 text-center text-sm text-destructive">Failed to load memories</div>
      ) : (
        <MemoryTable
          records={records}
          onSelect={handleSelect}
          emptyMessage="No memories match these filters"
        />
      )}

      {/* Pagination */}
      <div className="flex items-center justify-between">
        <button
          onClick={() => setPage(p => Math.max(0, p - 1))}
          disabled={page === 0}
          className="flex items-center gap-1 h-8 px-3 text-sm rounded-md border border-border bg-background disabled:opacity-40 disabled:cursor-not-allowed hover:bg-secondary transition-base"
        >
          <ChevronLeft className="w-4 h-4" />
          Previous
        </button>
        <span className="text-sm text-muted-foreground">{pageInfo()}</span>
        <button
          onClick={() => setPage(p => p + 1)}
          disabled={!hasMore}
          className="flex items-center gap-1 h-8 px-3 text-sm rounded-md border border-border bg-background disabled:opacity-40 disabled:cursor-not-allowed hover:bg-secondary transition-base"
        >
          Next
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>

      {/* Detail modal */}
      <MemoryDetail record={selected} onClose={handleClose} onDeleted={handleDeleted} />
    </div>
  )
}
