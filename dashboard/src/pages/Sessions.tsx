import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { PageHeader } from '@/App'
import MemoryDetail from '@/components/MemoryDetail'
import { fetchMemory, fetchSessions, type MemoryRecord, type SessionRecord, type RecordType, type MemoryStats } from '@/lib/api'

const TYPE_COLORS: Record<string, string> = {
  command: '#2dd4bf',
  error: '#f43f5e',
  discovery: '#60a5fa',
  procedure: '#a78bfa',
}

const TYPE_ORDER: RecordType[] = ['error', 'command', 'discovery', 'procedure']

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

interface TypeGroup {
  type: RecordType
  memories: SessionRecord['memories']
}

function groupByType(memories: SessionRecord['memories']): TypeGroup[] {
  const groups: Map<RecordType, SessionRecord['memories']> = new Map()

  for (const m of memories) {
    const type = parseSnippetType(m.snippet)
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
  const [loadingMemory, setLoadingMemory] = useState<string | null>(null)

  const handleMemoryClick = async (memoryId: string) => {
    if (loadingMemory) return
    setLoadingMemory(memoryId)
    try {
      const record = await fetchMemory(memoryId)
      setSelected(record)
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
            const typeGroups = groupByType(memories)

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
                    <div className="p-3 pt-0 max-h-80 overflow-y-auto space-y-2">
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

                              return (
                                <button
                                  key={`${memory.id}-${mi}`}
                                  onClick={() => handleMemoryClick(memory.id)}
                                  disabled={isLoading}
                                  className="w-full text-left flex items-center gap-2 py-1.5 px-2 rounded text-sm hover:bg-background/60 transition-base disabled:opacity-50 group"
                                >
                                  <span className="flex-1 truncate text-foreground/70 group-hover:text-foreground/90">{title}</span>
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
            )
          })}
        </div>
      )}

      <MemoryDetail record={selected} onClose={() => setSelected(null)} />
    </div>
  )
}
