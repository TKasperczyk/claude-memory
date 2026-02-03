import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Check, Link2, Loader2, X } from 'lucide-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import StatsCard from '@/components/StatsCard'
import { RetrievalActivityChart, MemoryGrowthChart } from '@/components/charts'
import { useInstallationStatus, useRetrievalActivity, useStats, useStatsHistory } from '@/hooks/queries'
import { installAll, resetCollection, uninstallAll, type HookEvent, type RecordType } from '@/lib/api'
import { TYPE_COLORS } from '@/lib/memory-ui'

const TYPE_CONFIG: Record<RecordType, { label: string; color: string }> = {
  command: { label: 'Commands', color: TYPE_COLORS.command },
  error: { label: 'Errors', color: TYPE_COLORS.error },
  discovery: { label: 'Discoveries', color: TYPE_COLORS.discovery },
  procedure: { label: 'Procedures', color: TYPE_COLORS.procedure },
  warning: { label: 'Warnings', color: TYPE_COLORS.warning },
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

const SCOPE_CONFIG: Record<string, { label: string; color: string }> = {
  project: { label: 'Project', color: 'hsl(var(--muted-foreground))' },
  global: { label: 'Global', color: TYPE_COLORS.discovery },
}

function ScopeDistribution({ data }: { data: Record<string, number> }) {
  const total = Object.values(data).reduce((sum, count) => sum + count, 0)
  if (total === 0) return <p className="text-sm text-muted-foreground">No data yet</p>

  const entries = Object.entries(data)
    .map(([scope, count]) => ({ scope, count }))
    .sort((a, b) => b.count - a.count)

  return (
    <div className="space-y-4">
      {/* Bar */}
      <div className="flex h-2.5 rounded-full overflow-hidden bg-secondary/60">
        {entries.map(({ scope, count }) => {
          const percent = (count / total) * 100
          if (percent === 0) return null
          const config = SCOPE_CONFIG[scope] ?? { label: scope, color: 'hsl(var(--muted-foreground))' }
          return (
            <div
              key={scope}
              className="transition-all duration-300"
              style={{ width: `${percent}%`, backgroundColor: config.color }}
            />
          )
        })}
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-x-8 gap-y-2">
        {entries.map(({ scope, count }) => {
          const config = SCOPE_CONFIG[scope] ?? { label: scope, color: 'hsl(var(--muted-foreground))' }
          return (
            <div key={scope} className="flex items-center gap-2.5">
              <span
                className="w-2.5 h-2.5 rounded-full ring-2 ring-background"
                style={{ backgroundColor: config.color }}
              />
              <span className="text-sm text-muted-foreground">
                {config.label}
              </span>
              <span className="text-sm font-semibold tabular-nums">{count}</span>
            </div>
          )
        })}
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
  const { data: retrievalActivity, isPending: retrievalActivityPending } = useRetrievalActivity({ period: 'day', limit: 30 })
  const { data: statsHistory, isPending: statsHistoryPending } = useStatsHistory({ period: 'day', limit: 30 })
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
    return <div className="text-sm text-destructive">Failed to load statistics</div>
  }

  if (!data && !isInitialLoading) {
    return <div className="text-sm text-destructive">Failed to load statistics</div>
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

  // Extract sparkline data from stats history
  const sparklineData = useMemo(() => {
    if (!statsHistory?.buckets) return null
    const validBuckets = statsHistory.buckets.filter(b => b.snapshot !== null)
    if (validBuckets.length < 2) return null
    return {
      total: validBuckets.map(b => b.snapshot!.total),
      deprecated: validBuckets.map(b => b.snapshot!.deprecated),
      avgRetrievals: validBuckets.map(b => b.snapshot!.avgRetrievalCount),
      avgUsage: validBuckets.map(b => b.snapshot!.avgUsageCount),
      usageRatio: validBuckets.map(b => Math.round(b.snapshot!.avgUsageRatio * 100)),
    }
  }, [statsHistory])

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
    <div className="space-y-5">
      {error && data && (
        <Alert className="bg-warning/10 border-warning/20">
          <AlertDescription className="text-warning">
            Failed to refresh data. Showing cached results.
          </AlertDescription>
        </Alert>
      )}

      {/* Key Metrics */}
      <Card>
        <CardContent className="p-5">
          <h2 className="section-header mb-5">Metrics</h2>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <StatsCard
              label="Total memories"
              value={isInitialLoading ? <Skeleton className="h-7 w-16" /> : formatNumber(data!.total)}
              sparklineData={sparklineData?.total}
            />
            <StatsCard
              label="Deprecated"
              value={isInitialLoading ? <Skeleton className="h-7 w-12" /> : formatNumber(data!.deprecated)}
              sparklineData={sparklineData?.deprecated}
              sparklineColor="hsl(var(--destructive))"
            />
            <StatsCard
              label="Avg retrievals"
              value={isInitialLoading ? <Skeleton className="h-7 w-12" /> : formatNumber(data!.avgRetrievalCount, 1)}
              sparklineData={sparklineData?.avgRetrievals}
              sparklineColor="hsl(var(--type-discovery))"
            />
            <StatsCard
              label="Avg usage"
              value={isInitialLoading ? <Skeleton className="h-7 w-12" /> : formatNumber(data!.avgUsageCount, 1)}
              sparklineData={sparklineData?.avgUsage}
              sparklineColor="hsl(var(--type-procedure))"
            />
            <StatsCard
              label="Usage ratio"
              value={isInitialLoading ? <Skeleton className="h-7 w-12" /> : `${usagePercent}%`}
              subtext="Helpfulness score"
              sparklineData={sparklineData?.usageRatio}
              sparklineColor="hsl(var(--success))"
            />
          </div>
        </CardContent>
      </Card>

      {/* Distribution */}
      <div className="grid md:grid-cols-2 gap-5">
        <Card>
          <CardContent className="p-5">
            <h2 className="section-header mb-4">Type distribution</h2>
            {isInitialLoading ? <DistributionSkeleton /> : <DistributionBar data={typeData} />}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <h2 className="section-header mb-4">Scope distribution</h2>
            {isInitialLoading ? <DistributionSkeleton /> : <ScopeDistribution data={data?.byScope ?? {}} />}
          </CardContent>
        </Card>
      </div>

      {/* Activity Charts */}
      <div className="grid md:grid-cols-2 gap-5">
        <Card>
          <CardContent className="p-5">
            <h2 className="section-header mb-4">Memory growth</h2>
            <MemoryGrowthChart data={statsHistory} isLoading={statsHistoryPending} />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <h2 className="section-header mb-4">Retrieval activity</h2>
            <RetrievalActivityChart data={retrievalActivity} isLoading={retrievalActivityPending} />
          </CardContent>
        </Card>
      </div>

      {/* Lists */}
      <div className="grid md:grid-cols-2 gap-5">
        <Card>
          <CardContent className="p-5">
            {isInitialLoading ? (
              <TopListSkeleton title="Top projects" />
            ) : (
              <TopList title="Top projects" data={projectData} />
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            {isInitialLoading ? (
              <TopListSkeleton title="Top domains" />
            ) : (
              <TopList title="Top domains" data={domainData} />
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <Link2 className="w-4 h-4 text-muted-foreground/70" />
              <h2 className="section-header">Installation</h2>
            </div>
            {hasInstallationStatus && (
              <Badge
                variant="secondary"
                className={
                  allInstalled
                    ? 'bg-success/15 text-success hover:bg-success/20'
                    : 'bg-warning/15 text-warning hover:bg-warning/20'
                }
              >
                {allInstalled ? 'Active' : 'Needs configuration'}
              </Badge>
            )}
          </div>

          {showInstallationRecovery && (
            <Alert variant="destructive">
              <AlertDescription className="space-y-2">
                <p>Unable to read installation status.</p>
                <p className="text-xs text-muted-foreground">{installationErrorMessage}</p>
                <Button
                  onClick={() => installMutation.mutate()}
                  disabled={installMutation.isPending}
                  className="mt-2"
                >
                  {installMutation.isPending && <Loader2 className="animate-spin" />}
                  {installMutation.isPending ? 'Installing...' : 'Try Install Anyway'}
                </Button>
              </AlertDescription>
            </Alert>
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
                            <Check className="w-4 h-4 text-success" />
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
                          ? 'text-warning'
                          : entry.installed
                            ? 'text-success'
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
                <Button
                  onClick={() => installMutation.mutate()}
                  disabled={installMutation.isPending}
                >
                  {installMutation.isPending && <Loader2 className="animate-spin" />}
                  {installMutation.isPending
                    ? 'Installing...'
                    : hasModifiedCommands
                      ? 'Repair Installation'
                      : 'Install Missing Items'}
                </Button>
              )}

              {anyInstalled && (
                <div className="flex items-center justify-end">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={openUninstall}
                    disabled={uninstallMutation.isPending}
                    className="text-muted-foreground hover:text-destructive hover:border-destructive/40"
                  >
                    Uninstall
                  </Button>
                </div>
              )}

            </>
          )}

          {installNotice && (
            <div className={`text-sm ${installNotice.type === 'success' ? 'text-success' : 'text-destructive'}`}>
              {installNotice.text}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="border-destructive/20 bg-destructive/5">
        <CardContent className="p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="section-header text-destructive/80 mb-1">Danger zone</h2>
              <p className="text-sm text-muted-foreground">
                Resetting the collection will permanently delete all memories.
              </p>
            </div>
            <Button variant="destructive" onClick={openReset}>
              Reset Collection
            </Button>
          </div>
          {resetNotice && (
            <div className="text-sm text-success">{resetNotice}</div>
          )}
        </CardContent>
      </Card>

      {/* Reset Dialog */}
      <Dialog open={resetOpen} onOpenChange={(open) => !resetRunning && setResetOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-destructive">Reset collection</DialogTitle>
            <DialogDescription>
              Type <span className="font-mono text-foreground">RESET</span> to confirm. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <Input
            type="text"
            value={resetInput}
            onChange={e => setResetInput(e.target.value)}
            placeholder="RESET"
          />
          {resetError && (
            <div className="text-sm text-destructive">{resetError}</div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setResetOpen(false)}
              disabled={resetRunning}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleReset}
              disabled={!resetReady || resetRunning}
            >
              {resetRunning && <Loader2 className="animate-spin" />}
              {resetRunning ? 'Resetting...' : 'Reset'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Uninstall Dialog */}
      <Dialog open={uninstallOpen} onOpenChange={(open) => {
        if (uninstallMutation.isPending) return
        setUninstallOpen(open)
        if (!open) setUninstallError(null)
      }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-full bg-destructive/10 text-destructive">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div>
                <DialogTitle>Uninstall Memory Integration?</DialogTitle>
                <DialogDescription>
                  This will disable the claude-memory system.
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
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
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setUninstallOpen(false)
                setUninstallError(null)
              }}
              disabled={uninstallMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => uninstallMutation.mutate()}
              disabled={uninstallMutation.isPending}
            >
              {uninstallMutation.isPending && <Loader2 className="animate-spin" />}
              {uninstallMutation.isPending ? 'Uninstalling...' : 'Uninstall'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
