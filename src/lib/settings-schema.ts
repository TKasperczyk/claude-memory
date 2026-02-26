import type { MaintenanceSettings, ModelSettings, RetrievalSettings, Settings } from '../../shared/types.js'
import { SIMILARITY_THRESHOLDS } from './constants.js'

export type SettingKind = 'int' | 'float' | 'bool' | 'text'
export type SettingsSection = 'retrieval' | 'maintenance' | 'models'

export type SettingsGroupMeta = {
  id: string
  label: string
  description?: string
  section: SettingsSection
}

export type TextOption = { value: string; label: string }

export type SettingsFieldDefinition<K extends keyof Settings = keyof Settings> = {
  key: K
  label: string
  description: string
  step?: number
  min?: number
  max?: number
  kind: SettingKind
  default: Settings[K]
  group: SettingsGroupMeta
  options?: TextOption[]
}

export type SettingsGroupDefinition = SettingsGroupMeta & {
  fields: SettingsFieldDefinition[]
}

export type NumericSettingRule = { kind: 'int' | 'float'; min?: number; max?: number }
export type BooleanSettingRule = { kind: 'bool' }
export type TextSettingRule = { kind: 'text' }
export type SettingRule = NumericSettingRule | BooleanSettingRule | TextSettingRule

const RETRIEVAL_GROUPS = {
  similarity: {
    id: 'similarity',
    label: 'Similarity thresholds',
    description: 'Drop low-scoring matches before ranking.',
    section: 'retrieval'
  },
  context: {
    id: 'context',
    label: 'Context limits',
    description: 'Cap the injected context size.',
    section: 'retrieval'
  },
  ranking: {
    id: 'ranking',
    label: 'Ranking weights',
    description: 'Balance relevance, diversity, and usage boosts.',
    section: 'retrieval'
  },
  haiku: {
    id: 'haiku',
    label: 'Haiku query generation',
    description: 'Use Haiku to resolve context-dependent queries.',
    section: 'retrieval'
  },
  query: {
    id: 'query',
    label: 'Query limits',
    description: 'Limit keyword and semantic query construction.',
    section: 'retrieval'
  },
  timeouts: {
    id: 'timeouts',
    label: 'Timeouts',
    description: 'Abort slow pre-prompt steps.',
    section: 'retrieval'
  }
} as const satisfies Record<string, SettingsGroupMeta>

const MAINTENANCE_GROUPS_META = {
  staleAge: {
    id: 'stale-age',
    label: 'Stale & age',
    description: 'Invalidate outdated records and verify procedures.',
    section: 'maintenance'
  },
  lowUsage: {
    id: 'low-usage',
    label: 'Low usage deprecation',
    description: 'Deprecate memories that are rarely helpful.',
    section: 'maintenance'
  },
  consolidation: {
    id: 'consolidation',
    label: 'Consolidation',
    description: 'Merge near-duplicate memories into a single record.',
    section: 'maintenance'
  },
  conflictResolution: {
    id: 'conflict-resolution',
    label: 'Conflict resolution',
    description: 'Compare new memories against existing knowledge.',
    section: 'maintenance'
  },
  globalPromotion: {
    id: 'global-promotion',
    label: 'Global promotion',
    description: 'Promote project memories to global scope.',
    section: 'maintenance'
  },
  warningSynthesis: {
    id: 'warning-synthesis',
    label: 'Warning synthesis',
    description: 'Generate warnings from repeated failure patterns.',
    section: 'maintenance'
  },
  extraction: {
    id: 'extraction',
    label: 'Extraction',
    description: 'Control when and how memories are extracted from sessions.',
    section: 'maintenance'
  },
  similarityThresholds: {
    id: 'similarity-thresholds',
    label: 'Similarity thresholds',
    description: 'Tune matching sensitivity across the system.',
    section: 'maintenance'
  }
} as const satisfies Record<string, SettingsGroupMeta>

export const RETRIEVAL_FIELDS: SettingsFieldDefinition<keyof RetrievalSettings>[] = [
  {
    key: 'minSemanticSimilarity',
    label: 'Min semantic similarity',
    description: 'Drop semantic matches below this cosine similarity.',
    step: 0.01,
    min: 0,
    max: 1,
    kind: 'float',
    default: 0.70,
    group: RETRIEVAL_GROUPS.similarity
  },
  {
    key: 'minScore',
    label: 'Min hybrid score',
    description: 'Score threshold for all matches in hybrid retrieval (keyword and semantic). Only bypassed for keyword matches when embedding generation fails.',
    step: 0.01,
    min: 0,
    max: 1,
    kind: 'float',
    default: 0.45,
    group: RETRIEVAL_GROUPS.similarity
  },
  {
    key: 'minSemanticOnlyScore',
    label: 'Min semantic-only score',
    description: 'Score cutoff when only semantic search is used.',
    step: 0.01,
    min: 0,
    max: 1,
    kind: 'float',
    default: 0.65,
    group: RETRIEVAL_GROUPS.similarity
  },
  {
    key: 'maxRecords',
    label: 'Max records',
    description: 'Maximum memories injected per prompt.',
    step: 1,
    min: 1,
    max: 20,
    kind: 'int',
    default: 8,
    group: RETRIEVAL_GROUPS.context
  },
  {
    key: 'maxTokens',
    label: 'Max tokens',
    description: 'Token budget for the injected context block.',
    step: 50,
    min: 1,
    max: 10000,
    kind: 'int',
    default: 4000,
    group: RETRIEVAL_GROUPS.context
  },
  {
    key: 'mmrLambda',
    label: 'MMR lambda',
    description: 'Balance relevance vs. diversity (1.0 = relevance).',
    step: 0.01,
    min: 0,
    max: 1,
    kind: 'float',
    default: 0.7,
    group: RETRIEVAL_GROUPS.ranking
  },
  {
    key: 'usageRatioWeight',
    label: 'Usage ratio weight',
    description: 'Boost memories with high usefulness ratings.',
    step: 0.01,
    min: 0,
    max: 1,
    kind: 'float',
    default: 0.2,
    group: RETRIEVAL_GROUPS.ranking
  },
  {
    key: 'keywordBonus',
    label: 'Keyword match bonus',
    description: 'Flat score boost for results that match a keyword query. Keyword matches are re-scored using semantic similarity; this bonus is added on top.',
    step: 0.01,
    min: 0,
    max: 0.5,
    kind: 'float',
    default: 0.08,
    group: RETRIEVAL_GROUPS.ranking
  },
  {
    key: 'enableHaikuRetrieval',
    label: 'Enable Haiku retrieval',
    description: 'Use Haiku to analyze conversation context and generate better queries.',
    kind: 'bool',
    default: false,
    group: RETRIEVAL_GROUPS.haiku
  },
  {
    key: 'maxKeywordQueries',
    label: 'Max keyword queries',
    description: 'Maximum keyword queries generated per retrieval.',
    step: 1,
    min: 1,
    kind: 'int',
    default: 6,
    group: RETRIEVAL_GROUPS.query
  },
  {
    key: 'maxKeywordErrors',
    label: 'Max keyword errors',
    description: 'Max error patterns included as keyword queries.',
    step: 1,
    min: 1,
    kind: 'int',
    default: 3,
    group: RETRIEVAL_GROUPS.query
  },
  {
    key: 'maxKeywordCommands',
    label: 'Max keyword commands',
    description: 'Max commands included as keyword queries.',
    step: 1,
    min: 1,
    kind: 'int',
    default: 3,
    group: RETRIEVAL_GROUPS.query
  },
  {
    key: 'maxSemanticQueryChars',
    label: 'Max semantic query chars',
    description: 'Max characters allowed in the semantic query.',
    step: 50,
    min: 1,
    kind: 'int',
    default: 3000,
    group: RETRIEVAL_GROUPS.query
  },
  {
    key: 'prePromptTimeoutMs',
    label: 'Pre-prompt timeout (ms)',
    description: 'Timeout for the entire pre-prompt hook.',
    step: 100,
    min: 1,
    kind: 'int',
    default: 5000,
    group: RETRIEVAL_GROUPS.timeouts
  },
  {
    key: 'haikuQueryTimeoutMs',
    label: 'Haiku query timeout (ms)',
    description: 'Timeout for Haiku query generation.',
    step: 100,
    min: 1,
    kind: 'int',
    default: 2500,
    group: RETRIEVAL_GROUPS.timeouts
  }
]

export const MAINTENANCE_FIELDS: SettingsFieldDefinition<keyof MaintenanceSettings>[] = [
  {
    key: 'staleDays',
    label: 'Stale days',
    description: 'Records unused for this many days are considered stale.',
    step: 1,
    min: 1,
    kind: 'int',
    default: 90,
    group: MAINTENANCE_GROUPS_META.staleAge
  },
  {
    key: 'discoveryMaxAgeDays',
    label: 'Discovery max age (days)',
    description: 'Discoveries older than this are invalidated.',
    step: 1,
    min: 1,
    kind: 'int',
    default: 180,
    group: MAINTENANCE_GROUPS_META.staleAge
  },
  {
    key: 'procedureStepCheckCount',
    label: 'Procedure step checks',
    description: 'Number of steps sampled for command validation in procedures.',
    step: 1,
    min: 1,
    kind: 'int',
    default: 3,
    group: MAINTENANCE_GROUPS_META.staleAge
  },
  {
    key: 'extractionLogRetentionDays',
    label: 'Extraction log retention (days)',
    description: 'How long to keep extraction logs for review.',
    step: 1,
    min: 1,
    kind: 'int',
    default: 14,
    group: MAINTENANCE_GROUPS_META.staleAge
  },
  {
    key: 'maintenanceRunRetentionDays',
    label: 'Maintenance run retention (days)',
    description: 'How long to keep maintenance run logs.',
    step: 1,
    min: 1,
    kind: 'int',
    default: 30,
    group: MAINTENANCE_GROUPS_META.staleAge
  },
  {
    key: 'lowUsageMinRetrievals',
    label: 'Min retrievals for ratio',
    description: 'Min retrievals before evaluating usage ratio.',
    step: 1,
    min: 1,
    kind: 'int',
    default: 5,
    group: MAINTENANCE_GROUPS_META.lowUsage
  },
  {
    key: 'lowUsageRatioThreshold',
    label: 'Usage ratio threshold',
    description: 'Usage ratio below this triggers deprecation.',
    step: 0.01,
    min: 0,
    max: 1,
    kind: 'float',
    default: 0.1,
    group: MAINTENANCE_GROUPS_META.lowUsage
  },
  {
    key: 'lowUsageHighRetrievalMin',
    label: 'Zero-usage high retrievals',
    description: 'High retrieval threshold for zero-usage check.',
    step: 1,
    min: 1,
    kind: 'int',
    default: 5,
    group: MAINTENANCE_GROUPS_META.lowUsage
  },
  {
    key: 'staleUnusedDays',
    label: 'Stale unused days',
    description: 'Deprecate memories older than this with zero usage.',
    step: 1,
    min: 1,
    kind: 'int',
    default: 30,
    group: MAINTENANCE_GROUPS_META.lowUsage
  },
  {
    key: 'consolidationSearchLimit',
    label: 'Search limit',
    description: 'Max similar records to fetch per seed.',
    step: 1,
    min: 1,
    kind: 'int',
    default: 12,
    group: MAINTENANCE_GROUPS_META.consolidation
  },
  {
    key: 'consolidationMaxClusterSize',
    label: 'Max cluster size',
    description: 'Max records allowed in a single cluster.',
    step: 1,
    min: 1,
    kind: 'int',
    default: 8,
    group: MAINTENANCE_GROUPS_META.consolidation
  },
  {
    key: 'consolidationThreshold',
    label: 'Consolidation threshold',
    description: 'Similarity threshold for merging (0-1).',
    step: 0.01,
    min: 0,
    max: 1,
    kind: 'float',
    default: SIMILARITY_THRESHOLDS.CONSOLIDATION,
    group: MAINTENANCE_GROUPS_META.consolidation
  },
  {
    key: 'consolidationRecheckDays',
    label: 'Recheck cadence (days)',
    description: 'Days before re-evaluating a consolidation cluster.',
    step: 1,
    min: 1,
    kind: 'int',
    default: 7,
    group: MAINTENANCE_GROUPS_META.consolidation
  },
  {
    key: 'crossTypeConsolidationThreshold',
    label: 'Cross-type consolidation threshold',
    description: 'Higher similarity threshold for cross-type merges (0-1).',
    step: 0.01,
    min: 0.6,
    max: 1,
    kind: 'float',
    default: 0.80,
    group: MAINTENANCE_GROUPS_META.consolidation
  },
  {
    key: 'enableConsolidationLlmVerification',
    label: 'LLM consolidation verification',
    description: 'Use LLM to verify clusters are true duplicates before merging.',
    kind: 'bool',
    default: true,
    group: MAINTENANCE_GROUPS_META.consolidation
  },
  {
    key: 'consolidationTextSimilarityRatio',
    label: 'Contradiction text similarity ratio',
    description: 'Levenshtein ratio used to skip near-duplicate text during contradiction detection.',
    step: 0.01,
    min: 0,
    max: 1,
    kind: 'float',
    default: 0.2,
    group: MAINTENANCE_GROUPS_META.consolidation
  },
  {
    key: 'conflictSimilarityThreshold',
    label: 'Conflict similarity threshold',
    description: 'Similarity to trigger conflict check.',
    step: 0.01,
    min: 0,
    max: 1,
    kind: 'float',
    default: 0.85,
    group: MAINTENANCE_GROUPS_META.conflictResolution
  },
  {
    key: 'conflictCheckBatchSize',
    label: 'Conflict batch size',
    description: 'Pairs processed per batch.',
    step: 1,
    min: 1,
    kind: 'int',
    default: 10,
    group: MAINTENANCE_GROUPS_META.conflictResolution
  },
  {
    key: 'contradictionSimilarityThreshold',
    label: 'Contradiction similarity threshold (legacy)',
    description: 'Similarity threshold for legacy contradiction checks.',
    step: 0.01,
    min: 0,
    max: 1,
    kind: 'float',
    default: 0.75,
    group: MAINTENANCE_GROUPS_META.conflictResolution
  },
  {
    key: 'contradictionSearchLimit',
    label: 'Contradiction search limit (legacy)',
    description: 'Max similar records to fetch per seed in contradiction checks.',
    step: 1,
    min: 1,
    kind: 'int',
    default: 8,
    group: MAINTENANCE_GROUPS_META.conflictResolution
  },
  {
    key: 'contradictionBatchSize',
    label: 'Contradiction batch size (legacy)',
    description: 'Pairs processed per contradiction batch.',
    step: 1,
    min: 1,
    kind: 'int',
    default: 15,
    group: MAINTENANCE_GROUPS_META.conflictResolution
  },
  {
    key: 'globalPromotionBatchSize',
    label: 'Promotion batch size',
    description: 'Candidates checked per maintenance run.',
    step: 1,
    min: 1,
    kind: 'int',
    default: 20,
    group: MAINTENANCE_GROUPS_META.globalPromotion
  },
  {
    key: 'globalPromotionRecheckDays',
    label: 'Recheck cadence (days)',
    description: 'Days before re-evaluating a candidate.',
    step: 1,
    min: 1,
    kind: 'int',
    default: 30,
    group: MAINTENANCE_GROUPS_META.globalPromotion
  },
  {
    key: 'globalPromotionMinSuccessCount',
    label: 'Min success count',
    description: 'Min successes required for eligibility.',
    step: 1,
    min: 1,
    kind: 'int',
    default: 2,
    group: MAINTENANCE_GROUPS_META.globalPromotion
  },
  {
    key: 'globalPromotionMinUsageRatio',
    label: 'Min usage ratio',
    description: 'Min usage ratio (e.g., 0.3 = 30%).',
    step: 0.01,
    min: 0,
    max: 1,
    kind: 'float',
    default: 0.3,
    group: MAINTENANCE_GROUPS_META.globalPromotion
  },
  {
    key: 'globalPromotionMinRetrievalsForUsageRatio',
    label: 'Min retrievals for ratio',
    description: 'Retrieval count before usage ratio is enforced.',
    step: 1,
    min: 1,
    kind: 'int',
    default: 3,
    group: MAINTENANCE_GROUPS_META.globalPromotion
  },
  {
    key: 'warningClusterSimilarityThreshold',
    label: 'Warning similarity threshold',
    description: 'Similarity cutoff for grouping failures.',
    step: 0.01,
    min: 0,
    max: 1,
    kind: 'float',
    default: 0.8,
    group: MAINTENANCE_GROUPS_META.warningSynthesis
  },
  {
    key: 'warningClusterLimit',
    label: 'Warning cluster limit',
    description: 'Max similar records per warning group.',
    step: 1,
    min: 1,
    kind: 'int',
    default: 5,
    group: MAINTENANCE_GROUPS_META.warningSynthesis
  },
  {
    key: 'warningSynthesisMinFailures',
    label: 'Min failures',
    description: 'Min failures before synthesizing warning.',
    step: 1,
    min: 1,
    kind: 'int',
    default: 2,
    group: MAINTENANCE_GROUPS_META.warningSynthesis
  },
  {
    key: 'warningSynthesisBatchSize',
    label: 'Warning batch size',
    description: 'Failure groups processed per batch.',
    step: 1,
    min: 1,
    kind: 'int',
    default: 10,
    group: MAINTENANCE_GROUPS_META.warningSynthesis
  },
  {
    key: 'warningSynthesisRecheckDays',
    label: 'Recheck cadence (days)',
    description: 'Days before re-evaluating warning synthesis candidates.',
    step: 1,
    min: 1,
    kind: 'int',
    default: 30,
    group: MAINTENANCE_GROUPS_META.warningSynthesis
  },
  {
    key: 'extractionMinTokens',
    label: 'Min conversation tokens',
    description: 'Skip extraction for conversations shorter than this (estimated tokens).',
    step: 10,
    min: 0,
    max: 1000,
    kind: 'int',
    default: 100,
    group: MAINTENANCE_GROUPS_META.extraction
  },
  {
    key: 'extractionDedupThreshold',
    label: 'Extraction dedup threshold',
    description: 'Similarity for dedup during extraction.',
    step: 0.01,
    min: 0,
    max: 1,
    kind: 'float',
    default: SIMILARITY_THRESHOLDS.EXTRACTION_DEDUP,
    group: MAINTENANCE_GROUPS_META.similarityThresholds
  },
  {
    key: 'reviewSimilarThreshold',
    label: 'Review similar threshold',
    description: 'Threshold for finding similar in review.',
    step: 0.01,
    min: 0,
    max: 1,
    kind: 'float',
    default: SIMILARITY_THRESHOLDS.REVIEW_SIMILAR,
    group: MAINTENANCE_GROUPS_META.similarityThresholds
  },
  {
    key: 'reviewDuplicateWarningThreshold',
    label: 'Review duplicate threshold',
    description: 'Flag as potential duplicate above this.',
    step: 0.01,
    min: 0,
    max: 1,
    kind: 'float',
    default: SIMILARITY_THRESHOLDS.REVIEW_DUPLICATE_WARNING,
    group: MAINTENANCE_GROUPS_META.similarityThresholds
  }
]

const MAINTENANCE_GROUP_ORDER = [
  MAINTENANCE_GROUPS_META.extraction,
  MAINTENANCE_GROUPS_META.staleAge,
  MAINTENANCE_GROUPS_META.lowUsage,
  MAINTENANCE_GROUPS_META.consolidation,
  MAINTENANCE_GROUPS_META.conflictResolution,
  MAINTENANCE_GROUPS_META.globalPromotion,
  MAINTENANCE_GROUPS_META.warningSynthesis,
  MAINTENANCE_GROUPS_META.similarityThresholds
] as const

export const MAINTENANCE_GROUPS: SettingsGroupDefinition[] = MAINTENANCE_GROUP_ORDER.map(group => ({
  ...group,
  fields: MAINTENANCE_FIELDS.filter(field => field.group === group)
}))

const MODEL_GROUPS_META = {
  models: {
    id: 'models',
    label: '',
    section: 'models'
  }
} as const satisfies Record<string, SettingsGroupMeta>

export const MODEL_OPTIONS: TextOption[] = [
  { value: 'claude-sonnet-4-5-20250929', label: 'Sonnet 4.5' },
  { value: 'claude-opus-4-5-20251101', label: 'Opus 4.5' },
  { value: 'claude-opus-4-6', label: 'Opus 4.6' },
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' }
]

export const MODEL_FIELDS: SettingsFieldDefinition<keyof ModelSettings>[] = [
  {
    key: 'extractionModel',
    label: 'Extraction model',
    description: 'Model used for extraction, query generation, and maintenance operations.',
    kind: 'text',
    default: 'claude-sonnet-4-5-20250929',
    group: MODEL_GROUPS_META.models,
    options: MODEL_OPTIONS
  },
  {
    key: 'reviewModel',
    label: 'Review model',
    description: 'Model used for injection, extraction, and maintenance reviews.',
    kind: 'text',
    default: 'claude-opus-4-5-20251101',
    group: MODEL_GROUPS_META.models,
    options: MODEL_OPTIONS
  },
  {
    key: 'chatModel',
    label: 'Chat model',
    description: 'Model used for the dashboard chat assistant.',
    kind: 'text',
    default: 'claude-opus-4-5-20251101',
    group: MODEL_GROUPS_META.models,
    options: MODEL_OPTIONS
  }
]

export const DEFAULT_MODEL_SETTINGS = MODEL_FIELDS.reduce<Record<string, string>>(
  (acc, field) => {
    acc[field.key] = field.default
    return acc
  },
  {}
) as unknown as ModelSettings

export const ALL_SETTINGS_FIELDS = [...RETRIEVAL_FIELDS, ...MAINTENANCE_FIELDS, ...MODEL_FIELDS] as const

export const DEFAULT_RETRIEVAL_SETTINGS = RETRIEVAL_FIELDS.reduce<Record<string, number | boolean>>(
  (acc, field) => {
    acc[field.key] = field.default
    return acc
  },
  {}
) as unknown as RetrievalSettings

export const DEFAULT_MAINTENANCE_SETTINGS = MAINTENANCE_FIELDS.reduce<Record<string, number | boolean>>(
  (acc, field) => {
    acc[field.key] = field.default
    return acc
  },
  {}
) as unknown as MaintenanceSettings

export const DEFAULT_SETTINGS: Settings = {
  ...DEFAULT_RETRIEVAL_SETTINGS,
  ...DEFAULT_MAINTENANCE_SETTINGS,
  ...DEFAULT_MODEL_SETTINGS
}

export const SETTING_RULES = ALL_SETTINGS_FIELDS.reduce((acc, field) => {
  if (field.kind === 'bool') {
    acc[field.key] = { kind: 'bool' }
  } else if (field.kind === 'text') {
    acc[field.key] = { kind: 'text' }
  } else {
    acc[field.key] = { kind: field.kind, min: field.min, max: field.max }
  }
  return acc
}, {} as Record<keyof Settings, SettingRule>)
