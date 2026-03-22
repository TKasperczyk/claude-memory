import { Search, X } from 'lucide-react'
import FilterChip from '@/components/FilterChip'
import { TIME_FILTERS, type TimeFilterKey } from './utils'

export default function ExtractionFilters({
  timeFilter,
  onTimeFilterChange,
  sessionSearch,
  onSessionSearchChange,
  filteredCount,
  totalCount
}: {
  timeFilter: TimeFilterKey
  onTimeFilterChange: (value: TimeFilterKey) => void
  sessionSearch: string
  onSessionSearchChange: (value: string) => void
  filteredCount: number
  totalCount: number
}) {
  return (
    <section className="rounded-xl border border-border bg-card px-4 py-3 shrink-0">
      <div className="flex flex-wrap items-center gap-3">
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
        <div className="relative flex items-center">
          <Search className="absolute left-2 w-3 h-3 text-muted-foreground/50" />
          <input
            type="text"
            placeholder="Session ID..."
            value={sessionSearch}
            onChange={e => onSessionSearchChange(e.target.value)}
            className="h-7 w-40 rounded-md border border-border bg-background pl-7 pr-7 text-xs placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-ring"
          />
          {sessionSearch && (
            <button
              onClick={() => onSessionSearchChange('')}
              className="absolute right-1.5 p-0.5 rounded hover:bg-muted"
            >
              <X className="w-3 h-3 text-muted-foreground/70" />
            </button>
          )}
        </div>
        <div className="ml-auto text-xs text-muted-foreground/70 font-medium tabular-nums">
          {filteredCount}/{totalCount}
        </div>
      </div>
    </section>
  )
}
