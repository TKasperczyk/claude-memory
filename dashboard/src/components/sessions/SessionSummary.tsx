import { Activity, Sparkles } from 'lucide-react'

export default function SessionSummary({
  summary
}: {
  summary: {
    totalSessions: number
    activeCount: number
    totalPrompts: number | null
    totalInjections: number
    totalMemories: number
    injectionRate: number | null
  }
}) {
  return (
    <section className="rounded-xl border border-border bg-card px-4 py-3 shrink-0">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground/70">
          <Sparkles className="h-3.5 w-3.5 text-success/80" />
          <span className="uppercase tracking-[0.1em] font-medium">Pulse</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs">
          <span className="flex items-center gap-1.5">
            <Activity className="h-3.5 w-3.5 text-success" />
            <span className="text-foreground/90 font-medium tabular-nums">{summary.activeCount}</span>
            <span className="text-muted-foreground/70">active</span>
          </span>
          <span className="text-muted-foreground/40">·</span>
          <span>
            <span className="text-foreground/90 font-medium tabular-nums">{summary.totalSessions}</span>
            <span className="text-muted-foreground/70 ml-1">sessions</span>
          </span>
          <span className="text-muted-foreground/40">·</span>
          <span>
            <span className="text-foreground/90 font-medium tabular-nums">{summary.totalPrompts ?? '—'}</span>
            <span className="text-muted-foreground/70 ml-1">prompts</span>
          </span>
          <span className="text-muted-foreground/40">·</span>
          <span>
            <span className="text-foreground/90 font-medium tabular-nums">{summary.totalInjections}</span>
            <span className="text-muted-foreground/70 ml-1">injections</span>
          </span>
          <span className="text-muted-foreground/40">·</span>
          <span>
            <span className="text-foreground/90 font-medium tabular-nums">{summary.totalMemories}</span>
            <span className="text-muted-foreground/70 ml-1">memories</span>
          </span>
          {summary.injectionRate != null && (
            <>
              <span className="text-muted-foreground/40">·</span>
              <span>
                <span className="text-foreground/90 font-medium tabular-nums">{(summary.injectionRate * 100).toFixed(0)}%</span>
                <span className="text-muted-foreground/70 ml-1">rate</span>
              </span>
            </>
          )}
        </div>
      </div>
    </section>
  )
}
