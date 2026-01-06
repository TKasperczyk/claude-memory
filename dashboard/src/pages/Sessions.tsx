import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react'
import { PageHeader } from '@/App'
import MemoryDetail, { type RetrievalContext } from '@/components/MemoryDetail'
import { formatDateTime } from '@/lib/format'
import {
  fetchInjectionReview,
  fetchMemory,
  fetchSessions,
  runInjectionReview,
  type InjectedMemoryVerdict,
  type InjectionReview,
  type MemoryRecord,
  type MemoryStats,
  type RecordType,
  type SessionRecord
} from '@/lib/api'

const TYPE_COLORS: Record<string, string> = {
  command: '#2dd4bf',
  error: '#f43f5e',
  discovery: '#60a5fa',
  procedure: '#a78bfa',
}

const TYPE_ORDER: RecordType[] = ['error', 'command', 'discovery', 'procedure']

const RELEVANCE_STYLES: Record<InjectionReview['overallRelevance'], { badge: string; label: string }> = {
  excellent: {
    badge: 'bg-emerald-500/15 text-emerald-300',
    label: 'Excellent'
  },
  good: {
    badge: 'bg-sky-500/15 text-sky-300',
    label: 'Good'
  },
  mixed: {
    badge: 'bg-amber-500/15 text-amber-300',
    label: 'Mixed'
  },
  poor: {
    badge: 'bg-destructive/15 text-destructive',
    label: 'Poor'
  }
}

const VERDICT_STYLES: Record<InjectedMemoryVerdict['verdict'], { badge: string; label: string }> = {
  relevant: {
    badge: 'bg-emerald-500/15 text-emerald-300',
    label: 'Relevant'
  },
  partially_relevant: {
    badge: 'bg-amber-500/15 text-amber-300',
    label: 'Partial'
  },
  irrelevant: {
    badge: 'bg-destructive/15 text-destructive',
    label: 'Irrelevant'
  },
  unknown: {
    badge: 'bg-muted-foreground/15 text-muted-foreground',
    label: 'Unknown'
  }
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts
  const mins = Math.floor(diff / 60000)
  const hours = Math.floor(mins / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}d ago`
  if (hours > 0) return `${hours}h ago`
  if (mins > 0) return `${mins}m ago`
  return 'now'
}

function parseSnippetTitle(snippet: string): string {
  const withoutType = snippet.replace(/^(command|error|discovery|procedure):\s*/, '')
  const mainPart = withoutType.split('|')[0].trim()
  return mainPart.length > 80 ? mainPart.slice(0, 77) + '…' : mainPart
}

function extractProjectName(cwd: string | undefined): string {
  if (!cwd) return 'Unknown'
  const parts = cwd.split('/')
  return parts[parts.length - 1] || cwd
}

function isSessionActive(session: SessionRecord): boolean {
  return Date.now() - session.lastActivity < 5 * 60 * 1000
}

function formatUsageRatio(stats: MemoryStats | null | undefined): string {
  if (!stats || stats.retrievalCount === 0) return '—'
  return `${stats.usageCount}/${stats.retrievalCount}`
}

function getUsageColor(stats: MemoryStats | null | undefined): string {
  if (!stats || stats.retrievalCount === 0) return 'text-muted-foreground'
  const ratio = stats.usageCount / stats.retrievalCount
  if (ratio >= 0.7) return 'text-green-400'
  if (ratio >= 0.3) return 'text-yellow-400'
  return 'text-red-400'
}

function formatRetrievalTrigger(memory: SessionRecord['memories'][0]): { label: string; color: string; title: string } | null {
  const hasKeyword = memory.keywordMatch === true
  const hasSemantic = typeof memory.similarity === 'number' && memory.similarity > 0

  if (!hasKeyword && !hasSemantic) return null

  const promptSnippet = memory.prompt
    ? `\n\nTriggered by: "${memory.prompt.length > 60 ? memory.prompt.slice(0, 60) + '…' : memory.prompt}"`
    : ''

  if (hasKeyword && hasSemantic) {
    return {
      label: 'K+S',
      color: 'text-purple-400',
      title: `Keyword + Semantic (${(memory.similarity! * 100).toFixed(0)}% similarity, score: ${memory.score?.toFixed(2) ?? '?'})${promptSnippet}`
    }
  }
  if (hasKeyword) {
    return {
      label: 'K',
      color: 'text-amber-400',
      title: `Keyword match (score: ${memory.score?.toFixed(2) ?? '?'})${promptSnippet}`
    }
  }
  return {
    label: 'S',
    color: 'text-cyan-400',
    title: `Semantic (${(memory.similarity! * 100).toFixed(0)}% similarity, score: ${memory.score?.toFixed(2) ?? '?'})${promptSnippet}`
  }
}

interface TypeGroup {
  type: RecordType
  memories: SessionRecord['memories']
}

function groupByType(memories: SessionRecord['memories']): TypeGroup[] {
  const groups: Map<RecordType, SessionRecord['memories']> = new Map()

  for (const m of memories) {
    const type = m.type ?? null
    if (type) {
      const existing = groups.get(type) || []
      existing.push(m)
      groups.set(type, existing)
    }
  }

  return TYPE_ORDER
    .filter(t => groups.has(t))
    .map(t => ({ type: t, memories: groups.get(t)! }))
}

export default function Sessions() {
  const [sessions, setSessions] = useState<SessionRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [selected, setSelected] = useState<MemoryRecord | null>(null)
  const [retrievalContext, setRetrievalContext] = useState<RetrievalContext | null>(null)
  const [loadingMemory, setLoadingMemory] = useState<string | null>(null)
  const [reviewsBySession, setReviewsBySession] = useState<Record<string, InjectionReview | null>>({})
  const [reviewLoading, setReviewLoading] = useState<Record<string, boolean>>({})
  const [reviewRunning, setReviewRunning] = useState<Record<string, boolean>>({})
  const [reviewErrors, setReviewErrors] = useState<Record<string, string>>({})

  const handleMemoryClick = async (memory: SessionRecord['memories'][0]) => {
    if (loadingMemory) return
    setLoadingMemory(memory.id)
    try {
      const record = await fetchMemory(memory.id)
      setSelected(record)
      setRetrievalContext({
        prompt: memory.prompt,
        similarity: memory.similarity,
        keywordMatch: memory.keywordMatch,
        score: memory.score
      })
    } catch {
      // Silently fail - memory might have been deleted
    } finally {
      setLoadingMemory(null)
    }
  }

  async function loadSessions() {
    try {
      const data = await fetchSessions()
      setSessions(data.sessions)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load sessions')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadSessions()
    const interval = setInterval(loadSessions, 5000)
    return () => clearInterval(interval)
  }, [])

  if (loading && sessions.length === 0) {
    return (
      <div>
        <PageHeader title="Sessions" />
        <div className="text-sm text-muted-foreground">Loading…</div>
      </div>
    )
  }

  if (error) {
    return (
      <div>
        <PageHeader title="Sessions" />
        <div className="text-sm text-destructive">{error}</div>
      </div>
    )
  }

  const handleToggle = async (session: SessionRecord) => {
    const isOpen = expanded === session.sessionId
    setExpanded(isOpen ? null : session.sessionId)

    if (!isOpen && session.memories.length > 0 && !Object.prototype.hasOwnProperty.call(reviewsBySession, session.sessionId)) {
      setReviewLoading(prev => ({ ...prev, [session.sessionId]: true }))
      setReviewErrors(prev => ({ ...prev, [session.sessionId]: '' }))
      try {
        const review = await fetchInjectionReview(session.sessionId)
        setReviewsBySession(prev => ({ ...prev, [session.sessionId]: review }))
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to load review'
        setReviewErrors(prev => ({ ...prev, [session.sessionId]: message }))
      } finally {
        setReviewLoading(prev => ({ ...prev, [session.sessionId]: false }))
      }
    }
  }

  const handleReview = async (sessionId: string) => {
    setReviewRunning(prev => ({ ...prev, [sessionId]: true }))
    setReviewErrors(prev => ({ ...prev, [sessionId]: '' }))
    try {
      const review = await runInjectionReview(sessionId)
      setReviewsBySession(prev => ({ ...prev, [sessionId]: review }))
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to run review'
      setReviewErrors(prev => ({ ...prev, [sessionId]: message }))
    } finally {
      setReviewRunning(prev => ({ ...prev, [sessionId]: false }))
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sessions"
        description={`${sessions.length} tracked session${sessions.length !== 1 ? 's' : ''}`}
      />

      {sessions.length === 0 ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          No sessions tracked yet. Sessions appear when Claude Code injects memories.
        </div>
      ) : (
        <div className="space-y-2">
          {sessions.map(session => {
            const active = isSessionActive(session)
            const isOpen = expanded === session.sessionId
            const memories = session.memories
            const typeGroups = groupByType(memories)
            const review = reviewsBySession[session.sessionId]
            const reviewLoadingState = reviewLoading[session.sessionId] ?? false
            const reviewRunningState = reviewRunning[session.sessionId] ?? false
            const reviewError = reviewErrors[session.sessionId]
            const hasReviewLoaded = Object.prototype.hasOwnProperty.call(reviewsBySession, session.sessionId)

            return (
              <div
                key={session.sessionId}
                className={`rounded-xl border transition-base ${
                  active ? 'border-green-500/30 bg-green-500/5' : 'border-border bg-card'
                }`}
              >
                {/* Header */}
                <button
                  onClick={() => handleToggle(session)}
                  className="w-full px-4 py-3 flex items-center gap-3 text-left"
                >
                  {isOpen ? (
                    <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
                  )}

                  <span className={`w-2 h-2 rounded-full shrink-0 ${active ? 'bg-green-400' : 'bg-muted-foreground'}`} />

                  <div className="flex-1 min-w-0">
                    <span className="font-medium truncate block">{extractProjectName(session.cwd)}</span>
                    {session.cwd && (
                      <div className="text-xs text-muted-foreground truncate">{session.cwd}</div>
                    )}
                  </div>

                  <div className="flex items-center gap-4 text-xs text-muted-foreground shrink-0">
                    <span>{memories.length} memories</span>
                    <span>{formatRelative(session.lastActivity)}</span>
                  </div>
                </button>

                {/* Expanded content */}
                <div className={`accordion-content ${isOpen ? 'open' : ''}`}>
                  <div className="accordion-inner">
                    <div className="px-4 pb-4 pt-0 space-y-3">
                      {memories.length > 0 && (
                        <div className="rounded-lg border border-border bg-background/40 p-4 space-y-3">
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div className="text-xs text-muted-foreground">
                              Opus review
                            </div>
                            <button
                              onClick={() => handleReview(session.sessionId)}
                              disabled={reviewRunningState}
                              className="inline-flex items-center gap-2 h-8 px-3 text-xs rounded-md border border-border bg-background disabled:opacity-40 disabled:cursor-not-allowed hover:bg-secondary transition-base"
                            >
                              {reviewRunningState && <Loader2 className="w-3 h-3 animate-spin" />}
                              {reviewRunningState ? 'Reviewing...' : 'Review with Opus'}
                            </button>
                          </div>

                          {reviewError && (
                            <div className="text-xs text-destructive">{reviewError}</div>
                          )}

                          {review ? (
                            <div className="space-y-3">
                              <div className="flex flex-wrap items-center gap-3">
                                <span className={`text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full ${RELEVANCE_STYLES[review.overallRelevance].badge}`}>
                                  {RELEVANCE_STYLES[review.overallRelevance].label}
                                </span>
                                <span className="text-xs text-muted-foreground">
                                  Relevance score <span className="font-semibold tabular-nums text-foreground">{review.relevanceScore}</span>
                                </span>
                                <span className="text-xs text-muted-foreground">
                                  Reviewed {formatDateTime(review.reviewedAt)}
                                </span>
                              </div>
                              <div className="text-sm text-foreground">{review.summary}</div>

                              <div className="space-y-2">
                                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                                  Injected verdicts
                                </div>
                                {review.injectedVerdicts.length === 0 ? (
                                  <div className="text-xs text-muted-foreground">No verdicts returned.</div>
                                ) : (
                                  <div className="space-y-2">
                                    {review.injectedVerdicts.map((verdict, index) => (
                                      <div
                                        key={`${verdict.id}-${index}`}
                                        className="rounded-md border border-border bg-secondary/30 p-3"
                                      >
                                        <div className="flex flex-wrap items-center gap-2 mb-1">
                                          <span className={`text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full ${VERDICT_STYLES[verdict.verdict].badge}`}>
                                            {VERDICT_STYLES[verdict.verdict].label}
                                          </span>
                                          <span className="text-[11px] text-muted-foreground font-mono">{verdict.id}</span>
                                        </div>
                                        <div className="text-sm text-foreground">{verdict.snippet}</div>
                                        <div className="text-xs text-muted-foreground mt-1">{verdict.reason}</div>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>

                              {review.missedMemories.length > 0 ? (
                                <div className="space-y-2">
                                  <div className="text-xs uppercase tracking-wide text-muted-foreground">
                                    Missed memories
                                  </div>
                                  <div className="space-y-2">
                                    {review.missedMemories.map((missed, index) => (
                                      <div
                                        key={`${missed.id}-${index}`}
                                        className="rounded-md border border-border bg-secondary/30 p-3"
                                      >
                                        <div className="flex flex-wrap items-center gap-2 mb-1">
                                          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                                            Missed
                                          </span>
                                          <span className="text-[11px] text-muted-foreground font-mono">{missed.id}</span>
                                        </div>
                                        <div className="text-sm text-foreground">{missed.snippet}</div>
                                        <div className="text-xs text-muted-foreground mt-1">{missed.reason}</div>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              ) : (
                                <div className="text-xs text-muted-foreground">No missed memories flagged.</div>
                              )}
                            </div>
                          ) : hasReviewLoaded ? (
                            <div className="text-xs text-muted-foreground">No review yet.</div>
                          ) : reviewLoadingState ? (
                            <div className="text-xs text-muted-foreground">Loading review...</div>
                          ) : null}
                        </div>
                      )}

                      <div className="max-h-80 overflow-y-auto space-y-2">
                        {typeGroups.map(group => (
                          <div
                            key={group.type}
                            className="rounded-md bg-secondary/40 overflow-hidden"
                          >
                            {/* Type header */}
                            <div
                              className="px-3 py-1.5 flex items-center justify-between border-b"
                              style={{
                                backgroundColor: `${TYPE_COLORS[group.type]}10`,
                                borderColor: `${TYPE_COLORS[group.type]}20`,
                              }}
                            >
                              <div className="flex items-center gap-2">
                                <span
                                  className="w-1.5 h-1.5 rounded-full"
                                  style={{ backgroundColor: TYPE_COLORS[group.type] }}
                                />
                                <span
                                  className="text-xs font-medium capitalize"
                                  style={{ color: TYPE_COLORS[group.type] }}
                                >
                                  {group.type}s
                                </span>
                              </div>
                              <span className="text-xs text-muted-foreground tabular-nums">
                                {group.memories.length}
                              </span>
                            </div>
                            {/* Memory list */}
                            <div className="p-1.5 space-y-0.5">
                              {group.memories.map((memory, mi) => {
                                const title = parseSnippetTitle(memory.snippet)
                                const isLoading = loadingMemory === memory.id
                                const trigger = formatRetrievalTrigger(memory)

                                return (
                                  <button
                                    key={`${memory.id}-${mi}`}
                                    onClick={() => handleMemoryClick(memory)}
                                    disabled={isLoading}
                                    className="w-full text-left flex items-center gap-2 py-1.5 px-2 rounded text-sm hover:bg-background/60 transition-base disabled:opacity-50 group"
                                  >
                                    <span className="flex-1 truncate text-foreground/70 group-hover:text-foreground/90">{title}</span>
                                    {trigger && (
                                      <span
                                        className={`text-[10px] font-mono px-1 py-0.5 rounded bg-background/50 shrink-0 ${trigger.color}`}
                                        title={trigger.title}
                                      >
                                        {trigger.label}
                                      </span>
                                    )}
                                    <span className={`text-xs font-mono shrink-0 ${getUsageColor(memory.stats)}`}>
                                      {formatUsageRatio(memory.stats)}
                                    </span>
                                  </button>
                                )
                              })}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <MemoryDetail
        record={selected}
        retrievalContext={retrievalContext}
        onClose={() => { setSelected(null); setRetrievalContext(null) }}
      />
    </div>
  )
}
