import { useEffect, useState } from 'react'
import { AlertTriangle, Check, Link2, X } from 'lucide-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { PageHeader } from '@/App'
import ButtonSpinner from '@/components/ButtonSpinner'
import StatsCard from '@/components/StatsCard'
import Skeleton from '@/components/Skeleton'
import { useInstallationStatus, useStats } from '@/hooks/queries'
import { installAll, resetCollection, uninstallAll, type HookEvent, type RecordType } from '@/lib/api'

const TYPE_CONFIG: Record<RecordType, { label: string; color: string }> = {
  command: { label: 'Commands', color: '#2dd4bf' },
  error: { label: 'Errors', color: '#f43f5e' },
  discovery: { label: 'Discoveries', color: '#60a5fa' },
  procedure: { label: 'Procedures', color: '#a78bfa' },
  warning: { label: 'Warnings', color: '#fbbf24' },
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
  const { data: installationStatus, error: installationError, isPending: installationPending } = useInstallationStatus()
  const [resetOpen, setResetOpen] = useState(false)
  const [resetInput, setResetInput] = useState('')
  const [resetError, setResetError] = useState<string | null>(null)
  const [resetNotice, setResetNotice] = useState<string | null>(null)
  const [resetRunning, setResetRunning] = useState(false)
  const [installNotice, setInstallNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [uninstallOpen, setUninstallOpen] = useState(false)
  const [uninstallError, setUninstallError] = useState<string | null>(null)

  useEffect(() => {
    if (!resetNotice) return
    const timer = setTimeout(() => setResetNotice(null), 4000)
    return () => clearTimeout(timer)
  }, [resetNotice])

  useEffect(() => {
    if (!installNotice) return
    const timer = setTimeout(() => setInstallNotice(null), 4000)
    return () => clearTimeout(timer)
  }, [installNotice])

  const resetReady = resetInput.trim() === 'RESET'

  const openReset = () => {
    setResetInput('')
    setResetError(null)
    setResetOpen(true)
  }

  const openUninstall = () => {
    setUninstallError(null)
    setUninstallOpen(true)
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
    mutationFn: installAll,
    onSuccess: () => {
      setInstallNotice({ type: 'success', text: 'Installation completed successfully.' })
      queryClient.invalidateQueries({ queryKey: ['installationStatus'] })
      queryClient.invalidateQueries({ queryKey: ['hooksStatus'] })
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : 'Failed to install'
      setInstallNotice({ type: 'error', text: message })
    }
  })

  const uninstallMutation = useMutation({
    mutationFn: uninstallAll,
    onSuccess: () => {
      setInstallNotice({ type: 'success', text: 'Installation removed successfully.' })
      setUninstallError(null)
      setUninstallOpen(false)
      queryClient.invalidateQueries({ queryKey: ['installationStatus'] })
      queryClient.invalidateQueries({ queryKey: ['hooksStatus'] })
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : 'Failed to uninstall'
      setUninstallError(message)
      setInstallNotice({ type: 'error', text: message })
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
  const hookData = installationStatus?.hooks ?? null
  const commandData = installationStatus?.commands ?? null
  const commandEntries = commandData ? Object.entries(commandData) : []
  const installationLoading = installationPending && !installationStatus
  const hasInstallationStatus = Boolean(installationStatus)
  const hasCommands = commandEntries.length > 0
  const allHooksInstalled = hasInstallationStatus && HOOK_ITEMS.every(item => hookData?.[item.key]?.installed)
  const anyHooksInstalled = hasInstallationStatus && HOOK_ITEMS.some(item => hookData?.[item.key]?.installed)
  const hasMissingHooks = hasInstallationStatus && HOOK_ITEMS.some(item => !hookData?.[item.key]?.installed)
  const allCommandsInstalled = !hasCommands
    ? true
    : commandEntries.every(([, entry]) => entry.installed && !entry.modified)
  const anyCommandsInstalled = hasCommands && commandEntries.some(([, entry]) => entry.installed)
  const hasMissingCommands = hasCommands && commandEntries.some(([, entry]) => !entry.installed)
  const hasModifiedCommands = hasCommands && commandEntries.some(([, entry]) => entry.modified)
  const allInstalled = hasInstallationStatus && allHooksInstalled && allCommandsInstalled
  const anyInstalled = hasInstallationStatus && (anyHooksInstalled || anyCommandsInstalled)
  const hasInstallIssues = hasInstallationStatus && (hasMissingHooks || hasMissingCommands || hasModifiedCommands)
  const installationErrorMessage = installationError instanceof Error
    ? installationError.message
    : 'Failed to load installation status'
  const showInstallationRecovery = Boolean(installationError) && !installationLoading && !hasInstallationStatus

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
            <h2 className="section-header">Installation</h2>
          </div>
          {hasInstallationStatus && (
            <span
              className={`px-2 py-0.5 rounded-full text-[10px] uppercase tracking-wide ${
                allInstalled
                  ? 'bg-emerald-500/15 text-emerald-300'
                  : 'bg-amber-500/15 text-amber-300'
              }`}
            >
              {allInstalled ? 'Active' : 'Needs configuration'}
            </span>
          )}
        </div>

        {showInstallationRecovery && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 p-4 space-y-2">
            <p className="text-sm text-destructive">Unable to read installation status.</p>
            <p className="text-xs text-muted-foreground">{installationErrorMessage}</p>
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

        {installationLoading && (
          <div className="space-y-2">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-4 w-56" />
            <Skeleton className="h-4 w-52" />
          </div>
        )}

        {!installationLoading && hasInstallationStatus && (
          <>
            <p className="text-sm text-muted-foreground">
              {allInstalled
                ? 'All claude-memory hooks and commands are installed.'
                : 'Install missing hooks and commands to enable automatic memory extraction, injection, and /memory.'}
            </p>
            <div className="space-y-4">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Hooks
                </div>
                <div className="mt-2 space-y-2">
                  {HOOK_ITEMS.map(item => {
                    const installed = hookData?.[item.key]?.installed
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
              </div>
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Commands
                </div>
                <div className="mt-2 space-y-2">
                  {commandEntries.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No commands found.</p>
                  ) : (
                    commandEntries.map(([name, entry]) => {
                      const displayName = name.startsWith('/') ? name.slice(1) : name
                      const statusLabel = entry.modified
                        ? 'modified by user'
                        : entry.installed
                          ? 'installed'
                          : 'not installed'
                      const StatusIcon = entry.modified ? AlertTriangle : entry.installed ? Check : X
                      const iconClass = entry.modified
                        ? 'text-amber-400'
                        : entry.installed
                          ? 'text-emerald-400'
                          : 'text-destructive'
                      return (
                        <div key={name} className="flex items-center gap-2 text-sm">
                          <StatusIcon className={`w-4 h-4 ${iconClass}`} />
                          <span className="font-medium">{displayName}</span>
                          <span className="text-xs text-muted-foreground">({statusLabel})</span>
                          <span className="text-xs text-muted-foreground">({entry.path})</span>
                        </div>
                      )
                    })
                  )}
                </div>
              </div>
            </div>

            {hasInstallIssues && (
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
                  hasModifiedCommands ? 'Repair Installation' : 'Install Missing Items'
                )}
              </button>
            )}

            {anyInstalled && (
              <div className="flex items-center justify-end">
                <button
                  onClick={openUninstall}
                  disabled={uninstallMutation.isPending}
                  className="h-8 px-3 rounded-md border border-border bg-background text-xs text-muted-foreground hover:text-destructive hover:border-destructive/40 transition-base disabled:opacity-50"
                >
                  Uninstall
                </button>
              </div>
            )}

          </>
        )}

        {installNotice && (
          <div className={`text-sm ${installNotice.type === 'success' ? 'text-emerald-400' : 'text-destructive'}`}>
            {installNotice.text}
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

      {uninstallOpen && (
        <div className="fixed inset-0 z-50">
          <div
            className="absolute inset-0 bg-black/60 panel-backdrop open"
            onClick={() => {
              if (uninstallMutation.isPending) return
              setUninstallOpen(false)
              setUninstallError(null)
            }}
          />
          <div className="absolute inset-0 flex items-center justify-center px-4">
            <div className="w-full max-w-lg rounded-xl border border-border bg-card p-6 space-y-4">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-full bg-destructive/10 text-destructive">
                  <AlertTriangle className="h-5 w-5" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold">Uninstall Memory Integration?</h2>
                  <p className="text-sm text-muted-foreground">
                    This will disable the claude-memory system.
                  </p>
                </div>
              </div>
              <div className="space-y-3 text-sm text-muted-foreground">
                <p>If you continue:</p>
                <ul className="list-disc list-inside space-y-2">
                  <li>
                    Memory injection will stop <span className="text-xs text-muted-foreground">(No context from past sessions)</span>
                  </li>
                  <li>
                    Memory extraction will stop <span className="text-xs text-muted-foreground">(New learnings won&apos;t be saved)</span>
                  </li>
                  <li>
                    The /memory command will be removed <span className="text-xs text-muted-foreground">(Command entry disappears)</span>
                  </li>
                </ul>
                <p>
                  Existing memories remain in the database and can be accessed via the dashboard.
                  You can reinstall anytime.
                </p>
              </div>
              {uninstallError && (
                <div className="text-sm text-destructive">{uninstallError}</div>
              )}
              <div className="flex items-center justify-end gap-3">
                <button
                  onClick={() => {
                    setUninstallOpen(false)
                    setUninstallError(null)
                  }}
                  disabled={uninstallMutation.isPending}
                  className="h-9 px-4 rounded-md border border-border bg-background text-sm hover:bg-secondary/60 transition-base disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={() => uninstallMutation.mutate()}
                  disabled={uninstallMutation.isPending}
                  className="flex items-center gap-2 h-9 px-4 rounded-md bg-destructive text-destructive-foreground text-sm font-medium hover:bg-destructive/90 transition-base disabled:opacity-50"
                >
                  {uninstallMutation.isPending ? (
                    <>
                      <ButtonSpinner size="sm" />
                      Uninstalling...
                    </>
                  ) : (
                    'Uninstall'
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
