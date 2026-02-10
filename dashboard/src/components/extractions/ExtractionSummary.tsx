import { Activity, Sparkles } from 'lucide-react'
import { formatDuration, formatRelativeTimeShort, formatTokenCount } from '@/lib/format'

export default function ExtractionSummary({
  summary
}: {
  summary: {
    totalRuns: number
    totalRecords: number
    totalErrors: number
    totalTokens: number
    avgDuration: number
    latestTimestamp: number
  }
}) {
  return (
    <section className="rounded-xl border border-border bg-card px-4 py-3 shrink-0">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground/70">
          <Sparkles className="h-3.5 w-3.5 text-success/80" />
          <span className="uppercase tracking-[0.1em] font-medium">Extraction pulse</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs">
          <span className="flex items-center gap-1.5">
            <Activity className="h-3.5 w-3.5 text-success" />
            <span className="text-foreground/90 font-medium tabular-nums">{summary.totalRuns}</span>
            <span className="text-muted-foreground/70">runs</span>
          </span>
          <span className="text-muted-foreground/40">·</span>
          <span>
            <span className="text-foreground/90 font-medium tabular-nums">{summary.totalRecords}</span>
            <span className="text-muted-foreground/70 ml-1">records</span>
          </span>
          <span className="text-muted-foreground/40">·</span>
          <span>
            <span className="text-foreground/90 font-medium tabular-nums">{formatTokenCount(summary.totalTokens)}</span>
            <span className="text-muted-foreground/70 ml-1">tokens</span>
          </span>
          <span className="text-muted-foreground/40">·</span>
          <span>
            <span className={`font-medium tabular-nums ${summary.totalErrors > 0 ? 'text-destructive' : 'text-foreground/90'}`}>
              {summary.totalErrors}
            </span>
            <span className="text-muted-foreground/70 ml-1">parse errors</span>
          </span>
          <span className="text-muted-foreground/40">·</span>
          <span>
            <span className="text-foreground/90 font-medium tabular-nums">{formatDuration(summary.avgDuration)}</span>
            <span className="text-muted-foreground/70 ml-1">avg</span>
          </span>
          <span className="text-muted-foreground/40">·</span>
          <span>
            <span className="text-foreground/90 font-medium tabular-nums">
              {summary.latestTimestamp ? formatRelativeTimeShort(summary.latestTimestamp, { includeAgo: true }) : '—'}
            </span>
            <span className="text-muted-foreground/70 ml-1">latest</span>
          </span>
        </div>
      </div>
    </section>
  )
}
