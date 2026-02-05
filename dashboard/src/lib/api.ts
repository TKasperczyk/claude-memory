import type {
  CommandStatus,
  ExtractionReview,
  ExtractionRun,
  HookEvent,
  HookStatus,
  InjectionPromptEntry,
  InjectionReview,
  InjectionSessionRecord,
  MaintenanceOperationInfo,
  MaintenanceReview,
  MaintenanceSettings,
  MemoryRecord,
  MemoryStatsSummary,
  NearMissRecord,
  OperationResult,
  RecordType,
  RetrievalActivity,
  RetrievalActivityPeriod,
  RetrievalSettings,
  ScoredRecord,
  SearchResult,
  Settings,
  StatsSnapshot
} from '../../../shared/types.js'

export type {
  BaseRecord,
  CommandRecord,
  ConflictVerdict,
  DiscoveryRecord,
  ErrorRecord,
  ExclusionReason,
  ExtractionReview,
  ExtractionReviewIssue,
  ExtractionRun,
  HookEvent,
  InjectedMemoryEntry,
  InjectedMemoryVerdict,
  InjectionReview,
  InjectionStatus,
  MaintenanceAction,
  MaintenanceActionDetails,
  MaintenanceActionType,
  MaintenanceCandidateGroup,
  MaintenanceCandidateRecord,
  MaintenanceMergeRecord,
  MaintenanceOperationInfo,
  MaintenanceProgress,
  MaintenanceReview,
  MaintenanceSettings,
  MemoryRecord,
  MemoryStats,
  MemoryStatsSummary,
  MissedMemory,
  NearMissRecord,
  OperationResult,
  ProcedureRecord,
  RecordType,
  RetrievalActivity,
  RetrievalActivityBucket,
  RetrievalActivityPeriod,
  RetrievalEvent,
  RetrievalSettings,
  ScoredRecord,
  SearchResult,
  Settings,
  StatsSnapshot,
  WarningRecord,
  WarningSeverity
} from '../../../shared/types.js'

export type HookStatusEntry = HookStatus
export type CommandStatusEntry = CommandStatus
export type SessionPromptEntry = InjectionPromptEntry
export type SessionRecord = InjectionSessionRecord

export interface SettingsDefaultsResponse {
  settings: Settings
  maintenance: MaintenanceSettings
}

export type StatsResponse = MemoryStatsSummary

export interface StatsHistoryBucket {
  start: number
  end: number
  snapshot: StatsSnapshot | null
}

export interface StatsHistoryResponse {
  period: RetrievalActivityPeriod
  buckets: StatsHistoryBucket[]
}

export interface MemoryListResponse {
  records: MemoryRecord[]
  count: number
  total: number
  offset: number
  limit: number
}

export interface ActionResponse {
  success: boolean
}

export interface HookStatusResponse {
  hooks: Record<HookEvent, HookStatusEntry>
}

export interface HookInstallResponse {
  success: boolean
  hooks: Record<HookEvent, HookStatusEntry>
}

export interface InstallationStatusResponse {
  hooks: Record<HookEvent, HookStatusEntry>
  commands: Record<string, CommandStatusEntry>
}

export interface InstallationMutationResponse extends InstallationStatusResponse {
  success: boolean
}

export interface SearchResponse {
  query: string
  total: number
  results: SearchResult[]
}

export interface PreviewResponse {
  signals: {
    errors: string[]
    commands: string[]
    projectRoot?: string
    projectName?: string
    domain?: string
  }
  results: SearchResult[]
  nearMisses?: NearMissRecord[]
  injected?: ScoredRecord[]
  injectedRecords: MemoryRecord[]
  context: string | null
  timedOut?: boolean
}

export interface SessionsResponse {
  sessions: SessionRecord[]
  count: number
}

export interface MemoryTypesResponse {
  types: RecordType[]
}

export interface ExtractionListResponse {
  runs: ExtractionRun[]
  count: number
  total: number
  offset: number
  limit: number
}

export interface ExtractionRunResponse {
  run: ExtractionRun
  records: MemoryRecord[]
}

export interface MaintenanceOperationsResponse {
  operations: MaintenanceOperationInfo[]
}

export interface ApplySuggestionPayload {
  recordId: string
  action: 'new' | 'edit'
  targetFile: string
  diff: string
  overwrite?: boolean
}

export interface ApplySuggestionResponse {
  success: boolean
  recordId: string
  action: 'new' | 'edit'
  targetFile: string
  addedLines: number
}

export type ChatRole = 'user' | 'assistant'

export interface ChatMessage {
  role: ChatRole
  content: string
}

export interface ChatRequest {
  messages: ChatMessage[]
  project?: string
}

export type ChatToolName = 'search_memories' | 'update_memory' | 'delete_memories'

export interface ChatSearchResult {
  query: string
  count: number
  results: SearchResult[]
}

export interface ChatUpdateResult {
  id: string
  success: boolean
  updates: Partial<MemoryRecord>
  record?: MemoryRecord | null
  error?: string
}

export interface ChatDeleteResult {
  ids: string[]
  deleted: number
  missing: string[]
  error?: string
}

export type ChatToolResult =
  | ChatSearchResult
  | ChatUpdateResult
  | ChatDeleteResult
  | { error: string }

export type ChatStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: ChatToolName; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; name: ChatToolName; result: ChatToolResult; is_error?: boolean }
  | { type: 'done' }
  | { type: 'error'; error: string }

export class ApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(options?.headers ?? {})
    },
    ...options
  })

  if (!response.ok) {
    const message = await response.text()
    throw new Error(message || `Request failed (${response.status})`)
  }

  return response.json() as Promise<T>
}

async function requestWithStatus<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(options?.headers ?? {})
    },
    ...options
  })

  if (!response.ok) {
    const body = await response.text()
    const contentType = response.headers.get('Content-Type') ?? ''
    let message = body
    if (contentType.includes('application/json')) {
      try {
        const parsed = JSON.parse(body) as { error?: string }
        if (typeof parsed?.error === 'string') {
          message = parsed.error
        }
      } catch {
        // Fall back to raw text
      }
    }
    throw new ApiError(message || `Request failed (${response.status})`, response.status)
  }

  return response.json() as Promise<T>
}

export function fetchStats(): Promise<StatsResponse> {
  return request('/stats')
}

export function fetchRetrievalActivity(params: {
  period?: RetrievalActivityPeriod
  limit?: number
} = {}): Promise<RetrievalActivity> {
  const search = new URLSearchParams()
  if (params.period) search.set('period', params.period)
  if (typeof params.limit === 'number') search.set('limit', String(params.limit))
  const query = search.toString()
  return request(`/retrieval-activity${query ? `?${query}` : ''}`)
}

export function fetchStatsHistory(params: {
  period?: RetrievalActivityPeriod
  limit?: number
} = {}): Promise<StatsHistoryResponse> {
  const search = new URLSearchParams()
  if (params.period) search.set('period', params.period)
  if (typeof params.limit === 'number') search.set('limit', String(params.limit))
  const query = search.toString()
  return request(`/stats-history${query ? `?${query}` : ''}`)
}

export function fetchSettings(): Promise<Settings> {
  return request('/settings')
}

export function fetchSettingsDefaults(): Promise<SettingsDefaultsResponse> {
  return request('/settings/defaults')
}

export function updateSettings(settings: Partial<Settings>, options?: RequestInit): Promise<Settings> {
  return request('/settings', {
    method: 'PUT',
    body: JSON.stringify(settings),
    ...options
  })
}

export function updateSetting(setting: string, value: string | number): Promise<Settings> {
  return requestWithStatus('/settings', {
    method: 'PATCH',
    body: JSON.stringify({ setting, value })
  })
}

export function resetSettings(): Promise<Settings> {
  return request('/settings/reset', { method: 'POST' })
}

export function fetchHookStatus(): Promise<HookStatusResponse> {
  return requestWithStatus('/hooks/status')
}

export function installHooks(): Promise<HookInstallResponse> {
  return requestWithStatus('/hooks/install', { method: 'POST' })
}

export function uninstallHooks(): Promise<HookInstallResponse> {
  return requestWithStatus('/hooks/uninstall', { method: 'POST' })
}

export function fetchInstallationStatus(): Promise<InstallationStatusResponse> {
  return requestWithStatus('/installation/status')
}

export function installAll(): Promise<InstallationMutationResponse> {
  return requestWithStatus('/installation/install', { method: 'POST' })
}

export function uninstallAll(): Promise<InstallationMutationResponse> {
  return requestWithStatus('/installation/uninstall', { method: 'POST' })
}

export function fetchMemories(params: {
  limit?: number
  offset?: number
  type?: RecordType
  project?: string
  deprecated?: boolean
} = {}): Promise<MemoryListResponse> {
  const search = new URLSearchParams()

  if (typeof params.limit === 'number') search.set('limit', String(params.limit))
  if (typeof params.offset === 'number') search.set('offset', String(params.offset))
  if (params.type) search.set('type', params.type)
  if (params.project) search.set('project', params.project)
  if (params.deprecated) search.set('deprecated', 'true')

  const query = search.toString()
  return request(`/memories${query ? `?${query}` : ''}`)
}

export function fetchMemory(id: string): Promise<MemoryRecord> {
  return request(`/memories/${id}`)
}

export function deleteMemory(id: string): Promise<ActionResponse> {
  return request(`/memories/${id}`, { method: 'DELETE' })
}

export function resetCollection(): Promise<ActionResponse> {
  return request('/reset-collection', { method: 'POST' })
}

export function searchMemories(params: {
  query: string
  limit?: number
  offset?: number
  type?: RecordType
  project?: string
  deprecated?: boolean
}): Promise<SearchResponse> {
  const search = new URLSearchParams({ q: params.query })
  if (typeof params.limit === 'number') search.set('limit', String(params.limit))
  if (typeof params.offset === 'number') search.set('offset', String(params.offset))
  if (params.type) search.set('type', params.type)
  if (params.project) search.set('project', params.project)
  if (params.deprecated) search.set('deprecated', 'true')
  return request(`/search?${search.toString()}`)
}

export function previewContext(payload: {
  prompt: string
  cwd?: string
  settings?: Partial<RetrievalSettings>
  diagnostic?: boolean
}): Promise<PreviewResponse> {
  return request('/preview', {
    method: 'POST',
    body: JSON.stringify(payload)
  })
}

export function fetchSessions(): Promise<SessionsResponse> {
  return request('/sessions')
}

export async function fetchMemoryTypes(): Promise<RecordType[]> {
  const response = await request<MemoryTypesResponse>('/memory-types')
  return response.types
}

export function fetchExtractions(params: {
  limit?: number
  offset?: number
} = {}): Promise<ExtractionListResponse> {
  const search = new URLSearchParams()
  if (typeof params.limit === 'number') search.set('limit', String(params.limit))
  if (typeof params.offset === 'number') search.set('offset', String(params.offset))
  const query = search.toString()
  return request(`/extractions${query ? `?${query}` : ''}`)
}

export function fetchExtractionRun(runId: string): Promise<ExtractionRunResponse> {
  return request(`/extractions/${runId}`)
}

export function deleteExtractionRun(runId: string): Promise<ActionResponse> {
  return request(`/extractions/${runId}`, { method: 'DELETE' })
}

export async function fetchExtractionReview(runId: string): Promise<ExtractionReview | null> {
  const response = await fetch(`/api/extractions/${runId}/review`)
  if (response.status === 404) return null
  if (!response.ok) {
    const message = await response.text()
    throw new Error(message || `Request failed (${response.status})`)
  }
  return response.json() as Promise<ExtractionReview>
}

export function runExtractionReview(runId: string): Promise<ExtractionReview> {
  return request(`/extractions/${runId}/review`, { method: 'POST' })
}

export async function fetchInjectionReview(sessionId: string): Promise<InjectionReview | null> {
  const response = await fetch(`/api/sessions/${sessionId}/review`)
  if (response.status === 404) return null
  if (!response.ok) {
    const message = await response.text()
    throw new Error(message || `Request failed (${response.status})`)
  }
  return response.json() as Promise<InjectionReview>
}

export function runInjectionReview(sessionId: string): Promise<InjectionReview> {
  return request(`/sessions/${sessionId}/review`, { method: 'POST' })
}

export function fetchMaintenanceOperations(): Promise<MaintenanceOperationsResponse> {
  return request('/maintenance/operations')
}

export function runMaintenance(operation: string, dryRun: boolean): Promise<OperationResult> {
  return request('/maintenance/run', {
    method: 'POST',
    body: JSON.stringify({ operation, dryRun })
  })
}

export async function fetchMaintenanceReview(
  operation: string,
  resultId: string
): Promise<MaintenanceReview | null> {
  const response = await fetch(`/api/maintenance/${operation}/review/${resultId}`)
  if (response.status === 404) return null
  if (!response.ok) {
    throw new Error(await response.text() || `Request failed (${response.status})`)
  }
  return response.json() as Promise<MaintenanceReview>
}

export function runMaintenanceReview(
  operation: string,
  result: OperationResult
): Promise<MaintenanceReview> {
  return request(`/maintenance/${operation}/review`, {
    method: 'POST',
    body: JSON.stringify({ result })
  })
}

export function runAllMaintenance(dryRun: boolean): Promise<OperationResult[]> {
  return request('/maintenance/run-all', {
    method: 'POST',
    body: JSON.stringify({ dryRun })
  })
}

export function applyMaintenanceSuggestion(payload: ApplySuggestionPayload): Promise<ApplySuggestionResponse> {
  return requestWithStatus('/maintenance/suggestions/apply', {
    method: 'POST',
    body: JSON.stringify(payload)
  })
}

export async function streamChat(
  payload: ChatRequest,
  options: { onEvent: (event: ChatStreamEvent) => void; signal?: AbortSignal }
): Promise<void> {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: options.signal
  })

  if (!response.ok) {
    const message = await response.text()
    throw new Error(message || `Request failed (${response.status})`)
  }

  const contentType = response.headers.get('Content-Type') ?? ''
  if (!contentType.includes('text/event-stream')) {
    const message = await response.text()
    throw new Error(message || 'Expected streaming response')
  }

  if (!response.body) {
    throw new Error('Streaming response body missing')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let eventName: string | null = null
  let dataLines: string[] = []

  const flushEvent = () => {
    const payloadText = dataLines.join('\n')
    dataLines = []
    const name = eventName
    eventName = null

    if (!payloadText) return
    if (payloadText === '[DONE]') {
      options.onEvent({ type: 'done' })
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(payloadText)
    } catch {
      throw new Error('Failed to parse stream payload')
    }

    if (!name) return

    if (name === 'text') {
      const text = (parsed as { text?: string })?.text ?? ''
      if (text) options.onEvent({ type: 'text', text })
      return
    }

    if (name === 'tool_use') {
      const data = parsed as { id?: string; name?: ChatToolName; input?: unknown }
      if (data.id && data.name) {
        options.onEvent({ type: 'tool_use', id: data.id, name: data.name, input: data.input })
      }
      return
    }

    if (name === 'tool_result') {
      const data = parsed as { tool_use_id?: string; name?: ChatToolName; result?: ChatToolResult; is_error?: boolean }
      if (data.tool_use_id && data.name) {
        options.onEvent({
          type: 'tool_result',
          tool_use_id: data.tool_use_id,
          name: data.name,
          result: data.result ?? { error: 'Empty tool result' },
          is_error: data.is_error
        })
      }
      return
    }

    if (name === 'done') {
      options.onEvent({ type: 'done' })
      return
    }

    if (name === 'error') {
      const error = (parsed as { error?: string })?.error ?? 'Chat error'
      options.onEvent({ type: 'error', error })
    }
  }

  while (true) {
    const { value, done } = await reader.read()
    if (done) {
      buffer += decoder.decode()
      break
    }

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim()
        continue
      }
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart())
        continue
      }
      if (line === '') {
        flushEvent()
      }
    }
  }

  if (buffer) {
    const lines = buffer.split(/\r?\n/)
    buffer = ''
    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim()
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart())
      } else if (line === '') {
        flushEvent()
      }
    }
  }

  if (dataLines.length > 0) {
    flushEvent()
  }
}
