import { useEffect, useMemo, useState } from 'react'
import { Search, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Checkbox } from '@/components/ui/checkbox'
import { Alert, AlertDescription } from '@/components/ui/alert'
import MemoryDetail from '@/components/MemoryDetail'
import MemoryTable from '@/components/MemoryTable'
import { useMemories, useMemoryTypes, useStats } from '@/hooks/queries'
import { useSelectedMemory } from '@/hooks/useSelectedMemory'
import { type RecordType } from '@/lib/api'

const PAGE_SIZE = 50

function MemoryTableSkeleton() {
  const rows = Array.from({ length: 8 })

  return (
    <div className="border border-border rounded-xl overflow-hidden">
      <div className="bg-secondary/30 border-b border-border px-4 py-3 grid grid-cols-[16px_1fr_7rem_7rem_4rem_4rem_3rem] gap-3 items-center">
        <Skeleton className="h-3 w-3 rounded-full" />
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-3 w-8 ml-auto" />
        <Skeleton className="h-3 w-8 ml-auto" />
        <Skeleton className="h-3 w-6 ml-auto" />
      </div>
      <div className="divide-y divide-border">
        {rows.map((_, index) => (
          <div
            key={index}
            className="px-4 py-3 grid grid-cols-[16px_1fr_7rem_7rem_4rem_4rem_3rem] gap-3 items-center"
          >
            <Skeleton className="h-2.5 w-2.5 rounded-full" />
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-3 w-10 ml-auto" />
            <Skeleton className="h-3 w-10 ml-auto" />
            <Skeleton className="h-3 w-8 ml-auto" />
          </div>
        ))}
      </div>
    </div>
  )
}

export default function MemoryPool() {
  const [typeFilter, setTypeFilter] = useState<RecordType | 'all'>('all')
  const [projectFilter, setProjectFilter] = useState('all')
  const [showDeprecated, setShowDeprecated] = useState(false)
  const [searchInput, setSearchInput] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [page, setPage] = useState(0)
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const { selectedId, selected, detailLoading, detailError, handleSelect, handleClose } = useSelectedMemory()
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
  const displayOffset = memoriesData?.offset ?? pageOffset

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

  const handleDeleted = (id: string) => {
    setNotice({ type: 'success', message: `Deleted memory ${id}` })
    queryClient.invalidateQueries({ queryKey: ['memories'] })
    queryClient.invalidateQueries({ queryKey: ['stats'] })
  }

  const pageInfo = () => {
    if (isPending && !memoriesData) return 'Loading...'
    if (memoriesError && !memoriesData) return 'Error'
    if (!records.length) return 'No results'
    const start = displayOffset + 1
    const end = displayOffset + records.length
    return totalCount ? `${start}–${end} of ${totalCount}` : `${start}–${end}`
  }

  const isInitialLoading = isPending && !memoriesData
  const isRefreshing = isFetching && !isInitialLoading

  return (
    <div className="flex-1 min-h-0 overflow-y-auto space-y-5">
      {memoriesError && memoriesData && (
        <Alert className="bg-warning/10 border-warning/20">
          <AlertDescription className="text-warning">
            Failed to refresh data. Showing cached results.
          </AlertDescription>
        </Alert>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3">
        {/* Search */}
        <div className="flex-1 min-w-[220px]">
          <label className="block text-[11px] uppercase tracking-wide text-muted-foreground/70 mb-1.5 font-medium">Search</label>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/60" />
            <Input
              type="text"
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              placeholder="Search memories…"
              className="pl-9 bg-secondary"
            />
          </div>
        </div>

        {/* Type */}
        <div className="w-32">
          <label className="block text-[11px] uppercase tracking-wide text-muted-foreground/70 mb-1.5 font-medium">Type</label>
          <select
            value={typeFilter}
            onChange={e => setTypeFilter(e.target.value as RecordType | 'all')}
            className="w-full h-9 px-3 rounded-lg border border-input bg-secondary text-sm focus:outline-none focus:ring-2 focus:ring-ring cursor-pointer transition-colors"
          >
            {typeOptions.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        {/* Project */}
        <div className="w-40">
          <label className="block text-[11px] uppercase tracking-wide text-muted-foreground/70 mb-1.5 font-medium">Project</label>
          <select
            value={projectFilter}
            onChange={e => setProjectFilter(e.target.value)}
            className="w-full h-9 px-3 rounded-lg border border-input bg-secondary text-sm focus:outline-none focus:ring-2 focus:ring-ring cursor-pointer transition-colors"
          >
            <option value="all">All projects</option>
            {projectOptions.map(p => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </div>

        {/* Deprecated toggle */}
        <label className="flex items-center gap-2.5 h-9 px-3 rounded-lg border border-input bg-secondary cursor-pointer hover:bg-secondary/80 transition-colors">
          <Checkbox
            checked={showDeprecated}
            onCheckedChange={(checked) => setShowDeprecated(checked === true)}
          />
          <span className="text-sm text-muted-foreground">Deprecated</span>
        </label>
      </div>

      {/* Search indicator */}
      {searchQuery && (
        <div className="text-sm text-muted-foreground">
          Searching for "<span className="text-foreground">{searchQuery}</span>"
          {totalCount !== null && (
            <span className="ml-2">({totalCount} match{totalCount === 1 ? '' : 'es'})</span>
          )}
        </div>
      )}

      {notice && (
        <div className={`text-sm ${notice.type === 'success' ? 'text-success' : 'text-destructive'}`}>
          {notice.message}
        </div>
      )}

      {isRefreshing && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="w-3 h-3 animate-spin" />
          Updating results...
        </div>
      )}

      {/* Table */}
      {isInitialLoading ? (
        <MemoryTableSkeleton />
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
      <div className="flex items-center justify-between py-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setPage(p => Math.max(0, p - 1))}
          disabled={page === 0}
        >
          <ChevronLeft className="w-4 h-4" />
          Previous
        </Button>
        <span className="text-sm text-muted-foreground font-medium tabular-nums">{pageInfo()}</span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setPage(p => p + 1)}
          disabled={!hasMore}
        >
          Next
          <ChevronRight className="w-4 h-4" />
        </Button>
      </div>

      {/* Detail modal */}
      <MemoryDetail
        record={selected}
        open={Boolean(selectedId)}
        loading={detailLoading}
        error={detailError}
        onClose={handleClose}
        onDeleted={handleDeleted}
      />
    </div>
  )
}
