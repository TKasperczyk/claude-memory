import { PageHeader } from '@/App'
import StatsCard from '@/components/StatsCard'
import { useApi } from '@/hooks/useApi'
import { fetchStats, type RecordType } from '@/lib/api'

const TYPE_CONFIG: Record<RecordType, { label: string; color: string }> = {
  command: { label: 'Commands', color: '#2dd4bf' },
  error: { label: 'Errors', color: '#f43f5e' },
  discovery: { label: 'Discoveries', color: '#60a5fa' },
  procedure: { label: 'Procedures', color: '#a78bfa' },
}

function formatNumber(value: number, decimals = 0): string {
  return new Intl.NumberFormat('en', {
    maximumFractionDigits: decimals,
    minimumFractionDigits: decimals,
  }).format(value)
}

function DistributionBar({ data }: { data: { type: RecordType; count: number }[] }) {
  const total = data.reduce((sum, d) => sum + d.count, 0)
  if (total === 0) return null

  return (
    <div className="space-y-4">
      {/* Bar */}
      <div className="flex h-2.5 rounded-full overflow-hidden bg-secondary/60">
        {data.map(({ type, count }) => {
          const percent = (count / total) * 100
          if (percent === 0) return null
          return (
            <div
              key={type}
              className="transition-all duration-300"
              style={{ width: `${percent}%`, backgroundColor: TYPE_CONFIG[type].color }}
            />
          )
        })}
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-x-8 gap-y-2">
        {data.map(({ type, count }) => (
          <div key={type} className="flex items-center gap-2.5">
            <span
              className="w-2.5 h-2.5 rounded-full ring-2 ring-background"
              style={{ backgroundColor: TYPE_CONFIG[type].color }}
            />
            <span className="text-sm text-muted-foreground">
              {TYPE_CONFIG[type].label}
            </span>
            <span className="text-sm font-semibold tabular-nums">{count}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function TopList({
  title,
  data
}: {
  title: string
  data: { name: string; value: number }[]
}) {
  if (data.length === 0) {
    return (
      <div>
        <h3 className="section-header mb-4">{title}</h3>
        <p className="text-sm text-muted-foreground">No data yet</p>
      </div>
    )
  }

  const maxValue = Math.max(...data.map(d => d.value))

  return (
    <div>
      <h3 className="section-header mb-5">{title}</h3>
      <div className="space-y-4">
        {data.slice(0, 6).map(({ name, value }) => (
          <div key={name}>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-sm truncate pr-3" title={name}>{name}</span>
              <span className="text-sm font-medium tabular-nums text-foreground/80">
                {value}
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-secondary/50 overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-foreground/30 to-foreground/20 rounded-full transition-all duration-300"
                style={{ width: `${(value / maxValue) * 100}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function Overview() {
  const { data, error, loading } = useApi(fetchStats, [])

  if (loading) {
    return (
      <div>
        <PageHeader title="Overview" />
        <div className="text-sm text-muted-foreground">Loading...</div>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div>
        <PageHeader title="Overview" />
        <div className="text-sm text-destructive">Failed to load statistics</div>
      </div>
    )
  }

  const typeData = (['command', 'error', 'discovery', 'procedure'] as const).map(type => ({
    type,
    count: data.byType[type] ?? 0,
  }))

  const projectData = Object.entries(data.byProject)
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value)

  const domainData = Object.entries(data.byDomain)
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value)

  const usagePercent = Math.round(data.avgUsageRatio * 100)

  return (
    <div className="space-y-8">
      <PageHeader
        title="Overview"
        description="Memory system statistics and distribution"
      />

      {/* Key Metrics */}
      <section className="p-6 rounded-xl border border-border bg-card">
        <h2 className="section-header mb-6">Metrics</h2>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-x-8 gap-y-6">
          <StatsCard label="Total memories" value={formatNumber(data.total)} />
          <StatsCard label="Deprecated" value={formatNumber(data.deprecated)} />
          <StatsCard
            label="Avg retrievals"
            value={formatNumber(data.avgRetrievalCount, 1)}
          />
          <StatsCard
            label="Avg usage"
            value={formatNumber(data.avgUsageCount, 1)}
          />
          <StatsCard
            label="Usage ratio"
            value={`${usagePercent}%`}
            subtext="Helpfulness score"
          />
        </div>
      </section>

      {/* Distribution */}
      <section className="p-6 rounded-xl border border-border bg-card">
        <h2 className="section-header mb-5">Type distribution</h2>
        <DistributionBar data={typeData} />
      </section>

      {/* Lists */}
      <div className="grid md:grid-cols-2 gap-6">
        <section className="p-6 rounded-xl border border-border bg-card">
          <TopList title="Top projects" data={projectData} />
        </section>
        <section className="p-6 rounded-xl border border-border bg-card">
          <TopList title="Top domains" data={domainData} />
        </section>
      </div>
    </div>
  )
}
