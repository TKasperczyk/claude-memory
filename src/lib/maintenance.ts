import Anthropic from '@anthropic-ai/sdk'
import { execFileSync } from 'child_process'
import fs from 'fs'
import { homedir } from 'os'
import path from 'path'
import {
  DEFAULT_CONFIG,
  EMBEDDING_DIM,
  SIMILARITY_THRESHOLDS,
  type CommandRecord,
  type Config,
  type DiscoveryRecord,
  type ErrorRecord,
  type MemoryRecord,
  type ProcedureRecord,
  type RecordType,
  type WarningRecord,
  type WarningSeverity
} from './types.js'
import { CLAUDE_CODE_SYSTEM_PROMPT, createAnthropicClient } from './anthropic.js'
import { buildFilter, findSimilar, queryRecords, updateRecord, vectorSearchSimilar } from './milvus.js'
import { isPlainObject, isToolUseBlock, type ToolUseBlock } from './parsing.js'
import {
  buildCandidateRecord,
  buildExactText,
  buildRecordSnippet,
  normalizeExactText,
  normalizeStep,
  truncateSnippet
} from './shared.js'

const STALE_DAYS = 90
const DISCOVERY_MAX_AGE_DAYS = 180
const QUERY_PAGE_SIZE = 500
const PROCEDURE_STEP_CHECK_COUNT = 3
const CONSOLIDATION_SEARCH_LIMIT = 12
const CONSOLIDATION_MAX_CLUSTER_SIZE = 8
const TEXT_SIMILARITY_RATIO = 0.2
const LOW_USAGE_MIN_RETRIEVALS = 5
const LOW_USAGE_RATIO_THRESHOLD = 0.1
const LOW_USAGE_HIGH_RETRIEVAL_MIN = 10
const CONTRADICTION_SIMILARITY_THRESHOLD = 0.75
const CONTRADICTION_SEARCH_LIMIT = 8
const GENERALIZATION_MAX_TOKENS = 800
export const CONTRADICTION_BATCH_SIZE = 15
const CONTRADICTION_MAX_TOKENS = 600
const CONFLICT_SIMILARITY_THRESHOLD = 0.85
export const CONFLICT_CHECK_BATCH_SIZE = 10
const CONFLICT_ADJUDICATION_MAX_TOKENS = 600
const CONFLICT_ADJUDICATION_MODEL = 'claude-haiku-4-5-20251001'
const CONFLICT_ADJUDICATION_TOOL_NAME = 'emit_conflict_verdict'
export const GLOBAL_PROMOTION_BATCH_SIZE = 20
const GLOBAL_PROMOTION_MAX_TOKENS = 400
export const GLOBAL_PROMOTION_MIN_CONFIDENCE = 'medium'
export const GLOBAL_PROMOTION_RECHECK_DAYS = 30
const GLOBAL_PROMOTION_MIN_SUCCESS_COUNT = 2
const GLOBAL_PROMOTION_MIN_USAGE_RATIO = 0.3
const GLOBAL_PROMOTION_MIN_RETRIEVALS_FOR_USAGE_RATIO = 3
const GLOBAL_TOOL_KEYWORDS = [
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'npx',
  'node',
  'nodejs',
  'deno',
  'python',
  'python3',
  'pip',
  'pip3',
  'pipx',
  'uv',
  'poetry',
  'cargo',
  'rustc',
  'git',
  'docker',
  'docker-compose',
  'kubectl',
  'helm',
  'terraform',
  'ansible',
  'dotnet',
  'mvn',
  'gradle',
  'javac',
  'java'
]
const GLOBAL_COMMAND_TOOLS = new Set(GLOBAL_TOOL_KEYWORDS)
const GLOBAL_DISCOVERY_KEYWORDS = [
  'javascript',
  'typescript',
  'node',
  'nodejs',
  'python',
  'rust',
  'golang',
  'java',
  'kotlin',
  'c#',
  'c++',
  'ruby',
  'php',
  'swift',
  'scala',
  'elixir',
  'erlang',
  'bash',
  'shell',
  'zsh',
  'sql',
  'postgres',
  'postgresql',
  'mysql',
  'sqlite',
  'react',
  'vue',
  'angular',
  'svelte',
  'next.js',
  'nuxt',
  'express',
  'fastify',
  'django',
  'flask',
  'rails',
  'laravel',
  'spring',
  'grpc',
  'graphql'
]
const GENERIC_COMMAND_FLAGS = new Set(['--help', '-h', '--version', '-v', '-V', '--info', '--list'])
const GENERIC_SUBCOMMANDS = new Set(['help', 'version', 'info', 'list'])
const PACKAGE_MANAGER_TOOLS = new Set(['npm', 'pnpm', 'yarn', 'bun'])
const PACKAGE_MANAGER_SCRIPT_SUBCOMMANDS = new Set(['run', 'test', 'build', 'lint', 'start', 'dev', 'serve', 'check', 'format'])
const FILE_EXTENSION_REGEX = /\.(json|yml|yaml|toml|lock|md|txt|ini|cfg|conf|sh|py|rs|go|java|js|ts|tsx|jsx|c|cc|cpp|h|hpp)$/i
const PATH_TEXT_REGEX = /(^|\s)(\.{1,2}[\\/]|~\/|[A-Za-z]:[\\/]|\/[A-Za-z0-9._-]+|[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)/
const GLOBAL_TOOL_REGEXES = GLOBAL_TOOL_KEYWORDS.map(buildKeywordRegex)
const GLOBAL_DISCOVERY_REGEXES = GLOBAL_DISCOVERY_KEYWORDS.map(buildKeywordRegex)

// Warning synthesis constants
const WARNING_SYNTHESIS_MIN_FAILURES = 2
const WARNING_SYNTHESIS_BATCH_SIZE = 10
const WARNING_SYNTHESIS_MAX_TOKENS = 800
const WARNING_SYNTHESIS_TOOL_NAME = 'emit_warning'

const GENERALIZATION_PROMPT = `Evaluate this memory record for reusability across different contexts.

A memory is too specific if it contains details that are:
- Tied to a particular instance/session that won't exist later
- Specific identifiers that change between runs
- User/machine-specific paths or configurations
- Timestamps or dates that make the memory time-bound

If the memory is too specific, provide a generalized version that:
- Preserves the useful pattern or knowledge
- Removes or abstracts away ephemeral details
- Remains accurate and helpful

Return JSON:
{
  "shouldGeneralize": boolean,
  "reason": "why it needs generalization (or why it's fine)",
  "generalized": { /* only if shouldGeneralize, partial record with updated fields */ }
}`

const CONTRADICTION_PROMPT = `Analyze these two memory records for contradiction.

Both records are about the same topic (high semantic similarity) but have different content.
Determine if they actually contradict each other or are complementary/additive.

Contradicting means:
- One record supersedes or corrects the other
- They give conflicting advice for the same situation
- The newer record reflects updated knowledge that invalidates the older

Complementary means:
- They cover different aspects of the same topic
- Both can be true simultaneously
- They add to each other without conflict

Return JSON:
{
  "verdict": "keep_newer" | "keep_older" | "keep_both" | "merge",
  "reason": "brief explanation",
  "merged": { /* only if verdict is "merge", partial record combining both */ }
}`

const CONFLICT_ADJUDICATION_PROMPT = `You adjudicate conflicts between a newly extracted memory and an existing memory.

Compare the Existing Memory and the New Candidate. Determine their relationship and emit a verdict:
- "supersedes": the new memory updates/corrects the existing fact; deprecate the existing record.
- "variant": both can be true in different contexts; keep both records.
- "hallucination": the new memory is vague/incorrect compared to the existing; deprecate the new record.

Rules:
- Use only the provided records; do not invent context.
- Be conservative: choose "variant" when both could be true.
- Provide a concise reason.
- Output ONLY via the tool call "${CONFLICT_ADJUDICATION_TOOL_NAME}" exactly once.`

const GLOBAL_PROMOTION_PROMPT = `Evaluate if this memory record should be promoted to global scope.

Global scope means the knowledge is universally applicable across different projects.
Project scope means the knowledge is specific to a particular codebase or environment.

Criteria for GLOBAL:
- Uses standard tools/languages without project-specific configuration
- Error patterns or solutions that apply to any project using that tool
- Generic commands that work the same everywhere
- Universal best practices or conventions

Criteria for PROJECT (keep local):
- References project-specific paths, files, or configurations
- Depends on project-specific setup or environment
- Uses custom scripts or aliases unique to a project
- Contains project-specific domain knowledge

Return JSON:
{
  "shouldPromote": boolean,
  "confidence": "high" | "medium" | "low",
  "reason": "brief explanation"
}`

const WARNING_SYNTHESIS_PROMPT = `Analyze these failure records and synthesize a warning if there's a clear anti-pattern.

You're looking at records that have failed multiple times. Determine if they represent:
1. A consistent anti-pattern that should be avoided
2. Random failures with no clear pattern
3. Context-dependent issues that aren't generalizable

If there IS a clear anti-pattern, provide:
- avoid: what specifically to avoid (be concrete, e.g., "npm run build" not "building")
- useInstead: the better alternative (if known from the records, or describe the fix)
- reason: why it fails (error message, behavior issue)
- severity: "caution" (minor inconvenience), "warning" (will fail), "critical" (data loss/security)

If there's no clear pattern (random failures, context-dependent), return null for the warning.

Output ONLY via the tool call "${WARNING_SYNTHESIS_TOOL_NAME}" exactly once.`

const WARNING_SYNTHESIS_TOOL: Anthropic.Tool = {
  name: WARNING_SYNTHESIS_TOOL_NAME,
  description: 'Emit a synthesized warning from failure patterns, or null if no clear pattern.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['warning'],
    properties: {
      warning: {
        oneOf: [
          { type: 'null' },
          {
            type: 'object',
            additionalProperties: false,
            required: ['avoid', 'useInstead', 'reason', 'severity'],
            properties: {
              avoid: { type: 'string' },
              useInstead: { type: 'string' },
              reason: { type: 'string' },
              severity: { type: 'string', enum: ['caution', 'warning', 'critical'] }
            }
          }
        ]
      }
    }
  }
}

const CONFLICT_ADJUDICATION_TOOL: Anthropic.Tool = {
  name: CONFLICT_ADJUDICATION_TOOL_NAME,
  description: 'Emit verdict for memory conflict resolution',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['verdict', 'reason'],
    properties: {
      verdict: { type: 'string', enum: ['supersedes', 'variant', 'hallucination'] },
      reason: { type: 'string' }
    }
  }
}

let cachedAnthropicClient: Awaited<ReturnType<typeof createAnthropicClient>> | undefined

export interface ValidityResult {
  valid: boolean
  reason?: string
}

export interface ConsolidationResult {
  keptId: string
  deprecatedIds: string[]
  successCount: number
  failureCount: number
  retrievalCount: number
  usageCount: number
  lastUsed: number
}

export interface ContradictionPair {
  newer: MemoryRecord
  older: MemoryRecord
  similarity: number
}

export interface ContradictionResult {
  verdict: 'keep_newer' | 'keep_older' | 'keep_both' | 'merge'
  reason?: string
  mergedRecord?: Partial<MemoryRecord>
}

export interface ConflictPair {
  newRecord: MemoryRecord
  existingRecord: MemoryRecord
}

export interface GeneralizationResult {
  shouldGeneralize: boolean
  generalizedRecord?: Partial<MemoryRecord>
  reason?: string
}

export interface GlobalPromotionResult {
  shouldPromote: boolean
  confidence: 'high' | 'medium' | 'low'
  reason?: string
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

export interface ConsolidationClusterMember {
  record: MemoryRecord
  similarity: number
}

export type ConsolidationCluster = MemoryRecord[] & {
  seedId: string
  members: ConsolidationClusterMember[]
}

export async function findStaleRecords(config: Config = DEFAULT_CONFIG): Promise<MemoryRecord[]> {
  const cutoff = Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000
  const filter = `deprecated == false && last_used < ${Math.trunc(cutoff)}`
  return fetchRecords(filter, config, false)
}

export async function findGlobalCandidates(config: Config = DEFAULT_CONFIG): Promise<MemoryRecord[]> {
  const candidates: MemoryRecord[] = []
  const types = ['error', 'command', 'discovery'] as const
  const typeFilter = types.map(type => `type == "${type}"`).join(' || ')
  const countFilter = [
    `(type == "command" && success_count >= ${GLOBAL_PROMOTION_MIN_SUCCESS_COUNT})`,
    `(type != "command" && usage_count >= ${GLOBAL_PROMOTION_MIN_SUCCESS_COUNT})`
  ].join(' || ')
  const filter = ['deprecated == false', `(${typeFilter})`, `(${countFilter})`].join(' && ')
  const records = await fetchRecords(filter, config, false)

  for (const record of records) {
    if (record.scope === 'global') continue
    if (record.deprecated) continue
    if (isGlobalCandidate(record)) {
      candidates.push(record)
    }
  }

  return candidates
}

export async function findLowUsageRecords(config: Config = DEFAULT_CONFIG): Promise<MemoryRecord[]> {
  // Find records retrieved at least N times with usage ratio below threshold
  const filter = `deprecated == false && retrieval_count >= ${LOW_USAGE_MIN_RETRIEVALS}`
  const records = await fetchRecords(filter, config, false)

  return records.filter(record => {
    const retrievalCount = record.retrievalCount ?? 0
    const usageCount = record.usageCount ?? 0
    if (retrievalCount < LOW_USAGE_MIN_RETRIEVALS) return false
    const ratio = usageCount / retrievalCount
    return ratio < LOW_USAGE_RATIO_THRESHOLD
  })
}

export async function findLowUsageHighRetrieval(
  config: Config = DEFAULT_CONFIG
): Promise<MemoryRecord[]> {
  const filter = ['deprecated == false', `retrieval_count >= ${LOW_USAGE_HIGH_RETRIEVAL_MIN}`].join(' && ')
  const records = await fetchRecords(filter, config, false)
  return records.filter(record => (record.usageCount ?? 0) === 0)
}

export async function findNewConflicts(config: Config = DEFAULT_CONFIG): Promise<ConflictPair[]> {
  const pairs: ConflictPair[] = []
  const filter = 'deprecated == false && last_conflict_check == 0'
  const unchecked = await fetchRecords(filter, config, true)
  const establishedFilter = 'last_conflict_check > 0'

  for (const record of unchecked) {
    const matches = await findSimilar(record, CONFLICT_SIMILARITY_THRESHOLD, 5, config, establishedFilter)
    for (const match of matches) {
      pairs.push({ newRecord: record, existingRecord: match.record })
    }
  }

  return pairs
}

export async function checkValidity(record: MemoryRecord): Promise<ValidityResult> {
  switch (record.type) {
    case 'command': {
      const command = extractExecutable(record.command)
      if (!command) return { valid: false, reason: 'missing-command' }
      const exists = commandExists(command, record.context.cwd ?? record.context.project ?? record.project)
      return exists ? { valid: true } : { valid: false, reason: `missing-command:${command}` }
    }
    case 'procedure': {
      const baseDir = record.context.project ?? record.project
      const steps = pickProcedureSteps(record.steps, PROCEDURE_STEP_CHECK_COUNT)
      if (steps.length === 0) return { valid: false, reason: 'missing-procedure-step' }

      for (const step of steps) {
        const command = extractExecutable(step)
        if (!command) return { valid: false, reason: 'missing-command' }
        const exists = commandExists(command, baseDir)
        if (!exists) return { valid: false, reason: `missing-command:${command}` }
      }

      return { valid: true }
    }
    case 'discovery': {
      const timestamp = record.timestamp ?? 0
      if (!timestamp) return { valid: true, reason: 'no-timestamp' }
      const ageDays = (Date.now() - timestamp) / (1000 * 60 * 60 * 24)
      if (ageDays >= DISCOVERY_MAX_AGE_DAYS) {
        return { valid: false, reason: `discovery-aged:${Math.floor(ageDays)}d` }
      }
      return { valid: true }
    }
    case 'error':
      return { valid: true, reason: 'assumed-valid' }
    case 'warning':
      return { valid: true, reason: 'assumed-valid' }
  }
}

export async function markDeprecated(id: string, config: Config = DEFAULT_CONFIG): Promise<boolean> {
  return updateRecord(id, { deprecated: true }, config)
}

export async function promoteToGlobal(id: string, config: Config = DEFAULT_CONFIG): Promise<boolean> {
  return updateRecord(id, { scope: 'global' }, config)
}

export async function findSimilarClusters(
  similarityThreshold: number = SIMILARITY_THRESHOLDS.CONSOLIDATION,
  config: Config = DEFAULT_CONFIG
): Promise<ConsolidationCluster[]> {
  const clusters: ConsolidationCluster[] = []
  const clusteredIds = new Set<string>()
  let offset = 0

  while (true) {
    const batch = await queryRecords(
      {
        filter: 'deprecated == false',
        limit: QUERY_PAGE_SIZE,
        offset,
        includeEmbeddings: true
      },
      config
    )

    if (batch.length === 0) break

    for (const record of batch) {
      if (clusteredIds.has(record.id)) continue
      if (!isValidEmbedding(record.embedding)) continue

      const seedText = normalizeExactText(buildExactText(record))
      if (!seedText) continue

      const matches = await vectorSearchSimilar(
        record.embedding,
        {
          filter: buildConsolidationFilter(record),
          limit: CONSOLIDATION_SEARCH_LIMIT,
          similarityThreshold
        },
        config
      )

      const members: ConsolidationClusterMember[] = [{ record, similarity: 1 }]
      // Keep clusters array-like for older callers while exposing metadata for new consumers.
      const cluster = [record] as ConsolidationCluster
      cluster.seedId = record.id
      cluster.members = members
      for (const match of matches) {
        const candidate = match.record
        if (clusteredIds.has(candidate.id)) continue
        if (candidate.deprecated) continue

        const candidateText = normalizeExactText(buildExactText(candidate))
        if (!candidateText) continue
        if (!isExactTextSimilar(seedText, candidateText)) continue

        cluster.push(candidate)
        members.push({ record: candidate, similarity: match.similarity })
        if (cluster.length >= CONSOLIDATION_MAX_CLUSTER_SIZE) break
      }

      if (cluster.length > 1) {
        clusters.push(cluster)
        for (const member of cluster) {
          clusteredIds.add(member.id)
        }
      }
    }

    if (batch.length < QUERY_PAGE_SIZE) break
    offset += batch.length
  }

  return clusters
}

export async function consolidateCluster(
  cluster: MemoryRecord[],
  config: Config = DEFAULT_CONFIG
): Promise<ConsolidationResult | null> {
  if (cluster.length < 2) return null

  const sorted = [...cluster].sort((a, b) => {
    const successDiff = (b.successCount ?? 0) - (a.successCount ?? 0)
    if (successDiff !== 0) return successDiff
    const lastUsedDiff = (b.lastUsed ?? 0) - (a.lastUsed ?? 0)
    if (lastUsedDiff !== 0) return lastUsedDiff
    return (b.timestamp ?? 0) - (a.timestamp ?? 0)
  })

  const keeper = sorted[0]
  const totals = cluster.reduce(
    (acc, record) => {
      acc.success += record.successCount ?? 0
      acc.failure += record.failureCount ?? 0
      acc.retrieval += record.retrievalCount ?? 0
      acc.usage += record.usageCount ?? 0
      acc.lastUsed = Math.max(acc.lastUsed, record.lastUsed ?? 0)
      return acc
    },
    { success: 0, failure: 0, retrieval: 0, usage: 0, lastUsed: 0 }
  )

  const updates: Partial<MemoryRecord> = {
    successCount: totals.success,
    failureCount: totals.failure,
    retrievalCount: totals.retrieval,
    usageCount: totals.usage
  }
  if (totals.lastUsed > 0) {
    updates.lastUsed = totals.lastUsed
  }

  await updateRecord(keeper.id, updates, config)

  const deprecatedIds: string[] = []
  for (const record of cluster) {
    if (record.id === keeper.id) continue
    await markDeprecated(record.id, config)
    deprecatedIds.push(record.id)
  }

  return {
    keptId: keeper.id,
    deprecatedIds,
    successCount: totals.success,
    failureCount: totals.failure,
    retrievalCount: totals.retrieval,
    usageCount: totals.usage,
    lastUsed: totals.lastUsed
  }
}

/**
 * Find contradiction pairs: semantically similar records of same type/project
 * but with different content (newer likely supersedes older).
 *
 * Unlike consolidation which finds near-duplicates (high text similarity),
 * this finds records that cover the same topic but say different things.
 */
export async function findContradictionPairs(
  config: Config = DEFAULT_CONFIG
): Promise<ContradictionPair[]> {
  const pairs: ContradictionPair[] = []
  const processedIds = new Set<string>()
  let offset = 0

  while (true) {
    const batch = await queryRecords(
      {
        filter: 'deprecated == false',
        limit: QUERY_PAGE_SIZE,
        offset,
        includeEmbeddings: true
      },
      config
    )

    if (batch.length === 0) break

    for (const record of batch) {
      if (processedIds.has(record.id)) continue
      if (!isValidEmbedding(record.embedding)) continue

      const recordText = normalizeExactText(buildExactText(record))
      if (!recordText) continue

      // Find semantically similar records of same type/project
      const matches = await vectorSearchSimilar(
        record.embedding,
        {
          filter: buildContradictionFilter(record),
          limit: CONTRADICTION_SEARCH_LIMIT,
          similarityThreshold: CONTRADICTION_SIMILARITY_THRESHOLD
        },
        config
      )

      for (const match of matches) {
        const candidate = match.record
        if (processedIds.has(candidate.id)) continue
        if (candidate.deprecated) continue

        const candidateText = normalizeExactText(buildExactText(candidate))
        if (!candidateText) continue

        // Skip if texts are too similar (that's consolidation territory)
        if (isExactTextSimilar(recordText, candidateText)) continue

        // Determine which is newer
        const recordTime = record.timestamp ?? 0
        const candidateTime = candidate.timestamp ?? 0

        if (recordTime > candidateTime) {
          pairs.push({ newer: record, older: candidate, similarity: match.similarity })
        } else if (candidateTime > recordTime) {
          pairs.push({ newer: candidate, older: record, similarity: match.similarity })
        }
        // If same timestamp, skip (ambiguous)

        // Mark the older one as processed to avoid duplicate pairs
        const olderId = recordTime > candidateTime ? candidate.id : record.id
        processedIds.add(olderId)
      }

      processedIds.add(record.id)
    }

    if (batch.length < QUERY_PAGE_SIZE) break
    offset += batch.length
  }

  return pairs
}

/**
 * Resolve a contradiction by deprecating the older record.
 * The newer record is assumed to supersede it.
 */
export async function resolveContradiction(
  pair: ContradictionPair,
  config: Config = DEFAULT_CONFIG
): Promise<boolean> {
  return markDeprecated(pair.older.id, config)
}

export async function checkContradiction(
  pair: ContradictionPair,
  config: Config
): Promise<ContradictionResult> {
  const client = await getAnthropicClient()
  if (!client) {
    throw new Error('No authentication available for contradiction check. Set ANTHROPIC_API_KEY or run kira login.')
  }

  const payload = JSON.stringify(buildContradictionInput(pair), null, 2)

  const response = await client.messages.create({
    model: config.extraction.model,
    max_tokens: Math.min(CONTRADICTION_MAX_TOKENS, config.extraction.maxTokens),
    temperature: 0,
    system: [
      { type: 'text', text: CLAUDE_CODE_SYSTEM_PROMPT },
      { type: 'text', text: CONTRADICTION_PROMPT }
    ],
    messages: [{ role: 'user', content: `Records:\n${payload}` }]
  })

  const rawText = extractResponseText(response.content)
  return parseContradictionResponse(rawText)
}

export async function resolveContradictionWithLLM(
  pair: ContradictionPair,
  result: ContradictionResult,
  config: Config = DEFAULT_CONFIG
): Promise<{ action: ContradictionResult['verdict']; recordId?: string }> {
  switch (result.verdict) {
    case 'keep_newer': {
      const updated = await markDeprecated(pair.older.id, config)
      return updated ? { action: 'keep_newer', recordId: pair.older.id } : { action: 'keep_both' }
    }
    case 'keep_older': {
      const updated = await markDeprecated(pair.newer.id, config)
      return updated ? { action: 'keep_older', recordId: pair.newer.id } : { action: 'keep_both' }
    }
    case 'merge': {
      const mergedUpdates = result.mergedRecord
        ? filterContradictionMerge(pair.newer, result.mergedRecord)
        : {}

      if (Object.keys(mergedUpdates).length > 0) {
        const updates: Partial<MemoryRecord> = { ...mergedUpdates }
        if (pair.newer.timestamp) {
          updates.timestamp = pair.newer.timestamp
        }
        const updated = await updateRecord(pair.newer.id, updates, config)
        if (!updated) return { action: 'keep_both' }
      }

      const deprecated = await markDeprecated(pair.older.id, config)
      return deprecated ? { action: 'merge', recordId: pair.older.id } : { action: 'keep_both' }
    }
    case 'keep_both':
    default:
      return { action: 'keep_both' }
  }
}

export async function resolveConflictWithLlm(
  pair: ConflictPair,
  config: Config
): Promise<{ verdict: 'supersedes' | 'variant' | 'hallucination'; reason: string }> {
  const client = await getAnthropicClient()
  if (!client) {
    throw new Error('No authentication available for conflict adjudication. Set ANTHROPIC_API_KEY or run kira login.')
  }

  const payload = JSON.stringify(buildConflictAdjudicationInput(pair), null, 2)

  const response = await client.messages.create({
    model: CONFLICT_ADJUDICATION_MODEL,
    max_tokens: Math.min(CONFLICT_ADJUDICATION_MAX_TOKENS, config.extraction.maxTokens),
    temperature: 0,
    system: [
      { type: 'text', text: CLAUDE_CODE_SYSTEM_PROMPT },
      { type: 'text', text: CONFLICT_ADJUDICATION_PROMPT }
    ],
    messages: [{ role: 'user', content: `Records:\n${payload}` }],
    tools: [CONFLICT_ADJUDICATION_TOOL],
    tool_choice: { type: 'tool', name: CONFLICT_ADJUDICATION_TOOL_NAME }
  })

  const toolInput = response.content.find((block): block is ToolUseBlock =>
    isToolUseBlock(block) && block.name === CONFLICT_ADJUDICATION_TOOL_NAME
  )?.input

  if (!toolInput) {
    throw new Error('Conflict adjudication tool call missing in response.')
  }

  const verdict = coerceConflictVerdict(toolInput)
  if (!verdict) {
    throw new Error('Conflict adjudication response invalid or incomplete.')
  }

  return verdict
}

type ConflictMaintenanceAction = {
  type: 'deprecate'
  recordId?: string
  snippet: string
  reason: string
  details?: Record<string, unknown>
}

export async function runConflictResolution(
  dryRun: boolean,
  config: Config = DEFAULT_CONFIG
): Promise<{
  actions: ConflictMaintenanceAction[]
  summary: Record<string, number>
  candidates: MaintenanceCandidateGroup[]
  error?: string
}> {
  const actions: ConflictMaintenanceAction[] = []
  const candidateGroups: MaintenanceCandidateGroup[] = []
  let candidates = 0
  let pairs = 0
  let checked = 0
  let deprecatedExisting = 0
  let deprecatedNew = 0
  let variants = 0
  let processed = 0
  let errors = 0

  try {
    const unchecked = await fetchRecords('deprecated == false && last_conflict_check == 0', config, false)
    candidates = unchecked.length
    if (unchecked.length > 0) {
      const records = unchecked.map(record => buildCandidateRecord(record, 'new, never conflict-checked'))
      candidateGroups.push({
        id: 'conflict-candidates',
        label: 'New records',
        records
      })
    }

    const conflictPairs = await findNewConflicts(config)
    pairs = conflictPairs.length

    const deprecatedNewIds = new Set<string>()
    const failedNewIds = new Set<string>()
    // Stage actions per candidate so errors don't cause partial deprecations.
    let currentNewId: string | null = null
    let pendingActions: ConflictMaintenanceAction[] = []
    let pendingVariants = 0
    let pendingFailed = false

    const resetPending = (newId: string) => {
      currentNewId = newId
      pendingActions = []
      pendingVariants = 0
      pendingFailed = false
    }

    const flushPending = async () => {
      if (!currentNewId) return
      if (pendingFailed) {
        pendingActions = []
        pendingVariants = 0
        return
      }

      if (dryRun) {
        actions.push(...pendingActions)
        for (const action of pendingActions) {
          if (!action.recordId) continue
          if (action.recordId === currentNewId) {
            deprecatedNew += 1
          } else {
            deprecatedExisting += 1
          }
        }
        variants += pendingVariants
        return
      }

      for (const action of pendingActions) {
        if (!action.recordId) continue
        const updatedRecord = await markDeprecated(action.recordId, config)
        if (updatedRecord) {
          actions.push(action)
          if (action.recordId === currentNewId) {
            deprecatedNew += 1
          } else {
            deprecatedExisting += 1
          }
        }
      }
      variants += pendingVariants
    }

    for (let i = 0; i < conflictPairs.length; i += CONFLICT_CHECK_BATCH_SIZE) {
      const batch = conflictPairs.slice(i, i + CONFLICT_CHECK_BATCH_SIZE)

      for (const pair of batch) {
        const newId = pair.newRecord.id
        if (currentNewId && newId !== currentNewId) {
          await flushPending()
          resetPending(newId)
        } else if (!currentNewId) {
          resetPending(newId)
        }

        if (deprecatedNewIds.has(newId) || failedNewIds.has(newId)) continue

        try {
          const verdict = await resolveConflictWithLlm(pair, config)
          checked += 1

          if (verdict.verdict === 'supersedes') {
            const action: ConflictMaintenanceAction = {
              type: 'deprecate',
              recordId: pair.existingRecord.id,
              snippet: truncateSnippet(buildRecordSnippet(pair.existingRecord)),
              reason: verdict.reason,
              details: {
                verdict: verdict.verdict,
                candidateId: newId,
                existingId: pair.existingRecord.id
              }
            }

            pendingActions.push(action)
          } else if (verdict.verdict === 'hallucination') {
            const action: ConflictMaintenanceAction = {
              type: 'deprecate',
              recordId: newId,
              snippet: truncateSnippet(buildRecordSnippet(pair.newRecord)),
              reason: verdict.reason,
              details: {
                verdict: verdict.verdict,
                candidateId: newId,
                existingId: pair.existingRecord.id
              }
            }

            pendingActions = [action]
            pendingVariants = 0
            deprecatedNewIds.add(newId)
          } else {
            pendingVariants += 1
          }
        } catch {
          errors += 1
          failedNewIds.add(newId)
          pendingActions = []
          pendingVariants = 0
          pendingFailed = true
        }
      }
    }

    await flushPending()

    const checkedAt = Date.now()
    for (const record of unchecked) {
      if (deprecatedNewIds.has(record.id)) continue
      if (failedNewIds.has(record.id)) continue

      if (dryRun) {
        processed += 1
      } else {
        const didUpdate = await updateRecord(record.id, { lastConflictCheck: checkedAt }, config)
        if (didUpdate) {
          processed += 1
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      actions,
      summary: { candidates, pairs, checked, deprecatedExisting, deprecatedNew, variants, processed, errors },
      candidates: candidateGroups,
      error: message
    }
  }

  return {
    actions,
    summary: { candidates, pairs, checked, deprecatedExisting, deprecatedNew, variants, processed, errors },
    candidates: candidateGroups
  }
}

export async function checkGeneralization(
  record: MemoryRecord,
  config: Config
): Promise<GeneralizationResult> {
  const client = await getAnthropicClient()
  if (!client) {
    throw new Error('No authentication available for generalization. Set ANTHROPIC_API_KEY or run kira login.')
  }

  const payload = JSON.stringify(buildGeneralizationInput(record), null, 2)

  const response = await client.messages.create({
    model: config.extraction.model,
    max_tokens: Math.min(GENERALIZATION_MAX_TOKENS, config.extraction.maxTokens),
    temperature: 0,
    system: [
      { type: 'text', text: CLAUDE_CODE_SYSTEM_PROMPT },
      { type: 'text', text: GENERALIZATION_PROMPT }
    ],
    messages: [{ role: 'user', content: `Record:\n${payload}` }]
  })

  const rawText = extractResponseText(response.content)
  const parsed = parseGeneralizationResponse(rawText)

  if (!parsed.shouldGeneralize || !parsed.generalizedRecord) {
    return parsed
  }

  const filtered = filterGeneralizationUpdates(record, parsed.generalizedRecord)
  if (Object.keys(filtered).length === 0) {
    return {
      shouldGeneralize: false,
      reason: parsed.reason ? `${parsed.reason} (no usable updates)` : 'no-usable-updates'
    }
  }

  return {
    shouldGeneralize: true,
    generalizedRecord: filtered,
    reason: parsed.reason
  }
}

export async function generalizeRecord(
  id: string,
  updates: Partial<MemoryRecord>,
  config: Config
): Promise<boolean> {
  if (!updates || Object.keys(updates).length === 0) return false

  return updateRecord(
    id,
    {
      ...updates,
      generalized: true,
      lastGeneralizationCheck: Date.now()
    },
    config
  )
}

export async function checkGlobalPromotion(
  record: MemoryRecord,
  config: Config
): Promise<GlobalPromotionResult> {
  const client = await getAnthropicClient()
  if (!client) {
    throw new Error('No authentication available for global promotion check. Set ANTHROPIC_API_KEY or run kira login.')
  }

  const payload = JSON.stringify(buildGeneralizationInput(record), null, 2)

  const response = await client.messages.create({
    model: config.extraction.model,
    max_tokens: Math.min(GLOBAL_PROMOTION_MAX_TOKENS, config.extraction.maxTokens),
    temperature: 0,
    system: [
      { type: 'text', text: CLAUDE_CODE_SYSTEM_PROMPT },
      { type: 'text', text: GLOBAL_PROMOTION_PROMPT }
    ],
    messages: [{ role: 'user', content: `Record:\n${payload}` }]
  })

  const rawText = extractResponseText(response.content)
  return parseGlobalPromotionResponse(rawText)
}

function buildContradictionFilter(record: MemoryRecord): string {
  // For contradictions, we DO want to filter by project/domain since
  // the same command can legitimately have different outcomes in different projects.
  // Don't include global scope bypass (includeGlobal: false).
  return buildFilter({
    project: record.project,
    domain: record.domain,
    type: record.type,
    excludeId: record.id,
    excludeDeprecated: true
  }) ?? 'deprecated == false'
}

async function fetchRecords(
  filter: string | undefined,
  config: Config,
  includeEmbeddings: boolean
): Promise<MemoryRecord[]> {
  const records: MemoryRecord[] = []
  let offset = 0

  while (true) {
    const batch = await queryRecords(
      {
        filter,
        limit: QUERY_PAGE_SIZE,
        offset,
        includeEmbeddings
      },
      config
    )

    if (batch.length === 0) break
    records.push(...batch)
    if (batch.length < QUERY_PAGE_SIZE) break
    offset += batch.length
  }

  return records
}

function isValidEmbedding(embedding: number[] | undefined): embedding is number[] {
  return Array.isArray(embedding) && embedding.length === EMBEDDING_DIM
}

function isExactTextSimilar(seed: string, candidate: string): boolean {
  if (!seed || !candidate) return false
  if (seed === candidate) return true
  if (seed.includes(candidate) || candidate.includes(seed)) return true

  const maxLength = Math.max(seed.length, candidate.length)
  const threshold = Math.floor(maxLength * TEXT_SIMILARITY_RATIO)
  if (threshold === 0) return false
  if (Math.abs(seed.length - candidate.length) > threshold) return false

  return levenshteinDistance(seed, candidate, threshold) <= threshold
}

function buildConsolidationFilter(record: MemoryRecord): string {
  // Only filter by type - no project/domain so we find cross-project duplicates
  return buildFilter({
    type: record.type,
    excludeId: record.id,
    excludeDeprecated: true
  }) ?? 'deprecated == false'
}

function isGlobalCandidate(record: MemoryRecord): boolean {
  if (!passesGlobalPromotionHeuristics(record)) return false
  switch (record.type) {
    case 'error':
      return isGlobalErrorCandidate(record)
    case 'command':
      return isGlobalCommandCandidate(record)
    case 'discovery':
      return isGlobalDiscoveryCandidate(record)
    default:
      return false
  }
}

function passesGlobalPromotionHeuristics(record: MemoryRecord): boolean {
  const successCount = record.successCount ?? 0
  const usageCount = record.usageCount ?? 0
  if (record.type === 'command') {
    if (successCount < GLOBAL_PROMOTION_MIN_SUCCESS_COUNT) return false
  } else if (usageCount < GLOBAL_PROMOTION_MIN_SUCCESS_COUNT) {
    return false
  }
  if (recordHasPathReference(record)) return false

  const retrievalCount = record.retrievalCount ?? 0
  if (retrievalCount >= GLOBAL_PROMOTION_MIN_RETRIEVALS_FOR_USAGE_RATIO) {
    const ratio = usageCount / retrievalCount
    if (ratio < GLOBAL_PROMOTION_MIN_USAGE_RATIO) return false
  }

  return true
}

function recordHasPathReference(record: MemoryRecord): boolean {
  switch (record.type) {
    case 'command':
      return hasPathReference([record.command, record.resolution, record.truncatedOutput])
    case 'error':
      return hasPathReference([record.errorText, record.cause, record.resolution, record.context.file])
    case 'discovery':
      return hasPathReference([record.what, record.where, record.evidence])
    default:
      return false
  }
}

function hasPathReference(values: Array<string | undefined>): boolean {
  const combined = normalizeMatchText(values.filter(Boolean).join(' '))
  if (!combined) return false
  return PATH_TEXT_REGEX.test(combined)
}

function isGlobalErrorCandidate(record: Extract<MemoryRecord, { type: 'error' }>): boolean {
  const resolution = normalizeMatchText(record.resolution ?? '')
  const errorText = normalizeMatchText(record.errorText ?? '')
  const tool = normalizeMatchText(record.context.tool ?? '')
  if (resolution && matchesAnyRegex(resolution, GLOBAL_TOOL_REGEXES)) return true
  if (errorText && matchesAnyRegex(errorText, GLOBAL_TOOL_REGEXES)) return true
  if (tool && matchesAnyRegex(tool, GLOBAL_TOOL_REGEXES)) return true
  return false
}

function isGlobalCommandCandidate(record: Extract<MemoryRecord, { type: 'command' }>): boolean {
  const parsed = parseCommandLine(record.command)
  if (!parsed.executable) return false

  const executable = parsed.executable.toLowerCase()
  if (looksLikePath(executable) || executable.includes('\\')) return false
  if (!GLOBAL_COMMAND_TOOLS.has(executable)) return false

  const args = parsed.args
  if (args.some(isPathLikeToken)) return false
  if (isPackageManagerScript(executable, args)) return false

  const nonFlagArgs = args.filter(arg => !arg.startsWith('-'))
  if (hasGenericFlag(args)) return true
  if (nonFlagArgs.length <= 1) return true

  return false
}

function isGlobalDiscoveryCandidate(record: Extract<MemoryRecord, { type: 'discovery' }>): boolean {
  const combined = normalizeMatchText([record.what, record.where, record.evidence].filter(Boolean).join(' '))
  if (!combined) return false
  if (PATH_TEXT_REGEX.test(combined)) return false
  return matchesAnyRegex(combined, GLOBAL_DISCOVERY_REGEXES)
}

function normalizeMatchText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function matchesAnyRegex(value: string, regexes: RegExp[]): boolean {
  return regexes.some(regex => regex.test(value))
}

function buildKeywordRegex(keyword: string): RegExp {
  const escaped = escapeRegExp(keyword)
  return new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`, 'i')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function hasGenericFlag(args: string[]): boolean {
  for (const arg of args) {
    if (GENERIC_COMMAND_FLAGS.has(arg)) return true
    if (!arg.startsWith('-') && GENERIC_SUBCOMMANDS.has(arg)) return true
  }
  return false
}

function isPackageManagerScript(executable: string, args: string[]): boolean {
  if (!PACKAGE_MANAGER_TOOLS.has(executable)) return false
  const nonFlagArgs = args.filter(arg => !arg.startsWith('-'))
  return nonFlagArgs.some(arg => PACKAGE_MANAGER_SCRIPT_SUBCOMMANDS.has(arg))
}

function isPathLikeToken(token: string): boolean {
  const raw = stripQuotes(token)
  if (!raw) return false
  if (raw.startsWith('-') && !raw.includes('=')) return false

  const candidate = raw.includes('=') ? raw.split('=', 2)[1] : raw
  if (!candidate) return false

  if (candidate.startsWith('./') || candidate.startsWith('../') || candidate.startsWith('~/')) return true
  if (candidate.includes('/') || candidate.includes('\\')) return true
  if (FILE_EXTENSION_REGEX.test(candidate)) return true
  return false
}

function levenshteinDistance(a: string, b: string, maxDistance?: number): number {
  if (a === b) return 0
  const aLength = a.length
  const bLength = b.length

  if (aLength === 0) return bLength
  if (bLength === 0) return aLength
  if (maxDistance !== undefined && Math.abs(aLength - bLength) > maxDistance) {
    return maxDistance + 1
  }

  let prev = new Array<number>(bLength + 1)
  let curr = new Array<number>(bLength + 1)

  for (let j = 0; j <= bLength; j += 1) {
    prev[j] = j
  }

  for (let i = 1; i <= aLength; i += 1) {
    curr[0] = i
    let rowMin = curr[0]
    const aChar = a.charCodeAt(i - 1)

    for (let j = 1; j <= bLength; j += 1) {
      const cost = aChar === b.charCodeAt(j - 1) ? 0 : 1
      const deletion = prev[j] + 1
      const insertion = curr[j - 1] + 1
      const substitution = prev[j - 1] + cost
      const value = Math.min(deletion, insertion, substitution)
      curr[j] = value
      if (value < rowMin) rowMin = value
    }

    if (maxDistance !== undefined && rowMin > maxDistance) {
      return maxDistance + 1
    }

    const swap = prev
    prev = curr
    curr = swap
  }

  return prev[bLength]
}

function pickProcedureSteps(steps: string[], maxSteps: number): string[] {
  const normalized = steps
    .map(step => normalizeStep(step))
    .filter(step => step.length > 0)
  return normalized.slice(0, maxSteps)
}

function extractExecutable(commandLine: string): string | null {
  return parseCommandLine(commandLine).executable
}

function parseCommandLine(commandLine: string): { executable: string | null; args: string[] } {
  const segment = firstCommandSegment(commandLine)
  const tokens = tokenizeCommand(segment)
  if (tokens.length === 0) return { executable: null, args: [] }

  let index = 0
  while (index < tokens.length) {
    const token = stripQuotes(tokens[index])
    if (!token) {
      index += 1
      continue
    }

    if (token === 'sudo') {
      index = skipSudoOptions(tokens, index + 1)
      continue
    }

    if (token === 'env') {
      index = skipEnvOptions(tokens, index + 1)
      continue
    }

    if (isEnvAssignment(token)) {
      index += 1
      continue
    }

    const args = tokens.slice(index + 1).map(stripQuotes).filter(Boolean)
    return { executable: token, args }
  }

  return { executable: null, args: [] }
}

function firstCommandSegment(commandLine: string): string {
  let inSingle = false
  let inDouble = false
  let escaped = false

  for (let i = 0; i < commandLine.length; i += 1) {
    const char = commandLine[i]

    if (escaped) {
      escaped = false
      continue
    }

    if (char === '\\' && !inSingle) {
      escaped = true
      continue
    }

    if (char === "'" && !inDouble) {
      inSingle = !inSingle
      continue
    }

    if (char === '"' && !inSingle) {
      inDouble = !inDouble
      continue
    }

    if (inSingle || inDouble) continue

    if (char === ';' || char === '|') {
      return commandLine.slice(0, i).trim()
    }

    if (char === '&' && commandLine[i + 1] === '&') {
      return commandLine.slice(0, i).trim()
    }
  }

  return commandLine.trim()
}

function tokenizeCommand(commandLine: string): string[] {
  const matches = commandLine.match(/"[^"]*"|'[^']*'|[^\s]+/g)
  return matches ? matches.map(token => token.trim()).filter(Boolean) : []
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1)
    }
  }
  return value
}

function skipSudoOptions(tokens: string[], startIndex: number): number {
  let index = startIndex
  while (index < tokens.length) {
    const token = stripQuotes(tokens[index])
    if (!token.startsWith('-')) break
    if (requiresOptionValue(token) && index + 1 < tokens.length) {
      index += 2
    } else {
      index += 1
    }
  }
  return index
}

function skipEnvOptions(tokens: string[], startIndex: number): number {
  let index = startIndex
  while (index < tokens.length) {
    const token = stripQuotes(tokens[index])
    if (!token.startsWith('-')) break
    if (requiresOptionValue(token) && index + 1 < tokens.length) {
      index += 2
    } else {
      index += 1
    }
  }
  while (index < tokens.length) {
    const token = stripQuotes(tokens[index])
    if (!isEnvAssignment(token)) break
    index += 1
  }
  return index
}

function requiresOptionValue(option: string): boolean {
  return option === '-u' || option === '-g' || option === '-h' || option === '-p' || option === '-U'
}

function isEnvAssignment(token: string): boolean {
  if (!token.includes('=')) return false
  if (token.startsWith('=')) return false
  const key = token.split('=', 1)[0]
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
}

function commandExists(command: string, cwd?: string): boolean {
  if (looksLikePath(command)) {
    return isExecutablePath(command, cwd)
  }

  if (checkWhich(command)) return true
  if (checkType(command)) return true
  return false
}

function looksLikePath(command: string): boolean {
  return command.startsWith('./') || command.startsWith('/') || command.includes('/')
}

function isExecutablePath(command: string, cwd?: string): boolean {
  const resolved = resolveCommandPath(command, cwd)
  if (!fs.existsSync(resolved)) return false
  try {
    fs.accessSync(resolved, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

function checkWhich(command: string): boolean {
  try {
    execFileSync('which', [command], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function checkType(command: string): boolean {
  const shell = process.env.SHELL || 'bash'
  try {
    execFileSync(shell, ['-lc', `type -a -- ${shellEscape(command)}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function resolveCommandPath(command: string, cwd?: string): string {
  const expanded = command.startsWith('~')
    ? path.join(homedir(), command.slice(1).replace(/^\/+/, ''))
    : command
  if (path.isAbsolute(expanded)) return expanded
  return path.resolve(cwd ?? process.cwd(), expanded)
}

async function getAnthropicClient(): Promise<Awaited<ReturnType<typeof createAnthropicClient>>> {
  if (cachedAnthropicClient !== undefined) {
    return cachedAnthropicClient
  }

  cachedAnthropicClient = await createAnthropicClient()
  return cachedAnthropicClient
}

function buildContradictionInput(pair: ContradictionPair): Record<string, unknown> {
  return {
    similarity: pair.similarity,
    newer: {
      id: pair.newer.id,
      timestamp: pair.newer.timestamp,
      record: buildGeneralizationInput(pair.newer)
    },
    older: {
      id: pair.older.id,
      timestamp: pair.older.timestamp,
      record: buildGeneralizationInput(pair.older)
    }
  }
}

function buildConflictAdjudicationInput(pair: ConflictPair): Record<string, unknown> {
  return {
    existing: {
      id: pair.existingRecord.id,
      timestamp: pair.existingRecord.timestamp,
      record: buildGeneralizationInput(pair.existingRecord)
    },
    candidate: {
      id: pair.newRecord.id,
      timestamp: pair.newRecord.timestamp,
      record: buildGeneralizationInput(pair.newRecord)
    }
  }
}

function buildGeneralizationInput(record: MemoryRecord): Record<string, unknown> {
  const base = {
    type: record.type,
    scope: record.scope,
    project: record.project,
    domain: record.domain
  }

  switch (record.type) {
    case 'command':
      return {
        ...base,
        command: record.command,
        exitCode: record.exitCode,
        outcome: record.outcome,
        resolution: record.resolution,
        truncatedOutput: record.truncatedOutput,
        context: record.context
      }
    case 'error':
      return {
        ...base,
        errorText: record.errorText,
        errorType: record.errorType,
        cause: record.cause,
        resolution: record.resolution,
        context: record.context
      }
    case 'discovery':
      return {
        ...base,
        what: record.what,
        where: record.where,
        evidence: record.evidence,
        confidence: record.confidence
      }
    case 'procedure':
      return {
        ...base,
        name: record.name,
        steps: record.steps,
        prerequisites: record.prerequisites,
        verification: record.verification,
        context: record.context
      }
    case 'warning':
      return {
        ...base,
        avoid: record.avoid,
        useInstead: record.useInstead,
        reason: record.reason,
        severity: record.severity,
        sourceRecordIds: record.sourceRecordIds
      }
  }
}

function extractResponseText(
  content: Array<{ type: string; text?: string }>
): string {
  return content
    .filter(block => block.type === 'text')
    .map(block => block.text ?? '')
    .join('\n')
    .trim()
}

function parseGeneralizationResponse(rawText: string): GeneralizationResult {
  const parsed = extractJsonObject(rawText)
  if (!isPlainObject(parsed)) {
    return { shouldGeneralize: false, reason: 'invalid-json' }
  }

  const shouldGeneralize = coerceBoolean(parsed.shouldGeneralize)
  const reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : undefined

  if (!shouldGeneralize) {
    return { shouldGeneralize: false, ...(reason ? { reason } : {}) }
  }

  if (!isPlainObject(parsed.generalized)) {
    return { shouldGeneralize: false, reason: reason ? `${reason} (missing generalized)` : 'missing-generalized' }
  }

  return {
    shouldGeneralize: true,
    generalizedRecord: parsed.generalized as Partial<MemoryRecord>,
    ...(reason ? { reason } : {})
  }
}

function parseContradictionResponse(rawText: string): ContradictionResult {
  const parsed = extractJsonObject(rawText)
  if (!isPlainObject(parsed)) {
    return { verdict: 'keep_both', reason: 'invalid-json' }
  }

  const verdict = parseVerdict(parsed.verdict)
  const reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : undefined

  if (verdict === 'merge') {
    if (!isPlainObject(parsed.merged)) {
      return { verdict: 'keep_both', reason: reason ? `${reason} (missing merged)` : 'missing-merged' }
    }
    return {
      verdict: 'merge',
      mergedRecord: parsed.merged as Partial<MemoryRecord>,
      ...(reason ? { reason } : {})
    }
  }

  return {
    verdict,
    ...(reason ? { reason } : {})
  }
}

function parseGlobalPromotionResponse(rawText: string): GlobalPromotionResult {
  const parsed = extractJsonObject(rawText)
  if (!isPlainObject(parsed)) {
    return { shouldPromote: false, confidence: 'low', reason: 'invalid-json' }
  }

  const shouldPromote = coerceBoolean(parsed.shouldPromote)
  const confidence = parseConfidence(parsed.confidence)
  const reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : undefined

  return {
    shouldPromote,
    confidence,
    ...(reason ? { reason } : {})
  }
}

function coerceConflictVerdict(
  value: unknown
): { verdict: 'supersedes' | 'variant' | 'hallucination'; reason: string } | null {
  if (!isPlainObject(value)) return null
  const verdict = value.verdict
  const reason = typeof value.reason === 'string' ? value.reason.trim() : ''

  if (verdict !== 'supersedes' && verdict !== 'variant' && verdict !== 'hallucination') {
    return null
  }
  if (!reason) return null

  return { verdict, reason }
}

function parseVerdict(value: unknown): ContradictionResult['verdict'] {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_')
    if (normalized === 'keep_newer' || normalized === 'keep_older' || normalized === 'keep_both' || normalized === 'merge') {
      return normalized
    }
  }
  return 'keep_both'
}

function parseConfidence(value: unknown): 'high' | 'medium' | 'low' {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'high' || normalized === 'medium' || normalized === 'low') {
      return normalized
    }
  }
  return 'low'
}

export function isConfidenceSufficient(actual: string, minimum: string): boolean {
  const ranks = { low: 0, medium: 1, high: 2 }
  const actualRank = ranks[parseConfidence(actual)]
  const minimumRank = ranks[parseConfidence(minimum)]
  return actualRank >= minimumRank
}

// =============================================================================
// Warning Synthesis
// =============================================================================

export interface WarningCandidate {
  records: MemoryRecord[]
  totalFailures: number
}

export interface WarningSynthesisResult {
  warning: WarningRecord | null
  sourceRecordIds: string[]
  reason?: string
}

export type WarningSynthesisAction = {
  type: 'created' | 'skipped'
  warningId?: string
  avoid?: string
  sourceRecordIds: string[]
  reason?: string
}

export async function findWarningCandidates(
  minFailures: number = WARNING_SYNTHESIS_MIN_FAILURES,
  config: Config = DEFAULT_CONFIG
): Promise<WarningCandidate[]> {
  // Query high-failure records that haven't been synthesized into warnings yet
  const filter = `deprecated == false && failure_count >= ${minFailures} && type in ["command", "error"]`
  const records = await fetchRecords(filter, config, true)

  if (records.length === 0) return []

  // Group similar records by embedding similarity
  const candidates: WarningCandidate[] = []
  const processed = new Set<string>()

  for (const record of records) {
    if (processed.has(record.id)) continue
    if (!record.embedding || record.embedding.length !== EMBEDDING_DIM) continue

    // Find similar high-failure records
    const matches = await vectorSearchSimilar(
      record.embedding,
      {
        filter: buildFilter({
          type: record.type,
          project: record.project,
          excludeId: record.id,
          excludeDeprecated: true
        }),
        limit: 5,
        similarityThreshold: 0.8
      },
      config
    )

    const cluster = [record, ...matches.map(m => m.record).filter(r =>
      (r.failureCount ?? 0) >= minFailures && !processed.has(r.id)
    )]

    // Even single records with high failures can generate warnings
    const totalFailures = cluster.reduce((sum, r) => sum + (r.failureCount ?? 0), 0)
    candidates.push({ records: cluster, totalFailures })
    cluster.forEach(r => processed.add(r.id))
  }

  // Sort by total failures descending
  candidates.sort((a, b) => b.totalFailures - a.totalFailures)
  return candidates
}

export async function synthesizeWarning(
  candidate: WarningCandidate,
  config: Config = DEFAULT_CONFIG
): Promise<WarningSynthesisResult> {
  const client = await getAnthropicClient()
  if (!client) {
    throw new Error('No authentication available for warning synthesis.')
  }

  const sourceRecordIds = candidate.records.map(r => r.id)
  const payload = JSON.stringify({
    totalFailures: candidate.totalFailures,
    records: candidate.records.map(r => ({
      type: r.type,
      snippet: buildRecordSnippet(r),
      failureCount: r.failureCount ?? 0,
      resolution: (r as CommandRecord | ErrorRecord).resolution,
      project: r.project
    }))
  }, null, 2)

  const response = await client.messages.create({
    model: config.extraction.model,
    max_tokens: Math.min(WARNING_SYNTHESIS_MAX_TOKENS, config.extraction.maxTokens),
    temperature: 0,
    system: [
      { type: 'text', text: CLAUDE_CODE_SYSTEM_PROMPT },
      { type: 'text', text: WARNING_SYNTHESIS_PROMPT }
    ],
    messages: [{ role: 'user', content: `Failure records:\n${payload}` }],
    tools: [WARNING_SYNTHESIS_TOOL],
    tool_choice: { type: 'tool', name: WARNING_SYNTHESIS_TOOL_NAME }
  })

  const toolInput = response.content.find((block): block is ToolUseBlock =>
    isToolUseBlock(block) && block.name === WARNING_SYNTHESIS_TOOL_NAME
  )?.input

  if (!toolInput) {
    return { warning: null, sourceRecordIds, reason: 'no-tool-response' }
  }

  const parsed = toolInput as { warning: unknown }
  if (!parsed.warning || typeof parsed.warning !== 'object') {
    return { warning: null, sourceRecordIds, reason: 'no-pattern-found' }
  }

  const w = parsed.warning as Record<string, unknown>
  const avoid = typeof w.avoid === 'string' ? w.avoid.trim() : ''
  const useInstead = typeof w.useInstead === 'string' ? w.useInstead.trim() : ''
  const reason = typeof w.reason === 'string' ? w.reason.trim() : ''
  const severity = coerceSeverityValue(w.severity)

  if (!avoid || !useInstead || !reason || !severity) {
    return { warning: null, sourceRecordIds, reason: 'invalid-warning-fields' }
  }

  // Derive metadata from source records
  const firstRecord = candidate.records[0]
  const { randomUUID } = await import('crypto')
  const warning: WarningRecord = {
    id: randomUUID(),
    type: 'warning',
    avoid,
    useInstead,
    reason,
    severity,
    sourceRecordIds,
    synthesizedAt: Date.now(),
    project: firstRecord.project,
    domain: firstRecord.domain,
    scope: firstRecord.scope
  }

  return { warning, sourceRecordIds }
}

export async function runWarningSynthesis(
  dryRun: boolean,
  config: Config = DEFAULT_CONFIG
): Promise<{
  actions: WarningSynthesisAction[]
  summary: Record<string, number>
  candidates: MaintenanceCandidateGroup[]
}> {
  const { insertRecord } = await import('./milvus.js')
  const actions: WarningSynthesisAction[] = []
  const candidateGroups: MaintenanceCandidateGroup[] = []
  let candidates = 0
  let created = 0
  let skipped = 0
  let errors = 0

  const candidateList = await findWarningCandidates(WARNING_SYNTHESIS_MIN_FAILURES, config)
  candidates = candidateList.length
  if (candidateList.length > 0) {
    candidateGroups.push(...candidateList.map((candidate, index) => ({
      id: `warning-group-${index + 1}`,
      label: `Failure group ${index + 1}`,
      reason: `total failures: ${candidate.totalFailures}`,
      records: candidate.records.map(record => {
        const failureCount = record.failureCount ?? 0
        return buildCandidateRecord(record, `failures: ${failureCount}`, { failureCount })
      })
    })))
  }

  for (let i = 0; i < candidateList.length; i += WARNING_SYNTHESIS_BATCH_SIZE) {
    const batch = candidateList.slice(i, i + WARNING_SYNTHESIS_BATCH_SIZE)

    for (const candidate of batch) {
      try {
        const result = await synthesizeWarning(candidate, config)

        if (!result.warning) {
          skipped += 1
          actions.push({
            type: 'skipped',
            sourceRecordIds: result.sourceRecordIds,
            reason: result.reason
          })
          continue
        }

        if (dryRun) {
          created += 1
          actions.push({
            type: 'created',
            warningId: result.warning.id,
            avoid: result.warning.avoid,
            sourceRecordIds: result.sourceRecordIds
          })
        } else {
          await insertRecord(result.warning, config)
          created += 1
          actions.push({
            type: 'created',
            warningId: result.warning.id,
            avoid: result.warning.avoid,
            sourceRecordIds: result.sourceRecordIds
          })
        }
      } catch (error) {
        errors += 1
        console.error('[claude-memory] Warning synthesis failed:', error)
      }
    }
  }

  return { actions, summary: { candidates, created, skipped, errors }, candidates: candidateGroups }
}

function coerceSeverityValue(value: unknown): WarningSeverity | null {
  if (value === 'caution' || value === 'warning' || value === 'critical') return value
  return null
}

function filterGeneralizationUpdates(
  record: MemoryRecord,
  updates: Partial<MemoryRecord>
): Partial<MemoryRecord> {
  switch (record.type) {
    case 'command': {
      const filtered: Partial<CommandRecord> = {}
      const candidate = updates as Partial<CommandRecord>
      const command = maybeUpdateString(record.command, candidate.command)
      if (command) filtered.command = command

      const resolution = maybeUpdateString(record.resolution, candidate.resolution)
      if (resolution) filtered.resolution = resolution

      const truncatedOutput = maybeUpdateString(record.truncatedOutput, candidate.truncatedOutput)
      if (truncatedOutput) filtered.truncatedOutput = truncatedOutput

      return filtered as Partial<MemoryRecord>
    }
    case 'error': {
      const filtered: Partial<ErrorRecord> = {}
      const candidate = updates as Partial<ErrorRecord>
      const errorText = maybeUpdateString(record.errorText, candidate.errorText)
      if (errorText) filtered.errorText = errorText

      const cause = maybeUpdateString(record.cause, candidate.cause)
      if (cause) filtered.cause = cause

      const resolution = maybeUpdateString(record.resolution, candidate.resolution)
      if (resolution) filtered.resolution = resolution

      return filtered as Partial<MemoryRecord>
    }
    case 'discovery': {
      const filtered: Partial<DiscoveryRecord> = {}
      const candidate = updates as Partial<DiscoveryRecord>
      const what = maybeUpdateString(record.what, candidate.what)
      if (what) filtered.what = what

      const where = maybeUpdateString(record.where, candidate.where)
      if (where) filtered.where = where

      const evidence = maybeUpdateString(record.evidence, candidate.evidence)
      if (evidence) filtered.evidence = evidence

      return filtered as Partial<MemoryRecord>
    }
    case 'procedure': {
      const filtered: Partial<ProcedureRecord> = {}
      const candidate = updates as Partial<ProcedureRecord>
      const name = maybeUpdateString(record.name, candidate.name)
      if (name) filtered.name = name

      const steps = maybeUpdateStringArray(record.steps, candidate.steps)
      if (steps) filtered.steps = steps

      const prerequisites = maybeUpdateStringArray(record.prerequisites ?? [], candidate.prerequisites)
      if (prerequisites) filtered.prerequisites = prerequisites

      const verification = maybeUpdateString(record.verification, candidate.verification)
      if (verification) filtered.verification = verification

      return filtered as Partial<MemoryRecord>
    }
    case 'warning': {
      const filtered: Partial<WarningRecord> = {}
      const candidate = updates as Partial<WarningRecord>
      const avoid = maybeUpdateString(record.avoid, candidate.avoid)
      if (avoid) filtered.avoid = avoid

      const useInstead = maybeUpdateString(record.useInstead, candidate.useInstead)
      if (useInstead) filtered.useInstead = useInstead

      const reason = maybeUpdateString(record.reason, candidate.reason)
      if (reason) filtered.reason = reason

      return filtered as Partial<MemoryRecord>
    }
  }
}

function filterContradictionMerge(
  record: MemoryRecord,
  updates: Partial<MemoryRecord>
): Partial<MemoryRecord> {
  return filterGeneralizationUpdates(record, updates)
}

function maybeUpdateString(existing: string | undefined, candidate: unknown): string | undefined {
  if (typeof candidate !== 'string') return undefined
  const trimmed = candidate.trim()
  if (!trimmed) return undefined
  if (existing && trimmed === existing.trim()) return undefined
  return trimmed
}

function maybeUpdateStringArray(existing: string[], candidate: unknown): string[] | undefined {
  if (!Array.isArray(candidate)) return undefined
  const cleaned = candidate
    .map(entry => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(entry => entry.length > 0)
  if (cleaned.length === 0) return undefined

  const existingCleaned = existing
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0)
  if (areStringArraysEqual(existingCleaned, cleaned)) return undefined

  return cleaned
}

function areStringArraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function coerceBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true') return true
    if (normalized === 'false') return false
  }
  return false
}

function extractJsonObject(rawText: string): unknown {
  const start = rawText.indexOf('{')
  if (start === -1) return null

  let depth = 0
  for (let i = start; i < rawText.length; i += 1) {
    const char = rawText[i]
    if (char === '{') depth += 1
    if (char === '}') depth -= 1
    if (depth === 0) {
      const candidate = rawText.slice(start, i + 1)
      try {
        return JSON.parse(candidate) as unknown
      } catch {
        break
      }
    }
  }

  return null
}
