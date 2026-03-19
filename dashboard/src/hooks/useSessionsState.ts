import { useEffect, useMemo, useState } from 'react'
import type { SessionRecord } from '@/lib/api'
import {
  TIME_FILTERS,
  extractProjectName,
  formatProjectLabel,
  getProjectKey,
  getPromptCount,
  isSessionActive,
  type SortKey,
  type TimeFilterKey
} from '@/components/sessions/utils'

export function useSessionsState(sessions: SessionRecord[]) {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [timeFilter, setTimeFilter] = useState<TimeFilterKey>('12h')
  const [projectFilter, setProjectFilter] = useState('all')
  const [hasMemoriesOnly, setHasMemoriesOnly] = useState(false)
  const [hasReviewsOnly, setHasReviewsOnly] = useState(false)
  const [activeOnly, setActiveOnly] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>('recent')

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
      if (hasReviewsOnly && !session.hasReview) return false

      if (!normalizedQuery) return true

      const projectName = extractProjectName(session.cwd).toLowerCase()
      const cwd = (session.cwd ?? '').toLowerCase()
      if (projectName.includes(normalizedQuery) || cwd.includes(normalizedQuery)) return true

      for (const memory of session.memories) {
        if (memory.snippet?.toLowerCase().includes(normalizedQuery)) return true
      }

      const prompts = session.prompts
      if (Array.isArray(prompts)) {
        for (const prompt of prompts) {
          if (prompt.text?.toLowerCase().includes(normalizedQuery)) return true
        }
      }

      return false
    })
  }, [sessions, searchQuery, timeFilter, projectFilter, activeOnly, hasMemoriesOnly, hasReviewsOnly])

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

  return {
    selectedSessionId,
    setSelectedSessionId,
    selectedSession,
    summary,
    projectOptions,
    filteredSessions,
    sortedSessions,
    groupedSessions,
    searchQuery,
    setSearchQuery,
    timeFilter,
    setTimeFilter,
    projectFilter,
    setProjectFilter,
    hasMemoriesOnly,
    setHasMemoriesOnly,
    hasReviewsOnly,
    setHasReviewsOnly,
    activeOnly,
    setActiveOnly,
    sortKey,
    setSortKey
  }
}
