// Record type definitions for Claude Memory
// See PLAN.md for full schemas

import type { NearMissRecord, RecordType, ScoredRecord } from '../../shared/types.js'

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

export type {
  BaseRecord,
  CommandRecord,
  DiscoveryRecord,
  ErrorRecord,
  ExclusionReason,
  HybridSearchResult,
  InjectedMemoryEntry,
  InjectionPromptEntry,
  InjectionSessionRecord,
  InjectionStatus,
  MemoryRecord,
  MemoryStats,
  MemoryStatsSummary,
  NearMissRecord,
  ProcedureRecord,
  RecordScope,
  RecordType,
  RetrievalActivity,
  RetrievalActivityBucket,
  RetrievalActivityPeriod,
  RetrievalEvent,
  ScoredRecord,
  SearchResult,
  StatsSnapshot,
  WarningRecord,
  WarningSeverity
} from '../../shared/types.js'

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

export interface DiagnosticSearchResults {
  qualified: ScoredRecord[]
  nearMisses: NearMissRecord[]
}

export interface DiagnosticContextResult {
  context: string
  injectedRecords: ScoredRecord[]
  exclusions: NearMissRecord[]
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
    model: process.env.CC_EXTRACTION_MODEL ?? 'claude-sonnet-4-5-20250929',
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
