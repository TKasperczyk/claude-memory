import { ChevronRight } from 'lucide-react'
import ListItem from '@/components/ListItem'
import Skeleton from '@/components/Skeleton'
import { formatRelativeTimeShort } from '@/lib/format'
import type { SessionRecord } from '@/lib/api'
import {
  getActivityStatus,
  getInjectionRatioBadge,
  getPromptCount,
  getSessionHealth,
  STATUS_STYLES
} from './utils'

function SessionCard({
  session,
  selected,
  onSelect
}: {
  session: SessionRecord
  selected: boolean
  onSelect: (sessionId: string) => void
}) {
  const promptCount = getPromptCount(session)
  const injectionCount = session.injectionCount ?? 0
  const ratioValue = typeof promptCount === 'number' && promptCount > 0 ? injectionCount / promptCount : 0
  const ratioBadge = getInjectionRatioBadge(injectionCount, promptCount)
  const health = getSessionHealth(session)
  const activity = getActivityStatus(session)
  const lastStatus = session.lastStatus ? STATUS_STYLES[session.lastStatus] : null

  return (
    <ListItem onClick={() => onSelect(session.sessionId)} selected={selected}>
      {/* Row 1: Activity + badges + time */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`h-2 w-2 rounded-full shrink-0 ${activity.dot}`} />
          <span className={`text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded-full ${health.badge}`}>
            {health.label}
          </span>
          {lastStatus && (
            <span className={`text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded-full ${lastStatus.badge}`}>
              {lastStatus.label}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 text-[11px] text-muted-foreground shrink-0">
          <span>{formatRelativeTimeShort(session.lastActivity, { includeAgo: true })}</span>
          {selected && <ChevronRight className="w-3.5 h-3.5 text-foreground" />}
        </div>
      </div>

      {/* Row 2: Stats + injection bar */}
      <div className="mt-1.5 flex items-center gap-2">
        <span className="text-[10px] shrink-0">
          <span className="text-foreground tabular-nums">{promptCount ?? '—'}</span>
          <span className="text-muted-foreground ml-0.5">prompts</span>
          <span className="mx-1.5 text-muted-foreground/50">·</span>
          <span className="text-foreground tabular-nums">{injectionCount}</span>
          <span className="text-muted-foreground ml-0.5">inj</span>
        </span>
        <div className="flex-1 h-1 rounded-full bg-secondary/60 overflow-hidden">
          <div
            className={`h-full ${health.bar}`}
            style={{ width: `${Math.max(0, Math.min(100, ratioValue * 100))}%` }}
          />
        </div>
        <span className={`text-[10px] font-medium tabular-nums ${ratioBadge.text}`} title={ratioBadge.title}>
          {ratioBadge.label}
        </span>
      </div>
    </ListItem>
  )
}

export function SessionListSkeleton() {
  const cards = Array.from({ length: 4 })

  return (
    <div className="space-y-3">
      {cards.map((_, index) => (
        <div key={index} className="rounded-xl border border-border bg-card p-4 space-y-3">
          <div className="flex items-center gap-3">
            <Skeleton className="h-2.5 w-2.5 rounded-full" />
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-20 ml-auto" />
          </div>
          <Skeleton className="h-3 w-52" />
          <div className="flex gap-2">
            <Skeleton className="h-6 w-16" />
            <Skeleton className="h-6 w-20" />
            <Skeleton className="h-6 w-20" />
          </div>
          <Skeleton className="h-2 w-full" />
          <Skeleton className="h-2 w-4/6" />
        </div>
      ))}
    </div>
  )
}

export default function SessionList({
  groupedSessions,
  selectedSessionId,
  onSelect,
  totalCount
}: {
  groupedSessions: Array<{ key: string; label: string; sessions: SessionRecord[] }>
  selectedSessionId: string | null
  onSelect: (sessionId: string) => void
  totalCount: number
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-3 flex flex-col min-h-0">
      <div className="flex items-center justify-between mb-2 shrink-0">
        <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Sessions</div>
        <div className="text-[11px] text-muted-foreground">{totalCount}</div>
      </div>
      <div className="space-y-3 flex-1 min-h-0 overflow-y-auto pr-1">
        {totalCount === 0 ? (
          <div className="py-6 text-center text-sm text-muted-foreground">
            No sessions match filters.
          </div>
        ) : (
          groupedSessions.map(group => (
            <div key={group.key} className="space-y-1.5">
              <div
                className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground px-1 pt-1 truncate"
                title={group.key}
              >
                {group.label}
              </div>
              <div className="space-y-1.5">
                {group.sessions.map(session => (
                  <SessionCard
                    key={session.sessionId}
                    session={session}
                    selected={session.sessionId === selectedSessionId}
                    onSelect={onSelect}
                  />
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  )
}
