import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, ChevronDown, ChevronRight, Copy } from 'lucide-react'
import { PageHeader } from '@/App'
import ButtonSpinner from '@/components/ButtonSpinner'
import { useSessions } from '@/hooks/queries'
import { useSelectedMemory } from '@/hooks/useSelectedMemory'
import MemoryDetail, { type RetrievalContext } from '@/components/MemoryDetail'
import Skeleton from '@/components/Skeleton'
import { formatDateTime } from '@/lib/format'
import {
  fetchInjectionReview,
  runInjectionReview,
  type InjectedMemoryVerdict,
  type InjectionReview,
  type InjectionStatus,
  type MemoryStats,
  type RecordType,
  type SessionRecord
} from '@/lib/api'
import { TYPE_COLORS } from '@/lib/memory-ui'
import { formatInjectionReview } from '@/lib/review-format'

const TYPE_ORDER: RecordType[] = ['error', 'command', 'discovery', 'procedure']

const STATUS_STYLES: Record<InjectionStatus, { badge: string; label: string }> = {
  injected: { badge: 'bg-emerald-500/15 text-emerald-300', label: 'Injected' },
  no_matches: { badge: 'bg-amber-500/15 text-amber-300', label: 'No matches' },
  empty_prompt: { badge: 'bg-muted-foreground/15 text-muted-foreground', label: 'Empty' },
  timeout: { badge: 'bg-red-500/15 text-red-300', label: 'Timeout' },
  error: { badge: 'bg-destructive/15 text-destructive', label: 'Error' }
}

function getInjectionRatioBadge(injectionCount: number, promptCount: number): { badge: string; label: string; title: string } {
  const ratio = promptCount > 0 ? injectionCount / promptCount : 0
  const label = `${injectionCount}/${promptCount}`
  const title = `${injectionCount} injection${injectionCount !== 1 ? 's' : ''} out of ${promptCount} prompt${promptCount !== 1 ? 's' : ''}`

  if (promptCount === 0) {
    return { badge: 'bg-muted-foreground/15 text-muted-foreground', label: '0/0', title: 'No prompts recorded' }
  }
  if (ratio >= 0.7) {
    return { badge: 'bg-emerald-500/15 text-emerald-300', label, title }
  }
  if (ratio > 0) {
    return { badge: 'bg-amber-500/15 text-amber-300', label, title }
  }
  return { badge: 'bg-red-500/15 text-red-300', label, title }
}

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

type PromptDisplayEntry = {
  text: string
  timestamp?: number
  status?: InjectionStatus
  memoryCount?: number
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

function formatMemoryCount(count: number | undefined): string | null {
  if (typeof count !== 'number') return null
  return `${count} ${count === 1 ? 'memory' : 'memories'}`
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

function getSessionPrompts(session: SessionRecord): PromptDisplayEntry[] {
  const sessionPrompts = session.prompts
  if (Array.isArray(sessionPrompts) && sessionPrompts.length > 0) {
    return sessionPrompts
  }

  const prompts: PromptDisplayEntry[] = []
  const byPrompt = new Map<string, PromptDisplayEntry>()

  for (const memory of session.memories) {
    if (typeof memory.prompt !== 'string') continue
    if (memory.prompt.trim().length === 0) continue
    const existing = byPrompt.get(memory.prompt)
    if (existing) {
      existing.memoryCount = (existing.memoryCount ?? 0) + 1
      continue
    }
    const entry: PromptDisplayEntry = { text: memory.prompt, memoryCount: 1 }
    prompts.push(entry)
    byPrompt.set(memory.prompt, entry)
  }

  return prompts
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

function SessionListSkeleton() {
  const cards = Array.from({ length: 3 })

  return (
    <div className="space-y-2">
      {cards.map((_, index) => (
        <div key={index} className="rounded-xl border border-border bg-card p-4 space-y-3">
          <div className="flex items-center gap-3">
            <Skeleton className="h-2.5 w-2.5 rounded-full" />
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-20 ml-auto" />
          </div>
          <Skeleton className="h-3 w-64" />
          <div className="flex gap-4">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-3 w-16" />
          </div>
        </div>
      ))}
    </div>
  )
}

function ReviewSkeleton() {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-3 w-28" />
      </div>
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-4 w-4/6" />
    </div>
  )
}

export default function Sessions() {
  const navigate = useNavigate()
  const [expanded, setExpanded] = useState<string | null>(null)
  const [retrievalContext, setRetrievalContext] = useState<RetrievalContext | null>(null)
  const {
    selectedId,
    selected,
    detailLoading,
    detailError,
    handleSelect: selectMemory,
    handleClose: closeMemory
  } = useSelectedMemory()
  const [reviewsBySession, setReviewsBySession] = useState<Record<string, InjectionReview | null>>({})
  const [reviewLoading, setReviewLoading] = useState<Record<string, boolean>>({})
  const [reviewRunning, setReviewRunning] = useState<Record<string, boolean>>({})
  const [reviewErrors, setReviewErrors] = useState<Record<string, string>>({})
  const [copied, setCopied] = useState<Record<string, boolean>>({})
  const { data, error, isPending } = useSessions()
  const sessions = data?.sessions ?? []
  const errorMessage = error instanceof Error ? error.message : 'Failed to load sessions'

  useEffect(() => {
    if (!selectedId) {
      setRetrievalContext(null)
      return
    }

    let nextContext: RetrievalContext | null = null
    for (const session of sessions) {
      const memory = session.memories.find(item => item.id === selectedId)
      if (memory) {
        nextContext = {
          prompt: memory.prompt,
          similarity: memory.similarity,
          keywordMatch: memory.keywordMatch,
          score: memory.score
        }
        break
      }
    }
    setRetrievalContext(nextContext)
  }, [selectedId, sessions])

  const handleSelect = (id: string, context?: RetrievalContext | null) => {
    setRetrievalContext(context ?? null)
    selectMemory(id)
  }

  const handleClose = () => {
    setRetrievalContext(null)
    closeMemory()
  }

  const isInitialLoading = isPending && sessions.length === 0

  if (error && !data) {
    return (
      <div>
        <PageHeader title="Sessions" />
        <div className="text-sm text-destructive">{errorMessage}</div>
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

  const handleCopy = async (session: SessionRecord, review: InjectionReview) => {
    const text = formatInjectionReview(session, review)
    await navigator.clipboard.writeText(text)
    setCopied(prev => ({ ...prev, [session.sessionId]: true }))
    setTimeout(() => {
      setCopied(prev => ({ ...prev, [session.sessionId]: false }))
    }, 2000)
  }

  const handleSendToSimulator = (prompt: string, cwd?: string) => {
    navigate('/preview', { state: { prompt, cwd } })
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sessions"
        description={`${sessions.length} tracked session${sessions.length !== 1 ? 's' : ''}`}
      />

      {error && data && (
        <div className="bg-amber-500/10 text-amber-400 text-sm px-3 py-2 rounded mb-4">
          Failed to refresh data. Showing cached results.
        </div>
      )}

      {isInitialLoading ? (
        <SessionListSkeleton />
      ) : sessions.length === 0 ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          No sessions tracked yet. Sessions appear when Claude Code runs with memory hooks enabled.
        </div>
      ) : (
        <div className="space-y-2">
          {sessions.map(session => {
            const active = isSessionActive(session)
            const isOpen = expanded === session.sessionId
            const memories = session.memories
            const prompts = getSessionPrompts(session)
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
                    {session.promptCount !== undefined && session.promptCount > 0 && (() => {
                      const ratioBadge = getInjectionRatioBadge(session.injectionCount ?? 0, session.promptCount)
                      return (
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide tabular-nums ${ratioBadge.badge}`}
                          title={ratioBadge.title}
                        >
                          {ratioBadge.label} inj
                        </span>
                      )
                    })()}
                    <span>{memories.length} memories</span>
                    <span>{formatRelative(session.lastActivity)}</span>
                  </div>
                </button>

                {/* Expanded content */}
                <div className={`accordion-content ${isOpen ? 'open' : ''}`}>
                  <div className="accordion-inner">
                    <div className="px-4 pb-4 pt-0 space-y-3">
                      {memories.length === 0 && (
                        <div className="rounded-lg border border-border bg-background/40 p-4 text-center">
                          <div className="text-sm text-muted-foreground">
                            {session.lastStatus === 'no_matches' && 'No matching memories found for this session.'}
                            {session.lastStatus === 'timeout' && 'Memory search timed out.'}
                            {session.lastStatus === 'error' && 'An error occurred during memory injection.'}
                            {session.lastStatus === 'empty_prompt' && 'Empty prompt received.'}
                            {!session.lastStatus && 'No memories injected in this session.'}
                          </div>
                          {session.promptCount !== undefined && session.promptCount > 0 && (
                            <div className="text-xs text-muted-foreground mt-2">
                              {session.promptCount} prompt{session.promptCount !== 1 ? 's' : ''} processed
                            </div>
                          )}
                        </div>
                      )}
                      {memories.length > 0 && (
                        <div className="rounded-lg border border-border bg-background/40 p-4 space-y-3">
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div className="text-xs text-muted-foreground">
                              Opus review
                            </div>
                            <div className="flex items-center gap-2">
                              {review && (
                                <button
                                  onClick={() => handleCopy(session, review)}
                                  className="inline-flex items-center gap-2 h-8 px-3 text-xs rounded-md border border-border bg-background hover:bg-secondary transition-base"
                                  title="Copy review for Claude analysis"
                                >
                                  {copied[session.sessionId] ? (
                                    <>
                                      <Check className="w-3 h-3 text-emerald-400" />
                                      Copied
                                    </>
                                  ) : (
                                    <>
                                      <Copy className="w-3 h-3" />
                                      Copy Review
                                    </>
                                  )}
                                </button>
                              )}
                              <button
                                onClick={() => handleReview(session.sessionId)}
                                disabled={reviewRunningState}
                                className="inline-flex items-center gap-2 h-8 px-3 text-xs rounded-md border border-border bg-background disabled:opacity-40 disabled:cursor-not-allowed hover:bg-secondary transition-base"
                              >
                                {reviewRunningState && <ButtonSpinner size="xs" />}
                                {reviewRunningState ? 'Reviewing...' : 'Review with Opus'}
                              </button>
                            </div>
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
                                      <button
                                        key={`${verdict.id}-${index}`}
                                        type="button"
                                        onClick={() => handleSelect(verdict.id)}
                                        className="w-full text-left rounded-md border border-border bg-secondary/30 p-3 cursor-pointer hover:bg-secondary/50 transition-base"
                                      >
                                        <div className="flex flex-wrap items-center gap-2 mb-1">
                                          <span className={`text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full ${VERDICT_STYLES[verdict.verdict].badge}`}>
                                            {VERDICT_STYLES[verdict.verdict].label}
                                          </span>
                                          <span className="text-[11px] text-muted-foreground font-mono">{verdict.id}</span>
                                        </div>
                                        <div className="text-sm text-foreground">{verdict.snippet}</div>
                                        <div className="text-xs text-muted-foreground mt-1">{verdict.reason}</div>
                                      </button>
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
                                      <button
                                        key={`${missed.id}-${index}`}
                                        type="button"
                                        onClick={() => handleSelect(missed.id)}
                                        className="w-full text-left rounded-md border border-border bg-secondary/30 p-3 cursor-pointer hover:bg-secondary/50 transition-base"
                                      >
                                        <div className="flex flex-wrap items-center gap-2 mb-1">
                                          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                                            Missed
                                          </span>
                                          <span className="text-[11px] text-muted-foreground font-mono">{missed.id}</span>
                                        </div>
                                        <div className="text-sm text-foreground">{missed.snippet}</div>
                                        <div className="text-xs text-muted-foreground mt-1">{missed.reason}</div>
                                      </button>
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
                            <ReviewSkeleton />
                          ) : null}
                        </div>
                      )}

                      {prompts.length > 0 && (
                        <details className="rounded-lg border border-border bg-background/40 p-4">
                          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            Prompts ({prompts.length})
                          </summary>
                          <div className="mt-3 space-y-2 max-h-60 overflow-y-auto pr-1">
                            {prompts.map((prompt, index) => {
                              const status = prompt.status
                              const statusStyle = status ? STATUS_STYLES[status] : null
                              const memoryCountLabel = formatMemoryCount(prompt.memoryCount)
                              const promptText = prompt.text.trim().length > 0 ? prompt.text : '(empty prompt)'

                              return (
                                <div
                                  key={`${session.sessionId}-prompt-${index}`}
                                  className="rounded-md border border-border bg-secondary/30 p-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"
                                >
                                  <div className="flex-1 space-y-2">
                                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                                      {statusStyle && (
                                        <span className={`px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide ${statusStyle.badge}`}>
                                          {statusStyle.label}
                                        </span>
                                      )}
                                      {memoryCountLabel && (
                                        <span>{memoryCountLabel}</span>
                                      )}
                                    </div>
                                    <div className="text-sm text-foreground whitespace-pre-wrap break-words">
                                      {promptText}
                                    </div>
                                  </div>
                                  <button
                                    type="button"
                                    onClick={(event) => {
                                      event.stopPropagation()
                                      handleSendToSimulator(prompt.text, session.cwd)
                                    }}
                                    className="inline-flex items-center justify-center h-8 px-3 text-xs rounded-md border border-border bg-background hover:bg-secondary transition-base shrink-0"
                                  >
                                    To Simulator
                                  </button>
                                </div>
                              )
                            })}
                          </div>
                        </details>
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
                                const trigger = formatRetrievalTrigger(memory)

                                return (
                                  <button
                                    key={`${memory.id}-${mi}`}
                                    type="button"
                                    onClick={() => handleSelect(memory.id, {
                                      prompt: memory.prompt,
                                      similarity: memory.similarity,
                                      keywordMatch: memory.keywordMatch,
                                      score: memory.score
                                    })}
                                    className="w-full text-left flex items-center gap-2 py-1.5 px-2 rounded text-sm cursor-pointer hover:bg-secondary/50 transition-base group"
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
        open={Boolean(selectedId)}
        loading={detailLoading}
        error={detailError}
        onClose={handleClose}
      />
    </div>
  )
}
