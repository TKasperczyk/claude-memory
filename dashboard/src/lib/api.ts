export type RecordType = 'command' | 'error' | 'discovery' | 'procedure' | 'warning'

export interface RetrievalSettings {
  minSemanticSimilarity: number
  minScore: number
  minSemanticOnlyScore: number
  maxRecords: number
  maxTokens: number
  mmrLambda: number
  usageRatioWeight: number
}

export interface MaintenanceSettings {
  staleDays: number
  discoveryMaxAgeDays: number
  lowUsageMinRetrievals: number
  lowUsageRatioThreshold: number
  lowUsageHighRetrievalMin: number
  consolidationSearchLimit: number
  consolidationMaxClusterSize: number
  consolidationThreshold: number
  consolidationTextSimilarityRatio: number
  conflictSimilarityThreshold: number
  conflictCheckBatchSize: number
  contradictionSimilarityThreshold: number
  contradictionSearchLimit: number
  contradictionBatchSize: number
  globalPromotionBatchSize: number
  globalPromotionRecheckDays: number
  globalPromotionMinSuccessCount: number
  globalPromotionMinUsageRatio: number
  globalPromotionMinRetrievalsForUsageRatio: number
  warningClusterSimilarityThreshold: number
  warningClusterLimit: number
  warningSynthesisMinFailures: number
  warningSynthesisBatchSize: number
  procedureStepCheckCount: number
  extractionDedupThreshold: number
  reviewSimilarThreshold: number
  reviewDuplicateWarningThreshold: number
}

export type Settings = RetrievalSettings & MaintenanceSettings

export interface SettingsDefaultsResponse {
  settings: Settings
  maintenance: MaintenanceSettings
}

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

export type WarningSeverity = 'caution' | 'warning' | 'critical'

export interface WarningRecord extends BaseRecord {
  type: 'warning'
  avoid: string
  useInstead: string
  reason: string
  severity: WarningSeverity
  sourceRecordIds?: string[]
  synthesizedAt?: number
}

export type MemoryRecord = CommandRecord | ErrorRecord | DiscoveryRecord | ProcedureRecord | WarningRecord

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

export interface ActionResponse {
  success: boolean
}

export type HookEvent = 'UserPromptSubmit' | 'SessionEnd' | 'PreCompact'

export interface HookStatusEntry {
  installed: boolean
  configured: string | null
  expected: string
}

export interface HookStatusResponse {
  hooks: Record<HookEvent, HookStatusEntry>
}

export interface HookInstallResponse {
  success: boolean
  hooks: Record<HookEvent, HookStatusEntry>
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
  context: string | null
  timedOut?: boolean
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

export type InjectionStatus = 'injected' | 'no_matches' | 'empty_prompt' | 'timeout' | 'error'

export interface SessionPromptEntry {
  text: string
  timestamp: number
  status: InjectionStatus
  memoryCount: number
}

export interface SessionRecord {
  sessionId: string
  createdAt: number
  lastActivity: number
  cwd?: string
  memories: InjectedMemoryEntry[]
  prompts?: SessionPromptEntry[]
  promptCount?: number
  injectionCount?: number
  lastStatus?: InjectionStatus
}

export interface SessionsResponse {
  sessions: SessionRecord[]
  count: number
}

export interface MemoryTypesResponse {
  types: RecordType[]
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
  type: 'inaccurate' | 'partial' | 'hallucinated' | 'missed' | 'duplicate'
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

export interface InjectedMemoryVerdict {
  id: string
  snippet: string
  verdict: 'relevant' | 'partially_relevant' | 'irrelevant' | 'unknown'
  reason: string
}

export interface MissedMemory {
  id: string
  snippet: string
  reason: string
}

export interface InjectionReview {
  sessionId: string
  prompt: string
  reviewedAt: number
  overallRelevance: 'excellent' | 'good' | 'mixed' | 'poor'
  relevanceScore: number
  injectedVerdicts: InjectedMemoryVerdict[]
  missedMemories: MissedMemory[]
  summary: string
  model: string
  durationMs: number
}

export type MaintenanceActionType = 'deprecate' | 'update' | 'merge' | 'promote' | 'suggestion'
export type ConflictVerdict = 'supersedes' | 'variant' | 'hallucination'

export interface MaintenanceMergeRecord {
  id: string
  snippet: string | null
}

export interface MaintenanceActionDetails {
  keptId?: string
  deprecatedIds?: string[]
  deprecatedRecords?: MaintenanceMergeRecord[]
  before?: string
  after?: string
  newerId?: string
  verdict?: ConflictVerdict
  candidateId?: string
  existingId?: string
  similarity?: number
  action?: 'new' | 'edit'
  targetFile?: string
  diff?: string
  decisionReason?: string
  [key: string]: unknown
}

export interface MaintenanceAction {
  type: MaintenanceActionType
  recordId?: string
  snippet: string
  reason: string
  details?: MaintenanceActionDetails
}

export interface MaintenanceCandidateRecord {
  id: string
  type: RecordType
  snippet: string
  reason: string
  details?: Record<string, number | string | boolean>
}

export interface MaintenanceCandidateGroup {
  id: string
  label: string
  reason?: string
  records: MaintenanceCandidateRecord[]
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
  candidates: MaintenanceCandidateGroup[]
  duration: number
  error?: string
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

export function fetchSettings(): Promise<Settings> {
  return request('/settings')
}

export function fetchSettingsDefaults(): Promise<SettingsDefaultsResponse> {
  return request('/settings/defaults')
}

export function updateSettings(settings: Partial<Settings>): Promise<Settings> {
  return request('/settings', {
    method: 'PUT',
    body: JSON.stringify(settings)
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

export function previewContext(payload: { prompt: string; cwd?: string }): Promise<PreviewResponse> {
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
