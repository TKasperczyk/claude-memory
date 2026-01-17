import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { Activity, Check, ChevronRight, Copy, Search, Sparkles } from 'lucide-react'
import ButtonSpinner from '@/components/ButtonSpinner'
import MetricTile from '@/components/MetricTile'
import ReviewSkeleton from '@/components/ReviewSkeleton'
import ThinkingPanel from '@/components/ThinkingPanel'
import { useSessions } from '@/hooks/queries'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { useSelectedMemory } from '@/hooks/useSelectedMemory'
import { useStreamingReview } from '@/hooks/useStreamingReview'
import MemoryDetail, { type RetrievalContext } from '@/components/MemoryDetail'
import Skeleton from '@/components/Skeleton'
import { formatDateTime, formatRelativeTimeShortAgo } from '@/lib/format'
import {
  fetchInjectionReview,
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
  injected: { badge: 'bg-emerald-500/15 text-emerald-400', label: 'Injected' },
  no_matches: { badge: 'bg-muted-foreground/15 text-muted-foreground', label: 'No matches' },
  empty_prompt: { badge: 'bg-muted-foreground/15 text-muted-foreground', label: 'Empty' },
  timeout: { badge: 'bg-destructive/15 text-destructive', label: 'Timeout' },
  error: { badge: 'bg-destructive/15 text-destructive', label: 'Error' }
}

const HEALTH_STYLES = {
  healthy: {
    label: 'Healthy',
    badge: 'bg-emerald-500/15 text-emerald-400',
    bar: 'bg-emerald-500/70',
    text: 'text-emerald-400'
  },
  mixed: {
    label: 'Mixed',
    badge: 'bg-foreground/10 text-foreground/70',
    bar: 'bg-foreground/40',
    text: 'text-foreground/70'
  },
  poor: {
    label: 'Low',
    badge: 'bg-muted-foreground/15 text-muted-foreground',
    bar: 'bg-muted-foreground/50',
    text: 'text-muted-foreground'
  },
  idle: {
    label: 'Idle',
    badge: 'bg-muted-foreground/15 text-muted-foreground',
    bar: 'bg-muted/60',
    text: 'text-muted-foreground'
  },
  unknown: {
    label: 'Unknown',
    badge: 'bg-muted-foreground/15 text-muted-foreground',
    bar: 'bg-muted/60',
    text: 'text-muted-foreground'
  },
  issue: {
    label: 'Issue',
    badge: 'bg-destructive/15 text-destructive',
    bar: 'bg-destructive/60',
    text: 'text-destructive'
  }
}

const TIME_FILTERS = [
  { key: 'all', label: 'All time', ms: Number.POSITIVE_INFINITY },
  { key: '24h', label: '24h', ms: 24 * 60 * 60 * 1000 },
  { key: '7d', label: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
  { key: '30d', label: '30d', ms: 30 * 24 * 60 * 60 * 1000 }
] as const

type TimeFilterKey = typeof TIME_FILTERS[number]['key']

const SORT_OPTIONS = [
  { key: 'recent', label: 'Most recent' },
  { key: 'prompts', label: 'Most prompts' },
  { key: 'memories', label: 'Most memories' },
  { key: 'health', label: 'Best injection rate' }
] as const

type SortKey = typeof SORT_OPTIONS[number]['key']

function getInjectionRatioBadge(
  injectionCount: number,
  promptCount: number | null
): { badge: string; text: string; label: string; title: string } {
  if (typeof promptCount !== 'number') {
    return { badge: 'bg-muted-foreground/15 text-muted-foreground', text: 'text-muted-foreground', label: '—', title: 'Prompt count unavailable' }
  }

  const ratio = promptCount > 0 ? injectionCount / promptCount : 0
  const label = `${injectionCount}/${promptCount}`
  const title = `${injectionCount} injection${injectionCount !== 1 ? 's' : ''} out of ${promptCount} prompt${promptCount !== 1 ? 's' : ''}`

  if (promptCount === 0) {
    return { badge: 'bg-muted-foreground/15 text-muted-foreground', text: 'text-muted-foreground', label: '0/0', title: 'No prompts recorded' }
  }
  // Color-code injection ratio: green (≥70%), orange (>0%), red (0%)
  if (ratio >= 0.7) {
    return { badge: 'bg-emerald-500/15 text-emerald-400', text: 'text-emerald-400', label, title }
  }
  if (ratio > 0) {
    return { badge: 'bg-amber-500/15 text-amber-400', text: 'text-amber-400', label, title }
  }
  return { badge: 'bg-red-500/15 text-red-400', text: 'text-red-400', label, title }
}

const RATING_STYLES: Record<InjectionReview['overallRating'], { badge: string; label: string }> = {
  good: {
    badge: 'bg-emerald-500/15 text-emerald-400',
    label: 'Good'
  },
  mixed: {
    badge: 'bg-foreground/10 text-foreground/70',
    label: 'Mixed'
  },
  poor: {
    badge: 'bg-muted-foreground/15 text-muted-foreground',
    label: 'Poor'
  }
}

const VERDICT_STYLES: Record<InjectedMemoryVerdict['verdict'], { badge: string; label: string }> = {
  relevant: {
    badge: 'bg-emerald-500/15 text-emerald-400',
    label: 'Relevant'
  },
  partially_relevant: {
    badge: 'bg-foreground/10 text-foreground/70',
    label: 'Partial'
  },
  irrelevant: {
    badge: 'bg-muted-foreground/15 text-muted-foreground',
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

const ACTIVE_WINDOW_MS = 5 * 60 * 1000
const STALE_WINDOW_MS = 12 * 60 * 60 * 1000
const PROMPT_MATCH_WINDOW_MS = 5000

function parseSnippetTitle(snippet: string): string {
  const withoutType = snippet.replace(/^(command|error|discovery|procedure):\s*/, '')
  const mainPart = withoutType.split('|')[0].trim()
  return mainPart.length > 80 ? mainPart.slice(0, 77) + '…' : mainPart
}

function splitPath(value: string): string[] {
  return value.split(/[\\/]/).filter(Boolean)
}

function normalizeCwd(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined
  const trimmed = cwd.trim()
  if (!trimmed) return undefined
  return trimmed.replace(/[\\/]+$/, '')
}

function extractProjectName(cwd: string | undefined): string {
  const normalized = normalizeCwd(cwd)
  if (!normalized) return 'Unknown'
  const parts = splitPath(normalized)
  return parts[parts.length - 1] || normalized
}

function getProjectKey(cwd: string | undefined): string {
  return normalizeCwd(cwd) ?? 'Unknown'
}

function formatProjectLabel(cwd: string | undefined, shortName: string, hasCollision: boolean): string {
  const normalized = normalizeCwd(cwd)
  if (!hasCollision || !normalized) return shortName
  return `${shortName} (${normalized})`
}

function isSessionActive(session: SessionRecord): boolean {
  return Date.now() - session.lastActivity < ACTIVE_WINDOW_MS
}

function formatUsageRatio(stats: MemoryStats | null | undefined): string {
  if (!stats || stats.retrievalCount === 0) return '—'
  return `${stats.usageCount}/${stats.retrievalCount}`
}

function getUsageColor(stats: MemoryStats | null | undefined): string {
  if (!stats || stats.retrievalCount === 0) return 'text-muted-foreground'
  const ratio = stats.usageCount / stats.retrievalCount
  if (ratio >= 0.7) return 'text-emerald-400'
  return 'text-muted-foreground'
}

function formatMemoryCount(count: number | undefined): string | null {
  if (typeof count !== 'number') return null
  return `${count} ${count === 1 ? 'memory' : 'memories'}`
}

function getSessionRatio(session: SessionRecord) {
  const promptCount = getPromptCount(session)
  const injectionCount = session.injectionCount ?? 0
  if (typeof promptCount !== 'number') {
    return { ratio: null, promptCount: null, injectionCount }
  }
  const ratio = promptCount > 0 ? injectionCount / promptCount : 0
  return { ratio, promptCount, injectionCount }
}

function getSessionHealth(session: SessionRecord) {
  if (session.lastStatus === 'error' || session.lastStatus === 'timeout') {
    return HEALTH_STYLES.issue
  }
  const { ratio, promptCount } = getSessionRatio(session)
  if (promptCount == null || ratio == null) return HEALTH_STYLES.unknown
  if (promptCount === 0) return HEALTH_STYLES.idle
  if (ratio >= 0.7) return HEALTH_STYLES.healthy
  if (ratio > 0) return HEALTH_STYLES.mixed
  return HEALTH_STYLES.poor
}

function getActivityStatus(session: SessionRecord): { label: string; badge: string; dot: string } {
  const diff = Date.now() - session.lastActivity
  if (diff < ACTIVE_WINDOW_MS) {
    return { label: 'Active', badge: 'bg-emerald-500/15 text-emerald-400', dot: 'bg-emerald-400' }
  }
  if (diff < STALE_WINDOW_MS) {
    return { label: 'Recent', badge: 'bg-foreground/10 text-foreground/70', dot: 'bg-foreground/50' }
  }
  return { label: 'Stale', badge: 'bg-muted-foreground/15 text-muted-foreground', dot: 'bg-muted-foreground' }
}

function getSessionPrompts(session: SessionRecord): PromptDisplayEntry[] | null {
  const sessionPrompts = session.prompts
  if (Array.isArray(sessionPrompts)) {
    return sessionPrompts
  }
  return null
}

function getPromptMemories(session: SessionRecord, prompt: PromptDisplayEntry): SessionRecord['memories'] {
  if ((prompt.memoryCount ?? 0) === 0) return []
  const memories = session.memoriesRaw
  if (!Array.isArray(memories)) return []
  if (typeof prompt.timestamp === 'number') {
    const groups = new Map<number, SessionRecord['memories']>()
    for (const memory of memories) {
      if (memory.prompt && memory.prompt !== prompt.text) continue
      const existing = groups.get(memory.injectedAt)
      if (existing) {
        existing.push(memory)
      } else {
        groups.set(memory.injectedAt, [memory])
      }
    }
    if (groups.size > 0) {
      let best: SessionRecord['memories'] | null = null
      let bestDelta = Number.POSITIVE_INFINITY
      for (const [injectedAt, entries] of groups) {
        const delta = Math.abs(injectedAt - prompt.timestamp)
        if (delta < bestDelta) {
          bestDelta = delta
          best = entries
        }
      }
      if (best && bestDelta <= PROMPT_MATCH_WINDOW_MS) {
        return best
      }
    }
  }
  return memories.filter(memory => memory.prompt === prompt.text)
}

function getPromptCount(session: SessionRecord): number | null {
  if (typeof session.promptCount === 'number') return session.promptCount
  const prompts = getSessionPrompts(session)
  if (Array.isArray(prompts)) return prompts.length
  return null
}

function getSessionHasReview(
  session: SessionRecord,
  cachedReviews: Record<string, InjectionReview | null>
): boolean {
  if (Object.prototype.hasOwnProperty.call(cachedReviews, session.sessionId)) {
    return cachedReviews[session.sessionId] !== null
  }
  return Boolean(session.hasReview)
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

function formatRetrievalTrigger(memory: SessionRecord['memories'][0]): { label: string; color: string; title: string } | null {
  const hasKeyword = memory.keywordMatch === true
  const hasSemantic = typeof memory.similarity === 'number' && memory.similarity > 0

  if (!hasKeyword && !hasSemantic) return null

  const promptSnippet = memory.prompt
    ? `\n\nTriggered by: "${memory.prompt.length > 60 ? memory.prompt.slice(0, 60) + '…' : memory.prompt}"`
    : ''

  // Use consistent muted color - the label (K/S/K+S) provides the distinction
  const color = 'text-foreground/60'

  if (hasKeyword && hasSemantic) {
    return {
      label: 'K+S',
      color,
      title: `Keyword + Semantic (${(memory.similarity! * 100).toFixed(0)}% similarity, score: ${memory.score?.toFixed(2) ?? '?'})${promptSnippet}`
    }
  }
  if (hasKeyword) {
    return {
      label: 'K',
      color,
      title: `Keyword match (score: ${memory.score?.toFixed(2) ?? '?'})${promptSnippet}`
    }
  }
  return {
    label: 'S',
    color,
    title: `Semantic (${(memory.similarity! * 100).toFixed(0)}% similarity, score: ${memory.score?.toFixed(2) ?? '?'})${promptSnippet}`
  }
}

function SessionListSkeleton() {
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

function SessionReviewPanel({
  session,
  review,
  reviewLoadingState,
  reviewError,
  hasReviewLoaded,
  onSelect,
  onReviewUpdate,
  onReviewError,
  copy,
  isCopied
}: {
  session: SessionRecord
  review: InjectionReview | null
  reviewLoadingState: boolean
  reviewError?: string
  hasReviewLoaded: boolean
  onSelect: (recordId: string) => void
  onReviewUpdate: (sessionId: string, nextReview: InjectionReview) => void
  onReviewError: (sessionId: string, message: string) => void
  copy: (id: string, value: string) => void
  isCopied: (id: string) => boolean
}) {
  const { trigger, thinking, isStreaming } = useStreamingReview<InjectionReview>({
    endpoint: `/api/sessions/${session.sessionId}/review`,
    onComplete: (nextReview) => {
      onReviewUpdate(session.sessionId, nextReview)
      onReviewError(session.sessionId, '')
    },
    onError: (err) => {
      onReviewError(session.sessionId, err.message || 'Failed to run review')
    }
  })

  const handleReview = () => {
    onReviewError(session.sessionId, '')
    trigger()
  }

  return (
    <div className="rounded-lg border border-border bg-background/40 p-3 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Opus review</div>
        <div className="flex items-center gap-1.5">
          {review && (
            <button
              onClick={() => copy(session.sessionId, formatInjectionReview(session, review))}
              className="inline-flex items-center gap-1 h-6 px-2 text-[10px] rounded border border-border bg-background hover:bg-secondary transition-base"
              title="Copy review"
            >
              {isCopied(session.sessionId) ? <Check className="w-2.5 h-2.5 text-emerald-400" /> : <Copy className="w-2.5 h-2.5" />}
              Copy
            </button>
          )}
          <button
            onClick={handleReview}
            disabled={isStreaming}
            className="inline-flex items-center gap-1 h-6 px-2 text-[10px] rounded border border-border bg-background disabled:opacity-40 disabled:cursor-not-allowed hover:bg-secondary transition-base"
          >
            {isStreaming && <ButtonSpinner size="xs" />}
            {isStreaming ? 'Reviewing...' : 'Review'}
          </button>
        </div>
      </div>

      <ThinkingPanel thinking={thinking} isStreaming={isStreaming} />

      {reviewError && (
        <div className="text-xs text-destructive">{reviewError}</div>
      )}

      {review ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded-full ${RATING_STYLES[review.overallRating].badge}`}>
              {RATING_STYLES[review.overallRating].label}
            </span>
            <span className="text-[10px] text-muted-foreground">
              Score <span className="font-semibold tabular-nums text-foreground">{review.relevanceScore}</span>
            </span>
            <span className="text-[10px] text-muted-foreground">{formatDateTime(review.reviewedAt)}</span>
          </div>
          <div className="text-xs text-foreground">{review.summary}</div>

          {review.injectedVerdicts.length > 0 && (
            <div className="space-y-1">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Verdicts</div>
              <div className="space-y-1 max-h-32 overflow-y-auto">
                {review.injectedVerdicts.map((verdict, index) => (
                  <button
                    key={`${verdict.id}-${index}`}
                    type="button"
                    onClick={() => onSelect(verdict.id)}
                    className="w-full text-left rounded border border-border bg-secondary/30 p-1.5 cursor-pointer hover:bg-secondary/50 transition-base"
                  >
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <span className={`text-[9px] uppercase tracking-wide px-1 py-0.5 rounded ${VERDICT_STYLES[verdict.verdict].badge}`}>
                        {VERDICT_STYLES[verdict.verdict].label}
                      </span>
                      <span className="text-[10px] text-muted-foreground font-mono truncate">{verdict.id.slice(0, 8)}</span>
                    </div>
                    <div className="text-[11px] text-foreground line-clamp-1">{verdict.snippet}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {review.missedMemories.length > 0 && (
            <div className="space-y-1">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Missed</div>
              <div className="space-y-1 max-h-24 overflow-y-auto">
                {review.missedMemories.map((missed, index) => (
                  <button
                    key={`${missed.id}-${index}`}
                    type="button"
                    onClick={() => onSelect(missed.id)}
                    className="w-full text-left rounded border border-border bg-secondary/30 p-1.5 cursor-pointer hover:bg-secondary/50 transition-base"
                  >
                    <span className="text-[10px] text-muted-foreground font-mono">{missed.id.slice(0, 8)}</span>
                    <div className="text-[11px] text-foreground line-clamp-1">{missed.snippet}</div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : hasReviewLoaded ? (
        <div className="text-[11px] text-muted-foreground">No review yet.</div>
      ) : reviewLoadingState ? (
        <ReviewSkeleton />
      ) : null}
    </div>
  )
}

function FilterChip({
  active,
  onClick,
  children
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-7 px-2.5 text-[11px] rounded-full border transition-base ${
        active
          ? 'bg-foreground text-background border-foreground'
          : 'bg-background border-border text-muted-foreground hover:text-foreground'
      }`}
    >
      {children}
    </button>
  )
}

function SessionCard({
  session,
  selected,
  onSelect
}: {
  session: SessionRecord
  selected: boolean
  onSelect: (sessionId: string) => void
}) {
  const projectName = extractProjectName(session.cwd)
  const promptCount = getPromptCount(session)
  const injectionCount = session.injectionCount ?? 0
  const ratioValue = typeof promptCount === 'number' && promptCount > 0 ? injectionCount / promptCount : 0
  const ratioBadge = getInjectionRatioBadge(injectionCount, promptCount)
  const health = getSessionHealth(session)
  const activity = getActivityStatus(session)
  const lastStatus = session.lastStatus ? STATUS_STYLES[session.lastStatus] : null

  return (
    <button
      type="button"
      onClick={() => onSelect(session.sessionId)}
      className={`w-full text-left rounded-lg border px-3 py-2 transition-base ${
        selected
          ? 'border-foreground/40 bg-foreground/5 ring-1 ring-foreground/10'
          : 'border-border bg-card hover:border-foreground/20'
      }`}
    >
      {/* Row 1: Project name + time */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`h-2 w-2 rounded-full shrink-0 ${activity.dot}`} />
          <span className="font-medium truncate">{projectName}</span>
        </div>
        <div className="flex items-center gap-1 text-[11px] text-muted-foreground shrink-0">
          <span>{formatRelativeTimeShortAgo(session.lastActivity)}</span>
          {selected && <ChevronRight className="w-3.5 h-3.5 text-foreground" />}
        </div>
      </div>

      {/* Row 2: Badges + stats */}
      <div className="mt-1 flex items-center gap-2 flex-wrap">
        <span className={`text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded-full ${health.badge}`}>
          {health.label}
        </span>
        {lastStatus && (
          <span className={`text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded-full ${lastStatus.badge}`}>
            {lastStatus.label}
          </span>
        )}
        <span className="text-[10px] text-muted-foreground ml-auto">
          <span className="text-foreground tabular-nums">{promptCount ?? '—'}</span>p
          <span className="mx-1 text-muted-foreground/50">·</span>
          <span className="text-foreground tabular-nums">{injectionCount}</span>i
          <span className="mx-1 text-muted-foreground/50">·</span>
          <span className="text-foreground tabular-nums">{session.memories.length}</span>m
        </span>
      </div>

      {/* Row 3: Injection bar + ratio */}
      <div className="mt-1.5 flex items-center gap-2">
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
    </button>
  )
}

export default function Sessions() {
  const navigate = useNavigate()
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [expandedPromptIndex, setExpandedPromptIndex] = useState<number | null>(null)
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
  const [reviewErrors, setReviewErrors] = useState<Record<string, string>>({})
  const [searchQuery, setSearchQuery] = useState('')
  const [timeFilter, setTimeFilter] = useState<TimeFilterKey>('all')
  const [projectFilter, setProjectFilter] = useState('all')
  const [hasMemoriesOnly, setHasMemoriesOnly] = useState(false)
  const [hasReviewsOnly, setHasReviewsOnly] = useState(false)
  const [activeOnly, setActiveOnly] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>('recent')
  const { copy, isCopied } = useCopyToClipboard(2000)
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

  const handleSendToSimulator = (prompt: string, cwd?: string) => {
    navigate('/preview', { state: { prompt, cwd } })
  }

  const loadReview = async (session: SessionRecord) => {
    if (reviewLoading[session.sessionId]) return
    if (Object.prototype.hasOwnProperty.call(reviewsBySession, session.sessionId)) return

    setReviewLoading(prev => ({ ...prev, [session.sessionId]: true }))
    setReviewErrors(prev => ({ ...prev, [session.sessionId]: '' }))

    try {
      const review = await fetchInjectionReview(session.sessionId)
      setReviewsBySession(prev => ({ ...prev, [session.sessionId]: review }))
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load review'
      if (message.toLowerCase().includes('review not found')) {
        setReviewsBySession(prev => ({ ...prev, [session.sessionId]: null }))
      } else {
        setReviewErrors(prev => ({ ...prev, [session.sessionId]: message }))
      }
    } finally {
      setReviewLoading(prev => ({ ...prev, [session.sessionId]: false }))
    }
  }

  const summary = useMemo(() => {
    const totalSessions = sessions.length
    let activeCount = 0
    let totalInjections = 0
    let totalMemories = 0
    let sessionsWithPrompts = 0
    let totalPrompts = 0
    let healthyCount = 0
    let promptCountsKnown = 0

    for (const session of sessions) {
      const promptCount = getPromptCount(session)
      const injectionCount = session.injectionCount ?? 0

      totalInjections += injectionCount
      totalMemories += session.memories.length
      if (isSessionActive(session)) activeCount += 1

      if (typeof promptCount === 'number') {
        promptCountsKnown += 1
        totalPrompts += promptCount
        if (promptCount > 0) sessionsWithPrompts += 1
        if (promptCount > 0 && injectionCount / promptCount >= 0.7) healthyCount += 1
      }
    }

    const promptMetricsAvailable = promptCountsKnown === totalSessions
    const injectionRate = promptMetricsAvailable && totalPrompts > 0 ? totalInjections / totalPrompts : null

    return {
      totalSessions,
      activeCount,
      sessionsWithPrompts: promptMetricsAvailable ? sessionsWithPrompts : null,
      totalPrompts: promptMetricsAvailable ? totalPrompts : null,
      totalInjections,
      totalMemories,
      healthyCount: promptMetricsAvailable ? healthyCount : null,
      injectionRate,
      promptMetricsAvailable
    }
  }, [sessions])

  const projectOptions = useMemo(() => {
    const options = new Map<string, { key: string; label: string; shortName: string; cwd?: string }>()
    for (const session of sessions) {
      const key = getProjectKey(session.cwd)
      if (!options.has(key)) {
        const shortName = extractProjectName(session.cwd)
        options.set(key, {
          key,
          label: shortName,
          shortName,
          cwd: session.cwd
        })
      }
    }

    const byShortName = new Map<string, Array<{ key: string; label: string; shortName: string; cwd?: string }>>()
    for (const option of options.values()) {
      const existing = byShortName.get(option.shortName) ?? []
      existing.push(option)
      byShortName.set(option.shortName, existing)
    }

    for (const optionsForName of byShortName.values()) {
      if (optionsForName.length <= 1) continue
      for (const option of optionsForName) {
        option.label = formatProjectLabel(option.cwd, option.shortName, true)
      }
    }

    return Array.from(options.values()).sort((a, b) => a.label.localeCompare(b.label))
  }, [sessions])

  const projectLabelMap = useMemo(() => {
    return new Map(projectOptions.map(option => [option.key, option.label]))
  }, [projectOptions])

  const filteredSessions = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase()
    const timeMs = TIME_FILTERS.find(filter => filter.key === timeFilter)?.ms ?? Number.POSITIVE_INFINITY

    return sessions.filter(session => {
      if (projectFilter !== 'all' && getProjectKey(session.cwd) !== projectFilter) return false
      if (Date.now() - session.lastActivity > timeMs) return false
      if (activeOnly && !isSessionActive(session)) return false
      if (hasMemoriesOnly && session.memories.length === 0) return false
      if (hasReviewsOnly && !getSessionHasReview(session, reviewsBySession)) return false

      if (!normalizedQuery) return true

      const projectName = extractProjectName(session.cwd).toLowerCase()
      const cwd = (session.cwd ?? '').toLowerCase()
      if (projectName.includes(normalizedQuery) || cwd.includes(normalizedQuery)) return true

      for (const memory of session.memories) {
        if (memory.snippet?.toLowerCase().includes(normalizedQuery)) return true
      }

      const prompts = getSessionPrompts(session)
      if (prompts) {
        for (const prompt of prompts) {
          if (prompt.text?.toLowerCase().includes(normalizedQuery)) return true
        }
      }

      return false
    })
  }, [sessions, searchQuery, timeFilter, projectFilter, activeOnly, hasMemoriesOnly, hasReviewsOnly, reviewsBySession])

  const sortedSessions = useMemo(() => {
    const sorted = [...filteredSessions]
    const promptCountCache = new Map<string, number | null>()

    const getPromptCountValue = (session: SessionRecord) => {
      if (promptCountCache.has(session.sessionId)) return promptCountCache.get(session.sessionId) ?? null
      const count = getPromptCount(session)
      promptCountCache.set(session.sessionId, count)
      return count
    }

    const getRatioValue = (session: SessionRecord) => {
      const promptCount = getPromptCountValue(session)
      if (typeof promptCount !== 'number') return Number.NEGATIVE_INFINITY
      const injectionCount = session.injectionCount ?? 0
      return promptCount > 0 ? injectionCount / promptCount : 0
    }

    switch (sortKey) {
      case 'prompts':
        sorted.sort((a, b) => (getPromptCountValue(b) ?? -1) - (getPromptCountValue(a) ?? -1))
        break
      case 'memories':
        sorted.sort((a, b) => b.memories.length - a.memories.length)
        break
      case 'health':
        sorted.sort((a, b) => getRatioValue(b) - getRatioValue(a))
        break
      case 'recent':
      default:
        sorted.sort((a, b) => b.lastActivity - a.lastActivity)
        break
    }
    return sorted
  }, [filteredSessions, sortKey])

  const groupedSessions = useMemo(() => {
    const groups = new Map<string, SessionRecord[]>()
    for (const session of sortedSessions) {
      const projectKey = getProjectKey(session.cwd)
      if (!groups.has(projectKey)) {
        groups.set(projectKey, [])
      }
      groups.get(projectKey)!.push(session)
    }
    return Array.from(groups.entries()).map(([key, items]) => ({
      key,
      label: projectLabelMap.get(key) ?? extractProjectName(items[0]?.cwd),
      sessions: items
    }))
  }, [sortedSessions, projectLabelMap])

  useEffect(() => {
    if (sortedSessions.length === 0) {
      setSelectedSessionId(null)
      return
    }
    if (selectedSessionId && sortedSessions.some(session => session.sessionId === selectedSessionId)) return
    setSelectedSessionId(sortedSessions[0].sessionId)
  }, [sortedSessions, selectedSessionId])

  const selectedSession = useMemo(() => {
    if (!selectedSessionId) return null
    return sessions.find(session => session.sessionId === selectedSessionId) ?? null
  }, [sessions, selectedSessionId])

  const handleSessionSelect = (sessionId: string) => {
    setSelectedSessionId(sessionId)
    setExpandedPromptIndex(null)
  }

  useEffect(() => {
    if (!selectedSession || selectedSession.memories.length === 0) return
    void loadReview(selectedSession)
  }, [selectedSession])

  const handleReviewUpdate = (sessionId: string, review: InjectionReview) => {
    setReviewsBySession(prev => ({ ...prev, [sessionId]: review }))
  }

  const handleReviewError = (sessionId: string, message: string) => {
    setReviewErrors(prev => ({ ...prev, [sessionId]: message }))
  }

  const isInitialLoading = isPending && sessions.length === 0

  if (error && !data) {
    return (
      <div className="text-sm text-destructive">{errorMessage}</div>
    )
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
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
        <div className="flex flex-col flex-1 min-h-0 gap-4">
          <section className="rounded-xl border border-border bg-card px-4 py-3 shrink-0">
            <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Sparkles className="h-3.5 w-3.5 text-emerald-400" />
                <span className="uppercase tracking-wide">Pulse</span>
              </div>
              <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs">
                <span className="flex items-center gap-1.5">
                  <Activity className="h-3.5 w-3.5 text-emerald-400" />
                  <span className="text-foreground font-medium tabular-nums">{summary.activeCount}</span>
                  <span className="text-muted-foreground">active</span>
                </span>
                <span className="text-muted-foreground">·</span>
                <span>
                  <span className="text-foreground font-medium tabular-nums">{summary.totalSessions}</span>
                  <span className="text-muted-foreground ml-1">sessions</span>
                </span>
                <span className="text-muted-foreground">·</span>
                <span>
                  <span className="text-foreground font-medium tabular-nums">{summary.totalPrompts ?? '—'}</span>
                  <span className="text-muted-foreground ml-1">prompts</span>
                </span>
                <span className="text-muted-foreground">·</span>
                <span>
                  <span className="text-foreground font-medium tabular-nums">{summary.totalInjections}</span>
                  <span className="text-muted-foreground ml-1">injections</span>
                </span>
                <span className="text-muted-foreground">·</span>
                <span>
                  <span className="text-foreground font-medium tabular-nums">{summary.totalMemories}</span>
                  <span className="text-muted-foreground ml-1">memories</span>
                </span>
                {summary.injectionRate != null && (
                  <>
                    <span className="text-muted-foreground">·</span>
                    <span>
                      <span className="text-foreground font-medium tabular-nums">{(summary.injectionRate * 100).toFixed(0)}%</span>
                      <span className="text-muted-foreground ml-1">rate</span>
                    </span>
                  </>
                )}
              </div>
            </div>
          </section>

          <section className="rounded-xl border border-border bg-card px-4 py-3 space-y-3 shrink-0">
            <div className="flex flex-wrap items-center gap-3">
              <div className="relative min-w-[180px] flex-1 max-w-xs">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={searchQuery}
                  onChange={event => setSearchQuery(event.target.value)}
                  placeholder="Search..."
                  className="h-8 w-full rounded-md border border-border bg-background pl-8 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
                />
              </div>
              <select
                value={projectFilter}
                onChange={event => setProjectFilter(event.target.value)}
                className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground"
              >
                <option value="all">All projects</option>
                {projectOptions.map(option => (
                  <option key={option.key} value={option.key}>{option.label}</option>
                ))}
              </select>
              <select
                value={sortKey}
                onChange={event => setSortKey(event.target.value as SortKey)}
                className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground"
              >
                {SORT_OPTIONS.map(option => (
                  <option key={option.key} value={option.key}>{option.label}</option>
                ))}
              </select>
              <div className="flex items-center gap-1">
                {TIME_FILTERS.map(filter => (
                  <FilterChip
                    key={filter.key}
                    active={timeFilter === filter.key}
                    onClick={() => setTimeFilter(filter.key)}
                  >
                    {filter.label}
                  </FilterChip>
                ))}
              </div>
              <div className="ml-auto text-xs text-muted-foreground">
                {sortedSessions.length}/{sessions.length}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <FilterChip active={hasMemoriesOnly} onClick={() => setHasMemoriesOnly(!hasMemoriesOnly)}>
                Has memories
              </FilterChip>
              <FilterChip active={hasReviewsOnly} onClick={() => setHasReviewsOnly(!hasReviewsOnly)}>
                Has reviews
              </FilterChip>
              <FilterChip active={activeOnly} onClick={() => setActiveOnly(!activeOnly)}>
                Active now
              </FilterChip>
            </div>
          </section>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)] xl:grid-cols-[minmax(0,380px)_minmax(0,1fr)] 2xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)] flex-1 min-h-0">
            <section className="rounded-xl border border-border bg-card p-3 flex flex-col min-h-0">
              <div className="flex items-center justify-between mb-2 shrink-0">
                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Sessions</div>
                <div className="text-[11px] text-muted-foreground">{sortedSessions.length}</div>
              </div>
              <div className="space-y-3 flex-1 min-h-0 overflow-y-auto pr-1">
                {sortedSessions.length === 0 ? (
                  <div className="py-6 text-center text-sm text-muted-foreground">
                    No sessions match filters.
                  </div>
                ) : (
                  groupedSessions.map(group => (
                    <div key={group.key} className="space-y-1.5">
                      <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground px-1 pt-1">
                        {group.label}
                      </div>
                      <div className="space-y-1.5">
                        {group.sessions.map(session => (
                          <SessionCard
                            key={session.sessionId}
                            session={session}
                            selected={session.sessionId === selectedSessionId}
                            onSelect={handleSessionSelect}
                          />
                        ))}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>

            <section className="rounded-xl border border-border bg-card p-4 flex flex-col min-h-0">
              {!selectedSession ? (
                <div className="flex-1 flex flex-col items-center justify-center text-center text-sm text-muted-foreground">
                  Select a session to view details.
                </div>
              ) : (
                (() => {
                  const projectName = extractProjectName(selectedSession.cwd)
                  const promptEntries = getSessionPrompts(selectedSession)
                  const prompts = promptEntries ?? []
                  const promptsAvailable = promptEntries !== null
                  const promptCount = getPromptCount(selectedSession)
                  const injectionCount = selectedSession.injectionCount ?? 0
                  const ratioValue = typeof promptCount === 'number' && promptCount > 0 ? injectionCount / promptCount : 0
                  const ratioBadge = getInjectionRatioBadge(injectionCount, promptCount)
                  const health = getSessionHealth(selectedSession)
                  const activity = getActivityStatus(selectedSession)
                  const memories = selectedSession.memories
                  const typeGroups = groupByType(memories)
                  const review = reviewsBySession[selectedSession.sessionId]
                  const reviewLoadingState = reviewLoading[selectedSession.sessionId] ?? false
                  const reviewError = reviewErrors[selectedSession.sessionId]
                  const hasReviewLoaded = Object.prototype.hasOwnProperty.call(reviewsBySession, selectedSession.sessionId)
                  const expandedPrompt = expandedPromptIndex !== null ? prompts[expandedPromptIndex] ?? null : null

                  return (
                    <div className="flex flex-col flex-1 min-h-0 gap-3">
                      {/* Header card - fixed height */}
                      <div className="rounded-lg border border-border bg-background/50 p-3 shrink-0">
                        <div className="flex items-start justify-between gap-3 mb-2">
                          <div className="min-w-0">
                            <div className="text-lg font-semibold truncate">{projectName}</div>
                            {selectedSession.cwd && (
                              <div className="text-[11px] text-muted-foreground truncate">{selectedSession.cwd}</div>
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
                          <MetricTile label="Active" value={formatRelativeTimeShortAgo(selectedSession.lastActivity)} />
                          {selectedSession.lastStatus && (
                            <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-full ${STATUS_STYLES[selectedSession.lastStatus].badge}`}>
                              {STATUS_STYLES[selectedSession.lastStatus].label}
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
                          {selectedSession.lastStatus === 'no_matches' && 'No matching memories found.'}
                          {selectedSession.lastStatus === 'timeout' && 'Memory search timed out.'}
                          {selectedSession.lastStatus === 'error' && 'Error during injection.'}
                          {selectedSession.lastStatus === 'empty_prompt' && 'Empty prompt.'}
                          {!selectedSession.lastStatus && 'No memories injected.'}
                          {typeof promptCount === 'number' && promptCount > 0 && (
                            <span className="ml-1">({promptCount} prompts processed)</span>
                          )}
                        </div>
                      ) : (
                        <div className="shrink-0">
                          <SessionReviewPanel
                            session={selectedSession}
                            review={review ?? null}
                            reviewLoadingState={reviewLoadingState}
                            reviewError={reviewError}
                            hasReviewLoaded={hasReviewLoaded}
                            onSelect={handleSelect}
                            onReviewUpdate={handleReviewUpdate}
                            onReviewError={handleReviewError}
                            copy={copy}
                            isCopied={isCopied}
                          />
                        </div>
                      )}

                      {/* Content area */}
                      <div className="flex-1 min-h-0 overflow-y-auto space-y-3">
                        <div className="grid gap-3 lg:grid-cols-2">
                          {/* Prompts list */}
                          <div className="rounded-lg border border-border bg-background/40 p-3">
                            <div className="flex items-center justify-between mb-2">
                              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Prompts</div>
                              <div className="text-[11px] text-muted-foreground">
                                {promptsAvailable ? prompts.length : (promptCount ?? '—')}
                              </div>
                            </div>
                            {!promptsAvailable ? (
                              <div className="text-xs text-muted-foreground">
                                Prompt data unavailable for legacy sessions.
                              </div>
                            ) : prompts.length === 0 ? (
                              <div className="text-xs text-muted-foreground">
                                No prompts recorded.
                              </div>
                            ) : (
                              <div className="max-h-64 overflow-y-auto space-y-1.5 pr-1">
                                {prompts.map((prompt, index) => {
                                  const status = prompt.status
                                  const statusStyle = status ? STATUS_STYLES[status] : null
                                  const memoryCountLabel = formatMemoryCount(prompt.memoryCount)
                                  const promptText = prompt.text.trim().length > 0 ? prompt.text : '(empty)'
                                  const isExpanded = expandedPromptIndex === index

                                  return (
                                    <button
                                      key={`${selectedSession.sessionId}-prompt-${index}`}
                                      type="button"
                                      onClick={() => setExpandedPromptIndex(isExpanded ? null : index)}
                                      className={`w-full text-left rounded border p-2 transition-base ${
                                        isExpanded
                                          ? 'border-foreground/30 bg-secondary/50 ring-1 ring-foreground/10'
                                          : 'border-border bg-secondary/30 hover:border-foreground/20'
                                      }`}
                                    >
                                      <div className="flex items-start justify-between gap-2">
                                        <div className="flex-1 min-w-0">
                                          <div className="flex flex-wrap items-center gap-1.5 mb-1">
                                            {statusStyle && (
                                              <span className={`px-1 py-0.5 rounded text-[9px] uppercase tracking-wide ${statusStyle.badge}`}>
                                                {statusStyle.label}
                                              </span>
                                            )}
                                            {memoryCountLabel && (
                                              <span className="text-[10px] text-muted-foreground">{memoryCountLabel}</span>
                                            )}
                                          </div>
                                          <div className="text-xs text-foreground line-clamp-2">{promptText}</div>
                                        </div>
                                        <ChevronRight className={`w-3.5 h-3.5 text-muted-foreground shrink-0 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
                                      </div>
                                    </button>
                                  )
                                })}
                              </div>
                            )}
                          </div>

                          {/* Memories list */}
                          <div className="rounded-lg border border-border bg-background/40 p-3">
                            <div className="flex items-center justify-between mb-2">
                              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Memories</div>
                              <div className="text-[11px] text-muted-foreground">{memories.length}</div>
                            </div>
                            {memories.length === 0 ? (
                              <div className="text-xs text-muted-foreground">None</div>
                            ) : (
                              <div className="max-h-64 overflow-y-auto space-y-1.5 pr-1">
                                {typeGroups.map(group => (
                                  <div key={group.type} className="rounded bg-secondary/40 overflow-hidden">
                                    <div
                                      className="px-2 py-1 flex items-center justify-between border-b"
                                      style={{
                                        backgroundColor: `${TYPE_COLORS[group.type]}10`,
                                        borderColor: `${TYPE_COLORS[group.type]}20`,
                                      }}
                                    >
                                      <div className="flex items-center gap-1.5">
                                        <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: TYPE_COLORS[group.type] }} />
                                        <span className="text-[11px] font-medium capitalize" style={{ color: TYPE_COLORS[group.type] }}>
                                          {group.type}s
                                        </span>
                                      </div>
                                      <span className="text-[10px] text-muted-foreground tabular-nums">{group.memories.length}</span>
                                    </div>
                                    <div className="p-1 space-y-0.5">
                                      {group.memories.map((memory, index) => {
                                        const title = parseSnippetTitle(memory.snippet)
                                        const trigger = formatRetrievalTrigger(memory)

                                        return (
                                          <button
                                            key={`${memory.id}-${index}`}
                                            type="button"
                                            onClick={() => handleSelect(memory.id, {
                                              prompt: memory.prompt,
                                              similarity: memory.similarity,
                                              keywordMatch: memory.keywordMatch,
                                              score: memory.score
                                            })}
                                            className="w-full text-left flex items-center gap-1.5 py-1 px-1.5 rounded text-xs cursor-pointer hover:bg-secondary/50 transition-base group"
                                          >
                                            <span className="flex-1 truncate text-foreground/70 group-hover:text-foreground/90">{title}</span>
                                            {trigger && (
                                              <span className={`text-[9px] font-mono px-0.5 rounded bg-background/50 shrink-0 ${trigger.color}`} title={trigger.title}>
                                                {trigger.label}
                                              </span>
                                            )}
                                            <span className={`text-[10px] font-mono shrink-0 ${getUsageColor(memory.stats)}`}>
                                              {formatUsageRatio(memory.stats)}
                                            </span>
                                          </button>
                                        )
                                      })}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>

                        {/* Expanded prompt detail - below the grid */}
                        {expandedPrompt && (() => {
                          const promptMemories = getPromptMemories(selectedSession, expandedPrompt)
                          return (
                            <div className="rounded-lg border border-foreground/20 bg-background/60 p-3 space-y-3">
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Prompt Detail</div>
                                  {expandedPrompt.status && (
                                    <span className={`px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wide ${STATUS_STYLES[expandedPrompt.status].badge}`}>
                                      {STATUS_STYLES[expandedPrompt.status].label}
                                    </span>
                                  )}
                                </div>
                                <div className="flex items-center gap-2">
                                  <button
                                    type="button"
                                    onClick={() => handleSendToSimulator(expandedPrompt.text, selectedSession.cwd)}
                                    className="text-[10px] px-2 py-1 rounded border border-border bg-background hover:bg-secondary transition-base"
                                  >
                                    Open in Simulator
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setExpandedPromptIndex(null)}
                                    className="text-[10px] px-2 py-1 rounded border border-border bg-background hover:bg-secondary transition-base"
                                  >
                                    Close
                                  </button>
                                </div>
                              </div>
                              <div className="rounded bg-secondary/30 p-3 max-h-32 overflow-y-auto">
                                <pre className="text-xs text-foreground whitespace-pre-wrap font-mono leading-relaxed">
                                  {expandedPrompt.text.trim() || '(empty prompt)'}
                                </pre>
                              </div>
                              {promptMemories.length > 0 && (
                                <div className="space-y-2">
                                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                                    Injected Memories ({promptMemories.length})
                                  </div>
                                  <div className="space-y-1">
                                    {promptMemories.map((memory, idx) => {
                                      const title = parseSnippetTitle(memory.snippet)
                                      const trigger = formatRetrievalTrigger(memory)
                                      return (
                                        <button
                                          key={`${memory.id}-prompt-${idx}`}
                                          type="button"
                                          onClick={() => handleSelect(memory.id, {
                                            prompt: memory.prompt,
                                            similarity: memory.similarity,
                                            keywordMatch: memory.keywordMatch,
                                            score: memory.score
                                          })}
                                          className="w-full text-left flex items-center gap-2 py-1.5 px-2 rounded border border-border bg-secondary/30 hover:bg-secondary/50 transition-base group"
                                        >
                                          <span
                                            className="w-2 h-2 rounded-full shrink-0"
                                            style={{ backgroundColor: memory.type ? TYPE_COLORS[memory.type] : '#888' }}
                                          />
                                          <span className="flex-1 truncate text-xs text-foreground/80 group-hover:text-foreground">{title}</span>
                                          {trigger && (
                                            <span className={`text-[9px] font-mono px-1 rounded bg-background/50 shrink-0 ${trigger.color}`} title={trigger.title}>
                                              {trigger.label}
                                            </span>
                                          )}
                                          <span className={`text-[10px] font-mono shrink-0 ${getUsageColor(memory.stats)}`}>
                                            {formatUsageRatio(memory.stats)}
                                          </span>
                                        </button>
                                      )
                                    })}
                                  </div>
                                </div>
                              )}
                            </div>
                          )
                        })()}
                      </div>
                    </div>
                  )
                })()
              )}
            </section>
          </div>
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
