import { useEffect, useState } from 'react'
import { Check, Link2, X } from 'lucide-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { PageHeader } from '@/App'
import ButtonSpinner from '@/components/ButtonSpinner'
import StatsCard from '@/components/StatsCard'
import Skeleton from '@/components/Skeleton'
import { useHookStatus, useStats } from '@/hooks/queries'
import { installHooks, resetCollection, type HookEvent, type RecordType } from '@/lib/api'

const TYPE_CONFIG: Record<RecordType, { label: string; color: string }> = {
  command: { label: 'Commands', color: '#2dd4bf' },
  error: { label: 'Errors', color: '#f43f5e' },
  discovery: { label: 'Discoveries', color: '#60a5fa' },
  procedure: { label: 'Procedures', color: '#a78bfa' },
}

const HOOK_ITEMS: { key: HookEvent; label: string; script: string }[] = [
  { key: 'UserPromptSubmit', label: 'UserPromptSubmit', script: 'pre-prompt.js' },
  { key: 'SessionEnd', label: 'SessionEnd', script: 'post-session.js' },
  { key: 'PreCompact', label: 'PreCompact', script: 'post-session.js' },
]

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

function DistributionSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-2.5 w-full rounded-full" />
      <div className="flex flex-wrap gap-x-8 gap-y-2">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="flex items-center gap-2.5">
            <Skeleton className="h-2.5 w-2.5 rounded-full" />
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-3 w-8" />
          </div>
        ))}
      </div>
    </div>
  )
}

function TopListSkeleton({ title }: { title: string }) {
  return (
    <div>
      <h3 className="section-header mb-5">{title}</h3>
      <div className="space-y-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index}>
            <div className="flex items-center justify-between mb-1.5">
              <Skeleton className="h-3 w-32" />
              <Skeleton className="h-3 w-8" />
            </div>
            <Skeleton className="h-1.5 w-full rounded-full" />
          </div>
        ))}
      </div>
    </div>
  )
}

export default function Overview() {
  const queryClient = useQueryClient()
  const { data, error, isPending, refetch } = useStats()
  const { data: hookStatus, error: hookError, isPending: hookPending } = useHookStatus()
  const [resetOpen, setResetOpen] = useState(false)
  const [resetInput, setResetInput] = useState('')
  const [resetError, setResetError] = useState<string | null>(null)
  const [resetNotice, setResetNotice] = useState<string | null>(null)
  const [resetRunning, setResetRunning] = useState(false)
  const [hookNotice, setHookNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  useEffect(() => {
    if (!resetNotice) return
    const timer = setTimeout(() => setResetNotice(null), 4000)
    return () => clearTimeout(timer)
  }, [resetNotice])

  useEffect(() => {
    if (!hookNotice) return
    const timer = setTimeout(() => setHookNotice(null), 4000)
    return () => clearTimeout(timer)
  }, [hookNotice])

  const resetReady = resetInput.trim() === 'RESET'

  const openReset = () => {
    setResetInput('')
    setResetError(null)
    setResetOpen(true)
  }

  const handleReset = async () => {
    if (!resetReady || resetRunning) return
    setResetRunning(true)
    setResetError(null)
    try {
      await resetCollection()
      setResetNotice('Collection reset successfully.')
      setResetOpen(false)
      refetch()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to reset collection'
      setResetError(message)
    } finally {
      setResetRunning(false)
    }
  }

  const installMutation = useMutation({
    mutationFn: installHooks,
    onSuccess: () => {
      setHookNotice({ type: 'success', text: 'Hooks installed successfully.' })
      queryClient.invalidateQueries({ queryKey: ['hooksStatus'] })
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : 'Failed to install hooks'
      setHookNotice({ type: 'error', text: message })
    }
  })

  const isInitialLoading = isPending && !data

  if (error && !data) {
    return (
      <div>
        <PageHeader title="Overview" />
        <div className="text-sm text-destructive">Failed to load statistics</div>
      </div>
    )
  }

  if (!data && !isInitialLoading) {
    return (
      <div>
        <PageHeader title="Overview" />
        <div className="text-sm text-destructive">Failed to load statistics</div>
      </div>
    )
  }

  const typeData = data
    ? (['command', 'error', 'discovery', 'procedure'] as const).map(type => ({
        type,
        count: data.byType[type] ?? 0,
      }))
    : []

  const projectData = data
    ? Object.entries(data.byProject)
        .map(([name, value]) => ({ name, value }))
        .sort((a, b) => b.value - a.value)
    : []

  const domainData = data
    ? Object.entries(data.byDomain)
        .map(([name, value]) => ({ name, value }))
        .sort((a, b) => b.value - a.value)
    : []

  const usagePercent = data ? Math.round(data.avgUsageRatio * 100) : 0
  const hookData = hookStatus?.hooks ?? null
  const hooksLoading = hookPending && !hookStatus
  const hasHookStatus = Boolean(hookData)
  const allHooksInstalled = hasHookStatus && HOOK_ITEMS.every(item => hookData![item.key]?.installed)
  const hasMissingHooks = hasHookStatus && HOOK_ITEMS.some(item => !hookData![item.key]?.installed)
  const hookErrorMessage = hookError instanceof Error ? hookError.message : 'Failed to load hook status'
  const showHookRecovery = Boolean(hookError) && !hooksLoading && !hasHookStatus

  return (
    <div className="space-y-8">
      <PageHeader
        title="Overview"
        description="Memory system statistics and distribution"
      />

      {error && data && (
        <div className="bg-amber-500/10 text-amber-400 text-sm px-3 py-2 rounded mb-4">
          Failed to refresh data. Showing cached results.
        </div>
      )}

      {/* Key Metrics */}
      <section className="p-6 rounded-xl border border-border bg-card">
        <h2 className="section-header mb-6">Metrics</h2>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-x-8 gap-y-6">
          <StatsCard
            label="Total memories"
            value={isInitialLoading ? <Skeleton className="h-8 w-20" /> : formatNumber(data!.total)}
          />
          <StatsCard
            label="Deprecated"
            value={isInitialLoading ? <Skeleton className="h-8 w-16" /> : formatNumber(data!.deprecated)}
          />
          <StatsCard
            label="Avg retrievals"
            value={isInitialLoading ? <Skeleton className="h-8 w-16" /> : formatNumber(data!.avgRetrievalCount, 1)}
          />
          <StatsCard
            label="Avg usage"
            value={isInitialLoading ? <Skeleton className="h-8 w-16" /> : formatNumber(data!.avgUsageCount, 1)}
          />
          <StatsCard
            label="Usage ratio"
            value={isInitialLoading ? <Skeleton className="h-8 w-16" /> : `${usagePercent}%`}
            subtext="Helpfulness score"
          />
        </div>
      </section>

      {/* Distribution */}
      <section className="p-6 rounded-xl border border-border bg-card">
        <h2 className="section-header mb-5">Type distribution</h2>
        {isInitialLoading ? <DistributionSkeleton /> : <DistributionBar data={typeData} />}
      </section>

      {/* Lists */}
      <div className="grid md:grid-cols-2 gap-6">
        <section className="p-6 rounded-xl border border-border bg-card">
          {isInitialLoading ? (
            <TopListSkeleton title="Top projects" />
          ) : (
            <TopList title="Top projects" data={projectData} />
          )}
        </section>
        <section className="p-6 rounded-xl border border-border bg-card">
          {isInitialLoading ? (
            <TopListSkeleton title="Top domains" />
          ) : (
            <TopList title="Top domains" data={domainData} />
          )}
        </section>
      </div>

      <section className="p-6 rounded-xl border border-border bg-card space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Link2 className="w-4 h-4 text-muted-foreground" />
            <h2 className="section-header">Hook configuration</h2>
          </div>
          {hasHookStatus && (
            <span
              className={`px-2 py-0.5 rounded-full text-[10px] uppercase tracking-wide ${
                allHooksInstalled
                  ? 'bg-emerald-500/15 text-emerald-300'
                  : 'bg-amber-500/15 text-amber-300'
              }`}
            >
              {allHooksInstalled ? 'Active' : 'Needs configuration'}
            </span>
          )}
        </div>

        {showHookRecovery && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 p-4 space-y-2">
            <p className="text-sm text-destructive">Unable to read hook settings.</p>
            <p className="text-xs text-muted-foreground">{hookErrorMessage}</p>
            <button
              onClick={() => installMutation.mutate()}
              disabled={installMutation.isPending}
              className="inline-flex items-center gap-2 h-9 px-4 rounded-md bg-foreground text-background text-sm font-medium hover:bg-foreground/90 transition-base disabled:opacity-50"
            >
              {installMutation.isPending ? (
                <>
                  <ButtonSpinner size="sm" />
                  Installing...
                </>
              ) : (
                'Try Install Anyway'
              )}
            </button>
          </div>
        )}

        {hooksLoading && (
          <div className="space-y-2">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-4 w-56" />
            <Skeleton className="h-4 w-52" />
          </div>
        )}

        {!hooksLoading && hasHookStatus && (
          <>
            <p className="text-sm text-muted-foreground">
              {allHooksInstalled
                ? 'All claude-memory hooks are installed.'
                : 'Install missing hooks to enable automatic memory extraction and injection.'}
            </p>
            <div className="space-y-2">
              {HOOK_ITEMS.map(item => {
                const installed = hookData![item.key]?.installed
                return (
                  <div key={item.key} className="flex items-center gap-2 text-sm">
                    {installed ? (
                      <Check className="w-4 h-4 text-emerald-400" />
                    ) : (
                      <X className="w-4 h-4 text-destructive" />
                    )}
                    <span className="font-medium">{item.label}</span>
                    <span className="text-xs text-muted-foreground">({item.script})</span>
                  </div>
                )
              })}
            </div>

            {hasMissingHooks && (
              <button
                onClick={() => installMutation.mutate()}
                disabled={installMutation.isPending}
                className="inline-flex items-center gap-2 h-9 px-4 rounded-md bg-foreground text-background text-sm font-medium hover:bg-foreground/90 transition-base disabled:opacity-50"
              >
                {installMutation.isPending ? (
                  <>
                    <ButtonSpinner size="sm" />
                    Installing...
                  </>
                ) : (
                  'Install Missing Hooks'
                )}
              </button>
            )}

          </>
        )}

        {hookNotice && (
          <div className={`text-sm ${hookNotice.type === 'success' ? 'text-emerald-400' : 'text-destructive'}`}>
            {hookNotice.text}
          </div>
        )}
      </section>

      <section className="p-6 rounded-xl border border-destructive/30 bg-card space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="section-header text-destructive">Danger zone</h2>
            <p className="text-sm text-muted-foreground">
              Resetting the collection will permanently delete all memories.
            </p>
          </div>
          <button
            onClick={openReset}
            className="h-9 px-4 rounded-md bg-destructive text-destructive-foreground text-sm font-medium hover:bg-destructive/90 transition-base"
          >
            Reset Collection
          </button>
        </div>
        {resetNotice && (
          <div className="text-sm text-emerald-400">{resetNotice}</div>
        )}
      </section>

      {resetOpen && (
        <div className="fixed inset-0 z-50">
          <div
            className="absolute inset-0 bg-black/60 panel-backdrop open"
            onClick={() => !resetRunning && setResetOpen(false)}
          />
          <div className="absolute inset-0 flex items-center justify-center px-4">
            <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 space-y-4">
              <div>
                <h2 className="text-lg font-semibold text-destructive">Reset collection</h2>
                <p className="text-sm text-muted-foreground">
                  Type <span className="font-mono text-foreground">RESET</span> to confirm. This cannot be undone.
                </p>
              </div>
              <input
                type="text"
                value={resetInput}
                onChange={e => setResetInput(e.target.value)}
                placeholder="RESET"
                className="w-full h-9 px-3 rounded-md border border-border bg-background text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              />
              {resetError && (
                <div className="text-sm text-destructive">{resetError}</div>
              )}
              <div className="flex items-center justify-end gap-3">
                <button
                  onClick={() => setResetOpen(false)}
                  disabled={resetRunning}
                  className="h-9 px-4 rounded-md border border-border bg-background text-sm hover:bg-secondary/60 transition-base disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleReset}
                  disabled={!resetReady || resetRunning}
                  className="h-9 px-4 rounded-md bg-destructive text-destructive-foreground text-sm font-medium hover:bg-destructive/90 transition-base disabled:opacity-50"
                >
                  {resetRunning ? (
                    <span className="flex items-center gap-2">
                      <ButtonSpinner size="sm" />
                      Resetting...
                    </span>
                  ) : (
                    'Reset'
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
