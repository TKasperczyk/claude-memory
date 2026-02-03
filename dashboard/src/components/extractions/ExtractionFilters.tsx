import FilterChip from '@/components/FilterChip'
import { TIME_FILTERS, type TimeFilterKey } from './utils'

export default function ExtractionFilters({
  timeFilter,
  onTimeFilterChange,
  filteredCount,
  totalCount
}: {
  timeFilter: TimeFilterKey
  onTimeFilterChange: (value: TimeFilterKey) => void
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
        <div className="ml-auto text-xs text-muted-foreground/70 font-medium tabular-nums">
          {filteredCount}/{totalCount}
        </div>
      </div>
    </section>
  )
}
