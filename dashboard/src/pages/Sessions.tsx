import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { PageHeader } from '@/App'
import { fetchSessions, type SessionRecord, type RecordType, type MemoryStats } from '@/lib/api'

const TYPE_COLORS: Record<string, string> = {
  command: '#2dd4bf',
  error: '#f43f5e',
  discovery: '#60a5fa',
  procedure: '#a78bfa',
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

function parseSnippetType(snippet: string): RecordType | null {
  const match = snippet.match(/^(command|error|discovery|procedure):/)
  return match ? (match[1] as RecordType) : null
}

function parseSnippetTitle(snippet: string): string {
  const withoutType = snippet.replace(/^(command|error|discovery|procedure):\s*/, '')
  const mainPart = withoutType.split('|')[0].trim()
  return mainPart.length > 60 ? mainPart.slice(0, 57) + '…' : mainPart
}

function extractProjectName(cwd: string | undefined): string {
  if (!cwd) return 'Unknown'
  const parts = cwd.split('/')
  return parts[parts.length - 1] || cwd
}

function isSessionActive(session: SessionRecord): boolean {
  return Date.now() - session.lastActivity < 5 * 60 * 1000
}

function dedupeMemories(memories: SessionRecord['memories']) {
  const seen = new Set<string>()
  return memories.filter(m => {
    if (seen.has(m.id)) return false
    seen.add(m.id)
    return true
  })
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

interface PromptGroup {
  prompt: string
  injectedAt: number
  memories: SessionRecord['memories']
}

function groupByPrompt(memories: SessionRecord['memories']): PromptGroup[] {
  const groups: PromptGroup[] = []
  let current: PromptGroup | null = null

  for (const m of memories) {
    const prompt = m.prompt || '(unknown trigger)'
    if (!current || current.prompt !== prompt) {
      current = { prompt, injectedAt: m.injectedAt, memories: [] }
      groups.push(current)
    }
    current.memories.push(m)
  }

  return groups
}

function truncatePrompt(prompt: string, max = 100): string {
  return prompt.length <= max ? prompt : prompt.slice(0, max - 1) + '…'
}

export default function Sessions() {
  const [sessions, setSessions] = useState<SessionRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

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
            const memories = dedupeMemories(session.memories)

            return (
              <div
                key={session.sessionId}
                className={`rounded-lg border transition-base ${
                  active ? 'border-green-500/30 bg-green-500/5' : 'border-border bg-card'
                }`}
              >
                {/* Header */}
                <button
                  onClick={() => setExpanded(isOpen ? null : session.sessionId)}
                  className="w-full px-4 py-3 flex items-center gap-3 text-left"
                >
                  {isOpen ? (
                    <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
                  )}

                  <span className={`w-2 h-2 rounded-full shrink-0 ${active ? 'bg-green-400' : 'bg-muted-foreground'}`} />

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium truncate">{extractProjectName(session.cwd)}</span>
                      {active && (
                        <span className="text-2xs text-green-400 font-medium">ACTIVE</span>
                      )}
                    </div>
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
                {isOpen && (
                  <div className="px-4 pb-4 pt-2 border-t border-border/50 space-y-4">
                    {groupByPrompt(memories).map((group, gi) => (
                      <div key={gi}>
                        <div className="flex items-start gap-2 mb-2">
                          <span className="text-2xs text-muted-foreground shrink-0">Trigger:</span>
                          <span className="text-xs text-muted-foreground italic truncate" title={group.prompt}>
                            {truncatePrompt(group.prompt)}
                          </span>
                          <span className="text-2xs text-muted-foreground shrink-0 ml-auto">
                            {formatRelative(group.injectedAt)}
                          </span>
                        </div>
                        <div className="space-y-1 pl-3 border-l border-border">
                          {group.memories.map((memory, mi) => {
                            const type = parseSnippetType(memory.snippet)
                            const title = parseSnippetTitle(memory.snippet)

                            return (
                              <div
                                key={`${memory.id}-${mi}`}
                                className="flex items-center gap-2 py-1.5 px-2 rounded bg-secondary/30 text-sm"
                              >
                                {type && (
                                  <span
                                    className="w-2 h-2 rounded-full shrink-0"
                                    style={{ backgroundColor: TYPE_COLORS[type] }}
                                  />
                                )}
                                <span className="flex-1 truncate">{title}</span>
                                <span className={`text-xs font-mono shrink-0 ${getUsageColor(memory.stats)}`}>
                                  {formatUsageRatio(memory.stats)}
                                </span>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
