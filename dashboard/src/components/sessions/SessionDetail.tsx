import { useEffect } from 'react'
import MetricTile from '@/components/MetricTile'
import type { RetrievalContext } from '@/components/MemoryDetail'
import type { InjectionReview, SessionRecord } from '@/lib/api'
import { formatRelativeTimeShort } from '@/lib/format'
import {
  extractProjectName,
  getActivityStatus,
  getInjectionRatioBadge,
  getPromptCount,
  getSessionHealth,
  getSessionPrompts,
  STATUS_STYLES
} from './utils'
import SessionReviewPanel from './SessionReviewPanel'
import SessionPromptsPanel from './SessionPromptsPanel'
import SessionMemoriesPanel from './SessionMemoriesPanel'

export default function SessionDetail({
  session,
  review,
  reviewLoadingState,
  reviewError,
  hasReviewLoaded,
  onSelectMemory,
  onReviewUpdate,
  onReviewError,
  onLoadReview,
  onSendToSimulator,
  copy,
  isCopied
}: {
  session: SessionRecord | null
  review: InjectionReview | null
  reviewLoadingState: boolean
  reviewError?: string
  hasReviewLoaded: boolean
  onSelectMemory: (recordId: string, context?: RetrievalContext | null) => void
  onReviewUpdate: (sessionId: string, nextReview: InjectionReview) => void
  onReviewError: (sessionId: string, message: string) => void
  onLoadReview: (session: SessionRecord) => void
  onSendToSimulator: (prompt: string, cwd?: string) => void
  copy: (id: string, value: string) => void
  isCopied: (id: string) => boolean
}) {
  useEffect(() => {
    if (!session || session.memories.length === 0) return
    void onLoadReview(session)
  }, [session, onLoadReview])

  if (!session) {
    return (
      <section className="rounded-xl border border-border bg-card p-4 flex flex-col min-h-0">
        <div className="flex-1 flex flex-col items-center justify-center text-center text-sm text-muted-foreground">
          Select a session to view details.
        </div>
      </section>
    )
  }

  const projectName = extractProjectName(session.cwd)
  const promptEntries = getSessionPrompts(session)
  const promptCount = getPromptCount(session)
  const injectionCount = session.injectionCount ?? 0
  const ratioValue = typeof promptCount === 'number' && promptCount > 0 ? injectionCount / promptCount : 0
  const ratioBadge = getInjectionRatioBadge(injectionCount, promptCount)
  const health = getSessionHealth(session)
  const activity = getActivityStatus(session)
  const memories = session.memories

  return (
    <section className="rounded-xl border border-border bg-card p-4 flex flex-col min-h-0">
      <div className="flex flex-col flex-1 min-h-0 gap-3">
        {/* Header card - fixed height */}
        <div className="rounded-lg border border-border bg-background/50 p-3 shrink-0">
          <div className="flex items-start justify-between gap-3 mb-2">
            <div className="min-w-0">
              <div className="text-lg font-semibold truncate">{projectName}</div>
              {session.cwd && (
                <div className="text-[11px] text-muted-foreground truncate">{session.cwd}</div>
              )}
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-full ${activity.badge}`}>
                {activity.label}
              </span>
              <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-full ${health.badge}`}>
                {health.label}
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-2">
            <MetricTile label="Prompts" value={promptCount ?? '—'} />
            <MetricTile label="Inj" value={injectionCount} />
            <MetricTile label="Mem" value={memories.length} />
            <MetricTile label="Active" value={formatRelativeTimeShort(session.lastActivity, { includeAgo: true })} />
            {session.lastStatus && (
              <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-full ${STATUS_STYLES[session.lastStatus].badge}`}>
                {STATUS_STYLES[session.lastStatus].label}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <div className="flex-1 h-1.5 rounded-full bg-secondary/60 overflow-hidden">
              <div
                className={`h-full ${health.bar}`}
                style={{ width: `${Math.max(0, Math.min(100, ratioValue * 100))}%` }}
              />
            </div>
            <span className={`text-[11px] font-medium tabular-nums ${ratioBadge.text}`} title={ratioBadge.title}>
              {ratioBadge.label}
            </span>
          </div>
        </div>

        {/* Review section - auto height */}
        {memories.length === 0 ? (
          <div className="rounded-lg border border-border bg-background/40 p-3 text-center text-sm text-muted-foreground shrink-0">
            {session.lastStatus === 'no_matches' && 'No matching memories found.'}
            {session.lastStatus === 'timeout' && 'Memory search timed out.'}
            {session.lastStatus === 'error' && 'Error during injection.'}
            {session.lastStatus === 'empty_prompt' && 'Empty prompt.'}
            {!session.lastStatus && 'No memories injected.'}
            {typeof promptCount === 'number' && promptCount > 0 && (
              <span className="ml-1">({promptCount} prompts processed)</span>
            )}
          </div>
        ) : (
          <div className="shrink-0">
            <SessionReviewPanel
              session={session}
              review={review}
              reviewLoadingState={reviewLoadingState}
              reviewError={reviewError}
              hasReviewLoaded={hasReviewLoaded}
              onSelect={onSelectMemory}
              onReviewUpdate={onReviewUpdate}
              onReviewError={onReviewError}
              copy={copy}
              isCopied={isCopied}
            />
          </div>
        )}

        {/* Content area */}
        <div className="flex-1 min-h-0 overflow-y-auto space-y-3">
          <SessionPromptsPanel
            session={session}
            promptEntries={promptEntries}
            promptCount={promptCount}
            onSelectMemory={onSelectMemory}
            onSendToSimulator={onSendToSimulator}
          />

          <SessionMemoriesPanel
            memories={memories}
            onSelectMemory={onSelectMemory}
          />
        </div>
      </div>
    </section>
  )
}
