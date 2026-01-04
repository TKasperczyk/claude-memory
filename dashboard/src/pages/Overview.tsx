import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'
import StatsCard from '@/components/StatsCard'
import { useApi } from '@/hooks/useApi'
import { fetchStats, type RecordType } from '@/lib/api'

const TYPE_ORDER: RecordType[] = ['command', 'error', 'discovery', 'procedure']

const TYPE_LABELS: Record<RecordType, string> = {
  command: 'Command',
  error: 'Error',
  discovery: 'Discovery',
  procedure: 'Procedure'
}

const TYPE_COLORS: Record<RecordType, string> = {
  command: '#34d399',
  error: '#fb7185',
  discovery: '#60a5fa',
  procedure: '#fbbf24'
}

function formatNumber(value: number, digits = 0): string {
  return new Intl.NumberFormat('en', {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits
  }).format(value)
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`
}

function buildBreakdown(source: Record<string, number>, limit = 8) {
  const entries = Object.entries(source)
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value)

  if (entries.length <= limit) return entries

  const top = entries.slice(0, limit)
  const restValue = entries.slice(limit).reduce((sum, entry) => sum + entry.value, 0)
  if (restValue > 0) top.push({ name: 'other', value: restValue })
  return top
}

export default function Overview() {
  const { data, error, loading } = useApi(fetchStats, [])

  if (loading) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/5 p-10 text-center text-sm text-slate-400">
        Loading overview...
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="rounded-2xl border border-rose-500/30 bg-rose-500/10 p-10 text-center text-sm text-rose-200">
        Failed to load overview data.
      </div>
    )
  }

  const typeData = TYPE_ORDER.map(type => ({
    name: TYPE_LABELS[type],
    value: data.byType[type] ?? 0,
    type
  }))

  const projectData = buildBreakdown(data.byProject)
  const domainData = buildBreakdown(data.byDomain)

  const statCards = [
    {
      title: 'Total memories',
      value: formatNumber(data.total),
      detail: 'Active + deprecated',
      accentClassName: 'text-emerald-300'
    },
    {
      title: 'Deprecated',
      value: formatNumber(data.deprecated),
      detail: 'Marked for retirement',
      accentClassName: 'text-rose-300'
    },
    {
      title: 'Avg retrievals',
      value: formatNumber(data.avgRetrievalCount, 1),
      detail: 'Per injected memory',
      accentClassName: 'text-sky-300'
    },
    {
      title: 'Avg usage',
      value: formatNumber(data.avgUsageCount, 1),
      detail: 'Helpful ratings per inject',
      accentClassName: 'text-cyan-300'
    },
    {
      title: 'Usage ratio',
      value: formatPercent(data.avgUsageRatio),
      detail: 'Avg helpfulness rate',
      accentClassName: 'text-amber-300'
    }
  ]

  return (
    <div className="space-y-8 animate-fade-up">
      <header className="space-y-3">
        <p className="text-xs uppercase tracking-[0.3em] text-emerald-300">Overview</p>
        <h1 className="text-3xl font-semibold text-white">Memory telemetry in one glance.</h1>
        <p className="max-w-2xl text-sm text-slate-400">
          Track how Claude Memory is growing, where it is strongest, and which signals are pulling their
          weight.
        </p>
      </header>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        {statCards.map((card, index) => (
          <div
            key={card.title}
            className="animate-fade-up"
            style={{ animationDelay: `${index * 90}ms` }}
          >
            <StatsCard {...card} />
          </div>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.1fr_1fr]">
        <div className="rounded-2xl border border-white/10 bg-[color:var(--panel)] p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-white">Memory mix</h2>
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">By type</p>
          </div>
          <div className="mt-6 h-72">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={typeData}
                  dataKey="value"
                  nameKey="name"
                  innerRadius={70}
                  outerRadius={110}
                  paddingAngle={4}
                >
                  {typeData.map(entry => (
                    <Cell key={entry.type} fill={TYPE_COLORS[entry.type]} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{
                    background: '#0f172a',
                    border: '1px solid rgba(255,255,255,0.1)',
                    color: '#e2e8f0'
                  }}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {typeData.map(item => (
              <div key={item.name} className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: TYPE_COLORS[item.type] }} />
                  <span className="text-slate-300">{item.name}</span>
                </div>
                <span className="font-semibold text-slate-100">{formatNumber(item.value)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-6">
          <div className="rounded-2xl border border-white/10 bg-[color:var(--panel)] p-6">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-white">Top projects</h2>
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">By volume</p>
            </div>
            <div className="mt-5 h-72">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={projectData} layout="vertical" margin={{ left: 10, right: 10 }}>
                  <CartesianGrid stroke="rgba(255,255,255,0.06)" horizontal={false} />
                  <XAxis type="number" tick={{ fill: '#94a3b8', fontSize: 11 }} />
                  <YAxis
                    type="category"
                    dataKey="name"
                    width={90}
                    tick={{ fill: '#cbd5f5', fontSize: 11 }}
                  />
                  <Tooltip
                    cursor={{ fill: 'rgba(255,255,255,0.06)' }}
                    contentStyle={{
                      background: '#0f172a',
                      border: '1px solid rgba(255,255,255,0.1)',
                      color: '#e2e8f0'
                    }}
                  />
                  <Bar dataKey="value" fill="#38bdf8" radius={[8, 8, 8, 8]} barSize={12} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-[color:var(--panel)] p-6">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-white">Top domains</h2>
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">By volume</p>
            </div>
            <div className="mt-5 h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={domainData} layout="vertical" margin={{ left: 10, right: 10 }}>
                  <CartesianGrid stroke="rgba(255,255,255,0.06)" horizontal={false} />
                  <XAxis type="number" tick={{ fill: '#94a3b8', fontSize: 11 }} />
                  <YAxis
                    type="category"
                    dataKey="name"
                    width={90}
                    tick={{ fill: '#cbd5f5', fontSize: 11 }}
                  />
                  <Tooltip
                    cursor={{ fill: 'rgba(255,255,255,0.06)' }}
                    contentStyle={{
                      background: '#0f172a',
                      border: '1px solid rgba(255,255,255,0.1)',
                      color: '#e2e8f0'
                    }}
                  />
                  <Bar dataKey="value" fill="#fbbf24" radius={[8, 8, 8, 8]} barSize={12} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
