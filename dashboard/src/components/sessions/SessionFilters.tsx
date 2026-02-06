import { Search } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import FilterChip from '@/components/FilterChip'
import { SORT_OPTIONS, TIME_FILTERS, type SortKey, type TimeFilterKey } from './utils'

export default function SessionFilters({
  searchQuery,
  onSearchChange,
  projectFilter,
  onProjectFilterChange,
  projectOptions,
  sortKey,
  onSortChange,
  timeFilter,
  onTimeFilterChange,
  hasMemoriesOnly,
  onHasMemoriesOnlyChange,
  hasReviewsOnly,
  onHasReviewsOnlyChange,
  activeOnly,
  onActiveOnlyChange,
  filteredCount,
  totalCount
}: {
  searchQuery: string
  onSearchChange: (value: string) => void
  projectFilter: string
  onProjectFilterChange: (value: string) => void
  projectOptions: Array<{ key: string; label: string }>
  sortKey: SortKey
  onSortChange: (value: SortKey) => void
  timeFilter: TimeFilterKey
  onTimeFilterChange: (value: TimeFilterKey) => void
  hasMemoriesOnly: boolean
  onHasMemoriesOnlyChange: (value: boolean) => void
  hasReviewsOnly: boolean
  onHasReviewsOnlyChange: (value: boolean) => void
  activeOnly: boolean
  onActiveOnlyChange: (value: boolean) => void
  filteredCount: number
  totalCount: number
}) {
  return (
    <section className="rounded-xl border border-border bg-card px-4 py-3 space-y-3 shrink-0">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[180px] flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60 z-10" />
          <Input
            value={searchQuery}
            onChange={event => onSearchChange(event.target.value)}
            placeholder="Search..."
            className="h-8 pl-8 bg-secondary"
          />
        </div>
        <Select value={projectFilter} onValueChange={onProjectFilterChange}>
          <SelectTrigger className="h-8 w-auto min-w-[120px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All projects</SelectItem>
            {projectOptions.map(option => (
              <SelectItem key={option.key} value={option.key}>{option.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={sortKey} onValueChange={value => onSortChange(value as SortKey)}>
          <SelectTrigger className="h-8 w-auto min-w-[120px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SORT_OPTIONS.map(option => (
              <SelectItem key={option.key} value={option.key}>{option.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex items-center gap-1">
          {TIME_FILTERS.map(filter => (
            <FilterChip
              key={filter.key}
              active={timeFilter === filter.key}
              onClick={() => onTimeFilterChange(filter.key)}
            >
              {filter.label}
            </FilterChip>
          ))}
        </div>
        <div className="ml-auto text-xs text-muted-foreground">
          {filteredCount}/{totalCount}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <FilterChip active={hasMemoriesOnly} onClick={() => onHasMemoriesOnlyChange(!hasMemoriesOnly)}>
          Has memories
        </FilterChip>
        <FilterChip active={hasReviewsOnly} onClick={() => onHasReviewsOnlyChange(!hasReviewsOnly)}>
          Has reviews
        </FilterChip>
        <FilterChip active={activeOnly} onClick={() => onActiveOnlyChange(!activeOnly)}>
          Active now
        </FilterChip>
      </div>
    </section>
  )
}
