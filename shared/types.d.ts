export type RecordType = 'command' | 'error' | 'discovery' | 'procedure' | 'warning'
export type RecordScope = 'global' | 'project'

export interface BaseRecord {
  id: string
  type: RecordType
  scope?: RecordScope
  timestamp?: number
  sourceSessionId?: string
  sourceExcerpt?: string
  project?: string
  successCount?: number
  failureCount?: number
  retrievalCount?: number
  usageCount?: number
  lastUsed?: number
  deprecated?: boolean
  generalized?: boolean
  lastGeneralizationCheck?: number
  lastGlobalCheck?: number
  lastConsolidationCheck?: number
  lastConflictCheck?: number
  lastWarningSynthesisCheck?: number
  embedding?: number[]
  /** UUID of a prior memory that this record supersedes/invalidates */
  supersedes?: string
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

export interface MemoryStats {
  id: string
  retrievalCount: number
  usageCount: number
  successCount: number
  failureCount: number
}

export interface MemoryStatsSummary {
  total: number
  byType: Record<string, number>
  byProject: Record<string, number>
  byScope: Record<string, number>
  avgRetrievalCount: number
  avgUsageCount: number
  avgUsageRatio: number
  deprecated: number
}

export interface StatsSnapshot extends MemoryStatsSummary {
  timestamp: number
}

export interface RetrievalEvent {
  id: string
  type?: RecordType
  timestamp: number
}

export type RetrievalActivityPeriod = 'day' | 'week'

export interface RetrievalActivityBucket {
  start: number
  end: number
  count: number
}

export interface RetrievalActivity {
  period: RetrievalActivityPeriod
  buckets: RetrievalActivityBucket[]
}

export type TokenUsageSource = 'extraction' | 'haiku-query' | 'usefulness-rating'

export interface TokenUsageEvent {
  timestamp: number
  source: TokenUsageSource
  model: string
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
}

export interface TokenUsageBucket {
  start: number
  end: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
}

export interface TokenUsageActivity {
  period: RetrievalActivityPeriod
  source: TokenUsageSource | 'all'
  buckets: TokenUsageBucket[]
}

export interface InjectedMemoryEntry {
  id: string
  snippet: string
  type?: RecordType
  injectedAt: number
  prompt?: string
  stats?: MemoryStats | null
  similarity?: number
  keywordMatch?: boolean
  score?: number
}

export type InjectionStatus = 'injected' | 'no_matches' | 'empty_prompt' | 'timeout' | 'error'

export interface InjectionPromptEntry {
  text: string
  timestamp: number
  status: InjectionStatus
  memoryCount: number
}

export interface InjectionSessionRecord {
  sessionId: string
  createdAt: number
  lastActivity: number
  cwd?: string
  memories: InjectedMemoryEntry[]
  memoriesRaw?: InjectedMemoryEntry[]
  prompts?: InjectionPromptEntry[]
  promptCount?: number
  injectionCount?: number
  lastStatus?: InjectionStatus
  hasReview?: boolean
}

export interface SearchResult {
  record: MemoryRecord
  score: number
  similarity: number
  keywordMatch: boolean
}

export type HybridSearchResult = SearchResult
export type ScoredRecord = SearchResult

export interface ExclusionReason {
  reason: 'score_below_threshold' | 'similarity_below_threshold' | 'semantic_only_score_below_threshold'
    | 'mmr_diversity_penalty' | 'exceeded_max_records' | 'exceeded_token_budget'
  threshold: number
  actual: number
  gap: number
  similarTo?: string
  similarityScore?: number
  rank?: number
  projectedTokens?: number
}

export interface NearMissRecord {
  record: ScoredRecord
  exclusionReasons: ExclusionReason[]
}

export interface RetrievalSettings {
  minSemanticSimilarity: number
  minScore: number
  minSemanticOnlyScore: number
  maxRecords: number
  maxTokens: number
  mmrLambda: number
  usageRatioWeight: number
  keywordBonus: number
  enableHaikuRetrieval: boolean
  maxKeywordQueries: number
  maxKeywordErrors: number
  maxKeywordCommands: number
  prePromptTimeoutMs: number
  haikuQueryTimeoutMs: number
  maxSemanticQueryChars: number
  projectMatchBonus: number
}

export interface MaintenanceSettings {
  staleDays: number
  discoveryMaxAgeDays: number
  lowUsageMinRetrievals: number
  lowUsageRatioThreshold: number
  lowUsageHighRetrievalMin: number
  staleUnusedDays: number
  consolidationSearchLimit: number
  consolidationMaxClusterSize: number
  consolidationThreshold: number
  consolidationRecheckDays: number
  crossTypeConsolidationThreshold: number
  enableConsolidationLlmVerification: boolean
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
  warningSynthesisRecheckDays: number
  procedureStepCheckCount: number
  extractionMinTokens: number
  maxTranscriptChars: number
  extractionDedupThreshold: number
  reviewSimilarThreshold: number
  reviewDuplicateWarningThreshold: number
  extractionLogRetentionDays: number
  maintenanceRunRetentionDays: number
  autoMaintenanceIntervalHours: number
  extractionContextOverlapTurns: number
}

export interface ModelSettings {
  extractionModel: string
  reviewModel: string
  chatModel: string
}

export type Settings = RetrievalSettings & MaintenanceSettings & ModelSettings

export interface ExtractionRecordSummary {
  id: string
  type: RecordType
  summary: string
  timestamp?: number
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
}

export interface ExtractionRun {
  runId: string
  sessionId: string
  transcriptPath: string
  timestamp: number
  recordCount: number
  parseErrorCount: number
  extractedRecordIds: string[]
  updatedRecordIds?: string[]
  extractedRecords?: ExtractionRecordSummary[]
  duration: number
  firstPrompt?: string
  tokenUsage?: TokenUsage
  extractedEventCount?: number
  isIncremental?: boolean
  hasRememberMarker?: boolean
  skipReason?: 'too_short' | 'no_records'
}

export interface ExtractionReviewIssue {
  recordId?: string
  type: 'inaccurate' | 'partial' | 'hallucinated' | 'missed' | 'duplicate'
  severity: 'critical' | 'major' | 'minor'
  description: string
  evidence: string
  suggestedFix?: string
}

export type ReviewRating = 'good' | 'mixed' | 'poor'

export interface ExtractionReview {
  runId: string
  reviewedAt: number
  overallRating: ReviewRating
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
  overallRating: ReviewRating
  relevanceScore: number
  injectedVerdicts: InjectedMemoryVerdict[]
  missedMemories: MissedMemory[]
  summary: string
  model: string
  durationMs: number
}

// Maintenance review types
export type MaintenanceAssessment = ReviewRating
export type MaintenanceActionVerdict = 'correct' | 'questionable' | 'incorrect'
export type SettingsRecommendation = 'too_aggressive' | 'too_lenient' | 'appropriate'

export interface MaintenanceActionReviewItem {
  recordId?: string
  action: MaintenanceActionType
  snippet: string
  verdict: MaintenanceActionVerdict
  reason: string
}

export interface MaintenanceSettingsRecommendation {
  setting: string
  currentValue: string | number
  recommendation: SettingsRecommendation
  suggestedValue?: string | number
  reason: string
}

export interface MaintenanceReview {
  resultId: string
  operation: string
  dryRun: boolean
  reviewedAt: number
  overallRating: ReviewRating
  assessmentScore: number
  actionVerdicts: MaintenanceActionReviewItem[]
  settingsRecommendations: MaintenanceSettingsRecommendation[]
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

export interface MaintenanceProgress {
  current: number
  total: number
  message?: string
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

export type MaintenanceTrigger = 'cli' | 'dashboard' | 'auto'

export interface MaintenanceRunSummary {
  totalActions: number
  totalDeprecated: number
  totalUpdated: number
  totalMerged: number
  totalPromoted: number
  totalSuggestions: number
  operationsRun: number
  operationsFailed: number
}

export interface MaintenanceRun {
  runId: string
  timestamp: number
  dryRun: boolean
  trigger: MaintenanceTrigger
  operations: string[]
  results: OperationResult[]
  summary: MaintenanceRunSummary
  duration: number
  hasErrors: boolean
}

export type HookEvent = 'UserPromptSubmit' | 'SessionEnd' | 'PreCompact'

export interface HookStatus {
  installed: boolean
  configured: string | null
  expected: string
}

export interface CommandStatus {
  installed: boolean
  modified: boolean
  path: string
}

export interface McpStatus {
  installed: boolean
  configured: string | null
  expected: string
}

export interface InstallationStatus {
  hooks: Record<HookEvent, HookStatus>
  commands: Record<string, CommandStatus>
  mcp: McpStatus
}
