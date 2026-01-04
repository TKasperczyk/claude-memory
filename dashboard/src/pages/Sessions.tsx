import { useEffect, useState } from 'react'
import TypeBadge from '@/components/TypeBadge'
import { fetchSessions, type SessionRecord, type RecordType, type MemoryStats } from '@/lib/api'

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (days > 0) return `${days}d ago`
  if (hours > 0) return `${hours}h ago`
  if (minutes > 0) return `${minutes}m ago`
  return 'just now'
}

function parseSnippetType(snippet: string): RecordType | null {
  const match = snippet.match(/^(command|error|discovery|procedure):/)
  return match ? (match[1] as RecordType) : null
}

function parseSnippetTitle(snippet: string): string {
  // Remove type prefix and extract main content
  const withoutType = snippet.replace(/^(command|error|discovery|procedure):\s*/, '')
  // Get first part before any | delimiter
  const mainPart = withoutType.split('|')[0].trim()
  // Truncate if too long
  return mainPart.length > 80 ? mainPart.slice(0, 77) + '...' : mainPart
}

function extractProjectName(cwd: string | undefined): string {
  if (!cwd) return 'Unknown'
  const parts = cwd.split('/')
  return parts[parts.length - 1] || cwd
}

function isSessionActive(session: SessionRecord): boolean {
  const fiveMinutesAgo = Date.now() - 5 * 60 * 1000
  return session.lastActivity > fiveMinutesAgo
}

function dedupeMemories(memories: SessionRecord['memories']) {
  const seen = new Set<string>()
  return memories.filter(m => {
    if (seen.has(m.id)) return false
    seen.add(m.id)
    return true
  })
}

interface PromptGroup {
  prompt: string
  injectedAt: number
  memories: SessionRecord['memories']
}

function groupByPrompt(memories: SessionRecord['memories']): PromptGroup[] {
  const groups: PromptGroup[] = []
  let currentGroup: PromptGroup | null = null

  for (const memory of memories) {
    const prompt = memory.prompt || '(unknown trigger)'
    if (!currentGroup || currentGroup.prompt !== prompt) {
      currentGroup = { prompt, injectedAt: memory.injectedAt, memories: [] }
      groups.push(currentGroup)
    }
    currentGroup.memories.push(memory)
  }

  return groups
}

function truncatePrompt(prompt: string, maxLen = 120): string {
  if (prompt.length <= maxLen) return prompt
  return prompt.slice(0, maxLen - 3) + '...'
}

function formatUsageRatio(stats: MemoryStats | null | undefined): { label: string; color: string } {
  if (!stats) return { label: '—', color: 'text-slate-600' }

  const { retrievalCount, usageCount } = stats
  if (retrievalCount === 0) return { label: '0/0', color: 'text-slate-500' }

  const ratio = usageCount / retrievalCount
  const label = `${usageCount}/${retrievalCount}`

  if (ratio >= 0.7) return { label, color: 'text-emerald-400' }
  if (ratio >= 0.3) return { label, color: 'text-amber-400' }
  return { label, color: 'text-rose-400' }
}

export default function Sessions() {
  const [sessions, setSessions] = useState<SessionRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedSession, setExpandedSession] = useState<string | null>(null)

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
    // Auto-refresh every 5 seconds
    const interval = setInterval(loadSessions, 5000)
    return () => clearInterval(interval)
  }, [])

  if (loading && sessions.length === 0) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-lg border border-rose-500/20 bg-rose-500/10 p-6 text-rose-400">
        {error}
      </div>
    )
  }

  if (sessions.length === 0) {
    return (
      <div className="text-center py-20 text-slate-400">
        No sessions tracked yet. Sessions appear when Claude Code injects memories.
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-white">Active Sessions</h1>
        <span className="text-sm text-slate-400">
          {sessions.length} session{sessions.length !== 1 ? 's' : ''} tracked
        </span>
      </div>

      <div className="space-y-4">
        {sessions.map(session => {
          const isActive = isSessionActive(session)
          const isExpanded = expandedSession === session.sessionId
          const uniqueMemories = dedupeMemories(session.memories)

          return (
            <div
              key={session.sessionId}
              className={`rounded-lg border transition-colors ${
                isActive
                  ? 'border-emerald-500/30 bg-emerald-500/5'
                  : 'border-white/5 bg-white/[0.02]'
              }`}
            >
              <button
                onClick={() => setExpandedSession(isExpanded ? null : session.sessionId)}
                className="w-full px-5 py-4 text-left"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-3">
                      <span
                        className={`inline-flex h-2 w-2 rounded-full ${
                          isActive ? 'bg-emerald-400 animate-pulse' : 'bg-slate-600'
                        }`}
                      />
                      <span className="font-medium text-white truncate">
                        {extractProjectName(session.cwd)}
                      </span>
                      {isActive && (
                        <span className="text-xs font-medium text-emerald-400 uppercase tracking-wider">
                          Active
                        </span>
                      )}
                    </div>
                    {session.cwd && (
                      <p className="mt-1 text-sm text-slate-500 truncate pl-5">
                        {session.cwd}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-4 text-sm text-slate-400">
                    <span>{uniqueMemories.length} memories</span>
                    <span>{formatRelativeTime(session.lastActivity)}</span>
                    <svg
                      className={`h-5 w-5 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </div>
                </div>
              </button>

              {isExpanded && (
                <div className="border-t border-white/5 px-5 py-4 space-y-4">
                  {groupByPrompt(uniqueMemories).map((group, groupIdx) => (
                    <div key={groupIdx}>
                      <div className="flex items-start gap-2 mb-2">
                        <span className="text-xs text-amber-500/80 font-medium shrink-0">Trigger:</span>
                        <span className="text-xs text-slate-400 italic" title={group.prompt}>
                          {truncatePrompt(group.prompt)}
                        </span>
                        <span className="text-xs text-slate-600 shrink-0 ml-auto">
                          {formatRelativeTime(group.injectedAt)}
                        </span>
                      </div>
                      <div className="space-y-1.5 pl-3 border-l border-white/5">
                        {group.memories.map((memory, idx) => {
                          const type = parseSnippetType(memory.snippet)
                          const title = parseSnippetTitle(memory.snippet)
                          const usage = formatUsageRatio(memory.stats)

                          return (
                            <div
                              key={`${memory.id}-${idx}`}
                              className="flex items-start gap-3 rounded-md bg-white/[0.03] px-3 py-2"
                            >
                              {type && <TypeBadge type={type} />}
                              <span className="text-sm text-slate-300 flex-1">{title}</span>
                              <span
                                className={`text-xs font-mono shrink-0 ${usage.color}`}
                                title="useful/retrieved"
                              >
                                {usage.label}
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
    </div>
  )
}
