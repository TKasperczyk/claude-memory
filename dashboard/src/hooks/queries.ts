import { useQuery } from '@tanstack/react-query'
import {
  fetchExtractions,
  fetchExtractionReview,
  fetchExtractionRun,
  fetchInjectionReview,
  fetchHookStatus,
  fetchInProgressExtractions,
  fetchInstallationStatus,
  fetchMaintenanceRuns,
  fetchMemories,
  fetchMemoryTypes,
  fetchRetrievalActivity,
  fetchTokenUsage,
  fetchSettings,
  fetchSettingsDefaults,
  fetchSessions,
  fetchStats,
  fetchStatsHistory,
  searchMemories,
  type ExtractionListResponse,
  type ExtractionRunResponse,
  type ExtractionReview,
  type InjectionReview,
  type HookStatusResponse,
  type InstallationStatusResponse,
  type MaintenanceRunsListResponse,
  type MemoryListResponse,
  type RecordType,
  type RetrievalActivity,
  type RetrievalActivityPeriod,
  type Settings,
  type SettingsDefaultsResponse,
  type SessionsResponse,
  type StatsHistoryResponse,
  type StatsResponse,
  type TokenUsageActivity,
  type TokenUsageSource
} from '@/lib/api'

type MemoriesQueryParams = {
  page?: number
  limit?: number
  type?: RecordType
  search?: string
  project?: string
  deprecated?: boolean
}

type ExtractionsQueryParams = {
  page?: number
  limit?: number
  sessionId?: string
}

export function useStats() {
  return useQuery<StatsResponse>({
    queryKey: ['stats'],
    queryFn: fetchStats,
    refetchInterval: 60000
  })
}

export function useMemories(params: MemoriesQueryParams) {
  const {
    page = 0,
    limit = 50,
    type,
    search,
    project,
    deprecated
  } = params

  return useQuery<MemoryListResponse>({
    queryKey: ['memories', { page, limit, type, search, project, deprecated }],
    queryFn: async () => {
      const offset = page * limit
      if (search && search.trim().length > 0) {
        const response = await searchMemories({
          query: search.trim(),
          limit,
          offset,
          type,
          project,
          deprecated
        })
        const records = response.results.map(result => result.record)
        const total = response.total ?? records.length
        return {
          records,
          count: records.length,
          total,
          offset,
          limit
        }
      }

      return fetchMemories({
        limit,
        offset,
        type,
        project,
        deprecated
      })
    },
    placeholderData: previousData => previousData,
    refetchInterval: 20000
  })
}

export function useInProgressExtractions() {
  return useQuery({
    queryKey: ['extractions-in-progress'],
    queryFn: fetchInProgressExtractions,
    refetchInterval: 5000
  })
}

export function useExtractions(params: ExtractionsQueryParams) {
  const { page = 0, limit = 25, sessionId } = params

  return useQuery<ExtractionListResponse>({
    queryKey: ['extractions', { page, limit, sessionId }],
    queryFn: () => fetchExtractions({
      limit,
      offset: page * limit,
      sessionId
    }),
    placeholderData: previousData => previousData,
    refetchInterval: 30000
  })
}

export function useMaintenanceRuns(params: { page?: number; limit?: number }) {
  const { page = 0, limit = 25 } = params

  return useQuery<MaintenanceRunsListResponse>({
    queryKey: ['maintenanceRuns', { page, limit }],
    queryFn: () => fetchMaintenanceRuns({
      limit,
      offset: page * limit
    }),
    placeholderData: previousData => previousData,
    refetchInterval: 60000
  })
}

export function useSessions() {
  return useQuery<SessionsResponse>({
    queryKey: ['sessions'],
    queryFn: fetchSessions,
    refetchInterval: 30000
  })
}

export function useMemoryTypes() {
  return useQuery<RecordType[]>({
    queryKey: ['memoryTypes'],
    queryFn: fetchMemoryTypes,
    staleTime: Infinity
  })
}

export function useSettings() {
  return useQuery<Settings>({
    queryKey: ['settings'],
    queryFn: fetchSettings
  })
}

export function useSettingsDefaults() {
  return useQuery<SettingsDefaultsResponse>({
    queryKey: ['settingsDefaults'],
    queryFn: fetchSettingsDefaults,
    staleTime: Infinity
  })
}

export function useHookStatus() {
  return useQuery<HookStatusResponse>({
    queryKey: ['hooksStatus'],
    queryFn: fetchHookStatus
  })
}

export function useInstallationStatus() {
  return useQuery<InstallationStatusResponse>({
    queryKey: ['installationStatus'],
    queryFn: fetchInstallationStatus
  })
}

export function useRetrievalActivity(params: {
  period?: RetrievalActivityPeriod
  limit?: number
} = {}) {
  return useQuery<RetrievalActivity>({
    queryKey: ['retrievalActivity', params],
    queryFn: () => fetchRetrievalActivity(params),
    refetchInterval: 60000
  })
}

export function useTokenUsage(params: {
  period?: RetrievalActivityPeriod
  limit?: number
  source?: TokenUsageSource | 'all'
} = {}) {
  return useQuery<TokenUsageActivity>({
    queryKey: ['tokenUsage', params],
    queryFn: () => fetchTokenUsage(params),
    refetchInterval: 60000
  })
}

export function useStatsHistory(params: {
  period?: RetrievalActivityPeriod
  limit?: number
} = {}) {
  return useQuery<StatsHistoryResponse>({
    queryKey: ['statsHistory', params],
    queryFn: () => fetchStatsHistory(params),
    refetchInterval: 60000
  })
}

export function useInjectionReview(sessionId: string | null) {
  return useQuery<InjectionReview | null>({
    queryKey: ['injection-review', sessionId],
    queryFn: () => fetchInjectionReview(sessionId!),
    enabled: !!sessionId
  })
}

export function useExtractionRunDetail(runId: string | null) {
  return useQuery<ExtractionRunResponse>({
    queryKey: ['extraction-run', runId],
    queryFn: () => fetchExtractionRun(runId!),
    enabled: !!runId
  })
}

export function useExtractionReview(runId: string | null) {
  return useQuery<ExtractionReview | null>({
    queryKey: ['extraction-review', runId],
    queryFn: () => fetchExtractionReview(runId!),
    enabled: !!runId
  })
}
