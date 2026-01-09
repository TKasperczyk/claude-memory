// Record type definitions for Claude Memory
// See PLAN.md for full schemas

export const EMBEDDING_DIM = 4096

// Similarity thresholds - defaults that can be overridden via settings.
export const SIMILARITY_THRESHOLDS = {
  /** Threshold for deduplication during extraction (insert vs update). */
  EXTRACTION_DEDUP: 0.85,
  /** Threshold for consolidation/merge in maintenance. */
  CONSOLIDATION: 0.85,
  /** Threshold for finding similar memories in review (broader search). */
  REVIEW_SIMILAR: 0.5,
  /** Threshold to flag as potential duplicate in review. */
  REVIEW_DUPLICATE_WARNING: 0.8
} as const

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
  domain?: string
  successCount?: number
  failureCount?: number
  retrievalCount?: number
  usageCount?: number
  lastUsed?: number
  deprecated?: boolean
  generalized?: boolean
  lastGeneralizationCheck?: number
  lastGlobalCheck?: number
  lastConflictCheck?: number
  embedding?: number[]
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
  avoid: string              // What NOT to do
  useInstead: string         // The alternative
  reason: string             // Why it fails
  severity: WarningSeverity
  sourceRecordIds?: string[] // Original failures (if synthesized)
  synthesizedAt?: number     // When created
}

export type MemoryRecord = CommandRecord | ErrorRecord | DiscoveryRecord | ProcedureRecord | WarningRecord

export interface InjectedMemoryEntry {
  id: string
  snippet: string
  type?: RecordType
  injectedAt: number
  prompt?: string
  // Retrieval trigger info
  similarity?: number    // Semantic similarity score (0-1)
  keywordMatch?: boolean // Whether it was found via keyword search
  score?: number         // Combined relevance score
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
  prompts?: InjectionPromptEntry[]
  // Track injection attempts, not just successes
  promptCount?: number        // Total prompts in this session
  injectionCount?: number     // Prompts that got memories injected
  lastStatus?: InjectionStatus // Status of last injection attempt
}

export interface HybridSearchParamsBase {
  query: string
  limit?: number
  project?: string
  domain?: string
  type?: RecordType
  excludeDeprecated?: boolean
  embedding?: number[]
  vectorWeight?: number
  keywordWeight?: number
  minSimilarity?: number
  minScore?: number
  usageRatioWeight?: number
  vectorLimit?: number
  keywordLimit?: number
  includeEmbeddings?: boolean
  signal?: AbortSignal
}

export type HybridSearchParamsWithDiagnostic = HybridSearchParamsBase & {
  diagnostic: true
}

export type HybridSearchParamsWithoutDiagnostic = HybridSearchParamsBase & {
  diagnostic?: false | undefined
}

export type HybridSearchParams =
  | HybridSearchParamsWithDiagnostic
  | HybridSearchParamsWithoutDiagnostic

export interface HybridSearchResult {
  record: MemoryRecord
  score: number
  similarity: number
  keywordMatch: boolean
}

export type ScoredRecord = HybridSearchResult

export interface ExclusionReason {
  reason: 'score_below_threshold' | 'similarity_below_threshold' | 'semantic_only_score_below_threshold'
  threshold: number
  actual: number
  gap: number
}

export interface NearMissRecord {
  record: ScoredRecord
  exclusionReasons: ExclusionReason[]
}

export interface DiagnosticSearchResults {
  qualified: ScoredRecord[]
  nearMisses: NearMissRecord[]
}

// Hook input types (from Claude Code)
export interface HookInput {
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode: string
  hook_event_name: string
}

export interface UserPromptSubmitInput extends HookInput {
  hook_event_name: 'UserPromptSubmit'
  prompt: string
}

export type PrePromptInput = Omit<UserPromptSubmitInput, 'transcript_path' | 'permission_mode'> & {
  transcript_path?: string
  permission_mode?: string
}

export interface SessionEndInput extends HookInput {
  hook_event_name: 'SessionEnd'
  reason: 'clear' | 'logout' | 'prompt_input_exit' | 'other'
}

export interface PreCompactInput extends HookInput {
  hook_event_name: 'PreCompact'
  trigger: 'manual' | 'auto'
}

/** Input for extraction hooks - either SessionEnd or PreCompact */
export type ExtractionHookInput = SessionEndInput | PreCompactInput

// Configuration
export interface Config {
  milvus: {
    address: string
    collection: string
  }
  embeddings: {
    baseUrl: string
    model: string
  }
  extraction: {
    model: string
    maxTokens: number
  }
  injection: {
    maxRecords: number
    maxTokens: number
  }
}

export const DEFAULT_CONFIG: Config = {
  milvus: {
    address: process.env.CC_MEMORIES_ADDRESS ?? 'localhost:19530',
    collection: process.env.CC_MEMORIES_COLLECTION ?? 'cc_memories'
  },
  embeddings: {
    baseUrl: process.env.CC_EMBEDDINGS_URL ?? 'http://127.0.0.1:1234/v1',
    model: process.env.CC_EMBEDDINGS_MODEL ?? 'text-embedding-qwen3-embedding-8b'
  },
  extraction: {
    model: process.env.CC_EXTRACTION_MODEL ?? 'claude-haiku-4-5-20251001',
    maxTokens: 4000
  },
  injection: {
    maxRecords: 5,
    maxTokens: 2000
  }
}

/**
 * Create a config with optional overrides, respecting environment variables.
 */
export function createConfig(overrides: Partial<Config> = {}): Config {
  return {
    milvus: { ...DEFAULT_CONFIG.milvus, ...overrides.milvus },
    embeddings: { ...DEFAULT_CONFIG.embeddings, ...overrides.embeddings },
    extraction: { ...DEFAULT_CONFIG.extraction, ...overrides.extraction },
    injection: { ...DEFAULT_CONFIG.injection, ...overrides.injection }
  }
}
