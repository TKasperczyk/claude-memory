export type RecordType = 'command' | 'error' | 'discovery' | 'procedure'

export interface BaseRecord {
  id: string
  type: RecordType
  timestamp?: number
  sourceSessionId?: string
  sourceExcerpt?: string
  project?: string
  domain?: string
  successCount?: number
  failureCount?: number
  retrievalCount?: number
  usageCount?: number
  lastUsed?: number
  deprecated?: boolean
}

export interface CommandRecord extends BaseRecord {
  type: 'command'
  command: string
  exitCode: number
  truncatedOutput?: string
  context: {
    project: string
    cwd: string
    intent: string
  }
  outcome: 'success' | 'failure' | 'partial'
  resolution?: string
}

export interface ErrorRecord extends BaseRecord {
  type: 'error'
  errorText: string
  errorType: string
  cause?: string
  resolution: string
  context: {
    project: string
    file?: string
    tool?: string
  }
}

export interface DiscoveryRecord extends BaseRecord {
  type: 'discovery'
  what: string
  where: string
  evidence: string
  confidence: 'verified' | 'inferred' | 'tentative'
}

export interface ProcedureRecord extends BaseRecord {
  type: 'procedure'
  name: string
  steps: string[]
  context: {
    project?: string
    domain: string
  }
  prerequisites?: string[]
  verification?: string
}

export type MemoryRecord = CommandRecord | ErrorRecord | DiscoveryRecord | ProcedureRecord

export interface StatsResponse {
  total: number
  byType: Record<string, number>
  byProject: Record<string, number>
  byDomain: Record<string, number>
  avgRetrievalCount: number
  avgUsageCount: number
  avgUsageRatio: number
  deprecated: number
}

export interface MemoryListResponse {
  records: MemoryRecord[]
  count: number
  total: number
  offset: number
  limit: number
}

export interface SearchResult {
  record: MemoryRecord
  score: number
  similarity: number
  keywordMatch: boolean
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
  injectedRecords: MemoryRecord[]
  context: string
}

export interface MemoryStats {
  id: string
  retrievalCount: number
  usageCount: number
  successCount: number
  failureCount: number
}

export interface InjectedMemoryEntry {
  id: string
  snippet: string
  type?: RecordType
  injectedAt: number
  prompt?: string
  stats?: MemoryStats | null
  // Retrieval trigger info
  similarity?: number    // Semantic similarity score (0-1)
  keywordMatch?: boolean // Whether it was found via keyword search
  score?: number         // Combined relevance score
}

export interface SessionRecord {
  sessionId: string
  createdAt: number
  lastActivity: number
  cwd?: string
  memories: InjectedMemoryEntry[]
}

export interface SessionsResponse {
  sessions: SessionRecord[]
  count: number
}

export interface ExtractionRun {
  runId: string
  sessionId: string
  transcriptPath: string
  timestamp: number
  recordCount: number
  parseErrorCount: number
  extractedRecordIds: string[]
  duration: number
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

export interface ExtractionReviewIssue {
  recordId?: string
  type: 'inaccurate' | 'partial' | 'hallucinated' | 'missed'
  severity: 'critical' | 'major' | 'minor'
  description: string
  evidence: string
  suggestedFix?: string
}

export interface ExtractionReview {
  runId: string
  reviewedAt: number
  overallAccuracy: 'good' | 'acceptable' | 'poor'
  accuracyScore: number
  issues: ExtractionReviewIssue[]
  summary: string
  model: string
  durationMs: number
}

export type MaintenanceActionType = 'deprecate' | 'update' | 'merge' | 'promote' | 'suggestion'

export interface MaintenanceAction {
  type: MaintenanceActionType
  recordId?: string
  snippet: string
  reason: string
  details?: Record<string, unknown>
}

export interface MaintenanceOperationInfo {
  key: string
  label: string
  description: string
  allowExecute: boolean
}

export interface MaintenanceOperationsResponse {
  operations: MaintenanceOperationInfo[]
}

export interface OperationResult {
  operation: string
  dryRun: boolean
  actions: MaintenanceAction[]
  summary: Record<string, number>
  duration: number
  error?: string
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

export function fetchStats(): Promise<StatsResponse> {
  return request('/stats')
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

export function searchMemories(params: {
  query: string
  limit?: number
  type?: RecordType
  project?: string
  deprecated?: boolean
}): Promise<SearchResponse> {
  const search = new URLSearchParams({ q: params.query })
  if (typeof params.limit === 'number') search.set('limit', String(params.limit))
  if (params.type) search.set('type', params.type)
  if (params.project) search.set('project', params.project)
  if (params.deprecated) search.set('deprecated', 'true')
  return request(`/search?${search.toString()}`)
}

export function previewContext(payload: { prompt: string; cwd?: string }): Promise<PreviewResponse> {
  return request('/preview', {
    method: 'POST',
    body: JSON.stringify(payload)
  })
}

export function fetchSessions(): Promise<SessionsResponse> {
  return request('/sessions')
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

export function fetchMaintenanceOperations(): Promise<MaintenanceOperationsResponse> {
  return request('/maintenance/operations')
}

export function runMaintenance(operation: string, dryRun: boolean): Promise<OperationResult> {
  return request('/maintenance/run', {
    method: 'POST',
    body: JSON.stringify({ operation, dryRun })
  })
}

export function runAllMaintenance(dryRun: boolean): Promise<OperationResult[]> {
  return request('/maintenance/run-all', {
    method: 'POST',
    body: JSON.stringify({ dryRun })
  })
}
