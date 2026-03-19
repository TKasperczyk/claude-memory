import type { InjectionStatus, MemoryStats, RecordType, SessionRecord } from '@/lib/api'

export const TYPE_ORDER: RecordType[] = ['error', 'command', 'discovery', 'procedure']

export const STATUS_STYLES: Record<InjectionStatus, { badge: string; label: string }> = {
  injected: { badge: 'bg-success/15 text-success', label: 'Injected' },
  no_matches: { badge: 'bg-muted-foreground/15 text-muted-foreground', label: 'No matches' },
  empty_prompt: { badge: 'bg-muted-foreground/15 text-muted-foreground', label: 'Empty' },
  timeout: { badge: 'bg-destructive/15 text-destructive', label: 'Timeout' },
  error: { badge: 'bg-destructive/15 text-destructive', label: 'Error' }
}

export const HEALTH_STYLES = {
  healthy: {
    label: 'Healthy',
    badge: 'bg-success/15 text-success',
    bar: 'bg-success/70',
    text: 'text-success'
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

export const TIME_FILTERS = [
  { key: 'all', label: 'All time', ms: Number.POSITIVE_INFINITY },
  { key: '12h', label: '12h', ms: 12 * 60 * 60 * 1000 },
  { key: '24h', label: '24h', ms: 24 * 60 * 60 * 1000 },
  { key: '7d', label: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
  { key: '30d', label: '30d', ms: 30 * 24 * 60 * 60 * 1000 }
] as const

export type TimeFilterKey = typeof TIME_FILTERS[number]['key']

export const SORT_OPTIONS = [
  { key: 'recent', label: 'Most recent' },
  { key: 'prompts', label: 'Most prompts' },
  { key: 'memories', label: 'Most memories' },
  { key: 'health', label: 'Best injection rate' }
] as const

export type SortKey = typeof SORT_OPTIONS[number]['key']

export function getInjectionRatioBadge(
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
    return { badge: 'bg-success/15 text-success', text: 'text-success', label, title }
  }
  if (ratio > 0) {
    return { badge: 'bg-warning/15 text-warning', text: 'text-warning', label, title }
  }
  return { badge: 'bg-destructive/15 text-destructive', text: 'text-destructive', label, title }
}

export type PromptDisplayEntry = {
  text: string
  timestamp?: number
  status?: InjectionStatus
  memoryCount?: number
}

const ACTIVE_WINDOW_MS = 5 * 60 * 1000
const STALE_WINDOW_MS = 12 * 60 * 60 * 1000
const PROMPT_MATCH_WINDOW_MS = 5000

export function parseSnippetTitle(snippet: string): string {
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

export function extractProjectName(cwd: string | undefined): string {
  const normalized = normalizeCwd(cwd)
  if (!normalized) return 'Unknown'
  const parts = splitPath(normalized)
  return parts[parts.length - 1] || normalized
}

export function getProjectKey(cwd: string | undefined): string {
  return normalizeCwd(cwd) ?? 'Unknown'
}

export function formatProjectLabel(cwd: string | undefined, shortName: string, hasCollision: boolean): string {
  const normalized = normalizeCwd(cwd)
  if (!hasCollision || !normalized) return shortName
  return `${shortName} (${normalized})`
}

export function isSessionActive(session: SessionRecord): boolean {
  return Date.now() - session.lastActivity < ACTIVE_WINDOW_MS
}

export function formatUsageRatio(stats: MemoryStats | null | undefined): string {
  if (!stats || stats.retrievalCount === 0) return '—'
  return `${stats.usageCount}/${stats.retrievalCount}`
}

export function getUsageColor(stats: MemoryStats | null | undefined): string {
  if (!stats || stats.retrievalCount === 0) return 'text-muted-foreground'
  const ratio = stats.usageCount / stats.retrievalCount
  if (ratio >= 0.7) return 'text-success'
  return 'text-muted-foreground'
}

export function formatMemoryCount(count: number | undefined): string | null {
  if (typeof count !== 'number') return null
  return `${count} ${count === 1 ? 'memory' : 'memories'}`
}

export function getSessionRatio(session: SessionRecord) {
  const promptCount = getPromptCount(session)
  const injectionCount = session.injectionCount ?? 0
  if (typeof promptCount !== 'number') {
    return { ratio: null, promptCount: null, injectionCount }
  }
  const ratio = promptCount > 0 ? injectionCount / promptCount : 0
  return { ratio, promptCount, injectionCount }
}

export function getSessionHealth(session: SessionRecord) {
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

export function getActivityStatus(session: SessionRecord): { label: string; badge: string; dot: string } {
  const diff = Date.now() - session.lastActivity
  if (diff < ACTIVE_WINDOW_MS) {
    return { label: 'Active', badge: 'bg-success/15 text-success', dot: 'bg-success' }
  }
  if (diff < STALE_WINDOW_MS) {
    return { label: 'Recent', badge: 'bg-foreground/10 text-foreground/70', dot: 'bg-foreground/50' }
  }
  return { label: 'Stale', badge: 'bg-muted-foreground/15 text-muted-foreground', dot: 'bg-muted-foreground' }
}

export function getSessionPrompts(session: SessionRecord): PromptDisplayEntry[] | null {
  const sessionPrompts = session.prompts
  if (Array.isArray(sessionPrompts)) {
    return sessionPrompts
  }
  return null
}

export function getPromptMemories(session: SessionRecord, prompt: PromptDisplayEntry): SessionRecord['memories'] {
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

export function getPromptCount(session: SessionRecord): number | null {
  if (typeof session.promptCount === 'number') return session.promptCount
  const prompts = getSessionPrompts(session)
  if (Array.isArray(prompts)) return prompts.length
  return null
}

export interface TypeGroup {
  type: RecordType
  memories: SessionRecord['memories']
}

export function groupByType(memories: SessionRecord['memories']): TypeGroup[] {
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

export function formatRetrievalTrigger(memory: SessionRecord['memories'][0]): { label: string; color: string; title: string } | null {
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
