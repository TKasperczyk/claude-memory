import { CLAUDE_CODE_SYSTEM_PROMPT } from '../anthropic.js'
import { embed } from '../embed.js'
import {
  DEFAULT_CONFIG,
  EMBEDDING_DIM,
  type CommandRecord,
  type Config,
  type DiscoveryRecord,
  type ErrorRecord,
  type MemoryRecord,
  type ProcedureRecord,
  type WarningRecord,
  type WarningSeverity
} from '../types.js'
import type { MaintenanceCandidateGroup } from '../../../shared/types.js'
import { buildEmbeddingInput, buildFilter, updateRecord, vectorSearchSimilar } from '../milvus.js'
import { resolveMaintenanceSettings, type MaintenanceSettings } from '../settings.js'
import { isPlainObject, isToolUseBlock, type ToolUseBlock } from '../parsing.js'
import { buildCandidateRecord, buildRecordSnippet, truncateSnippet } from '../shared.js'
import {
  GENERALIZATION_MAX_TOKENS,
  GENERALIZATION_PROMPT,
  GLOBAL_PROMOTION_MAX_TOKENS,
  GLOBAL_PROMOTION_PROMPT,
  WARNING_SYNTHESIS_MAX_TOKENS,
  WARNING_SYNTHESIS_PROMPT,
  WARNING_SYNTHESIS_TOOL,
  WARNING_SYNTHESIS_TOOL_NAME,
  buildGeneralizationInput,
  coerceBoolean,
  extractJsonObject,
  extractResponseText,
  getAnthropicClient
} from './prompts.js'
import { fetchRecords } from './scans.js'

export const GLOBAL_PROMOTION_MIN_CONFIDENCE = 'medium'

// Warning synthesis constants
const WARNING_SYNTHESIS_MIN_FAILURES = 2
const WARNING_SYNTHESIS_BATCH_SIZE = 15
const WARNING_SYNTHESIS_DEDUP_THRESHOLD = 0.9

interface GeneralizationResult {
  shouldGeneralize: boolean
  generalizedRecord?: Partial<MemoryRecord>
  reason?: string
}

interface GlobalPromotionResult {
  shouldPromote: boolean
  confidence: 'high' | 'medium' | 'low'
  reason?: string
}

export async function markDeprecated(id: string, config: Config = DEFAULT_CONFIG): Promise<boolean> {
  return updateRecord(id, { deprecated: true }, config)
}

export async function promoteToGlobal(id: string, config: Config = DEFAULT_CONFIG): Promise<boolean> {
  return updateRecord(id, { scope: 'global' }, config)
}

async function checkGeneralization(
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

async function generalizeRecord(
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

interface WarningCandidate {
  records: MemoryRecord[]
  totalFailures: number
}

interface WarningSynthesisResult {
  warning: WarningRecord | null
  sourceRecordIds: string[]
  reason?: string
}

type WarningSynthesisAction = {
  type: 'update'
  recordId?: string
  snippet: string
  reason: string
  details?: {
    sourceRecordIds: string[]
  }
}

async function findWarningCandidates(
  minFailures: number | undefined = undefined,
  config: Config = DEFAULT_CONFIG,
  settings?: MaintenanceSettings
): Promise<WarningCandidate[]> {
  const maintenance = resolveMaintenanceSettings(settings)
  const resolvedMinFailures = typeof minFailures === 'number'
    ? minFailures
    : maintenance.warningSynthesisMinFailures

  // Only consider records not recently checked for warning synthesis
  const recheckCutoff = Date.now() - maintenance.warningSynthesisRecheckDays * 24 * 60 * 60 * 1000
  const recheckCutoffValue = Math.trunc(recheckCutoff)

  // Query high-failure records and filter in code to include null/zero check timestamps.
  const filter = `deprecated == false && failure_count >= ${resolvedMinFailures} && type in ["command", "error"]`
  const records = await fetchRecords(filter, config, true)
  const eligible = records.filter(record => {
    const lastCheck = record.lastWarningSynthesisCheck ?? 0
    return lastCheck === 0 || lastCheck < recheckCutoffValue
  })

  if (eligible.length === 0) return []

  // Group similar records by embedding similarity
  const candidates: WarningCandidate[] = []
  const processed = new Set<string>()

  for (const record of eligible) {
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
        limit: maintenance.warningClusterLimit,
        similarityThreshold: maintenance.warningClusterSimilarityThreshold
      },
      config
    )

    const cluster = [record, ...matches.map(m => m.record).filter(r =>
      (r.failureCount ?? 0) >= resolvedMinFailures && !processed.has(r.id)
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

async function synthesizeWarning(
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
    scope: firstRecord.scope
  }

  return { warning, sourceRecordIds }
}

async function findSimilarWarning(
  warning: WarningRecord,
  config: Config = DEFAULT_CONFIG,
  threshold: number = WARNING_SYNTHESIS_DEDUP_THRESHOLD
): Promise<{ record: WarningRecord; similarity: number } | null> {
  const embedding = warning.embedding ?? await embed(buildEmbeddingInput(warning), config)
  warning.embedding = embedding

  const filter = buildFilter({
    project: warning.project,
    type: 'warning',
    includeGlobal: true,
    excludeDeprecated: true
  })

  const matches = await vectorSearchSimilar(
    embedding,
    {
      filter,
      limit: 1,
      similarityThreshold: threshold
    },
    config
  )

  const match = matches[0]
  if (!match || match.record.type !== 'warning') return null
  return { record: match.record as WarningRecord, similarity: match.similarity }
}

async function markWarningSynthesisSources(
  sourceRecordIds: string[],
  checkedAt: number,
  config: Config
): Promise<string[]> {
  const failedIds: string[] = []

  for (const sourceId of sourceRecordIds) {
    try {
      const updated = await updateRecord(sourceId, { lastWarningSynthesisCheck: checkedAt }, config)
      if (!updated) failedIds.push(sourceId)
    } catch (error) {
      failedIds.push(sourceId)
      console.error(`[claude-memory] Failed to mark warning synthesis check for ${sourceId}:`, error)
    }
  }

  return failedIds
}

export async function runWarningSynthesis(
  dryRun: boolean,
  config: Config = DEFAULT_CONFIG,
  settings?: MaintenanceSettings
): Promise<{
  actions: WarningSynthesisAction[]
  summary: Record<string, number>
  candidates: MaintenanceCandidateGroup[]
}> {
  const maintenance = resolveMaintenanceSettings(settings)
  const { insertRecord } = await import('../milvus.js')
  const actions: WarningSynthesisAction[] = []
  const candidateGroups: MaintenanceCandidateGroup[] = []
  let candidates = 0
  let created = 0
  let skipped = 0
  let errors = 0

  const candidateList = await findWarningCandidates(undefined, config, maintenance)
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

  for (let i = 0; i < candidateList.length; i += maintenance.warningSynthesisBatchSize) {
    const batch = candidateList.slice(i, i + maintenance.warningSynthesisBatchSize)

    for (const candidate of batch) {
      try {
        const result = await synthesizeWarning(candidate, config)

        if (!dryRun) {
          const checkedAt = Date.now()
          const failedIds = await markWarningSynthesisSources(result.sourceRecordIds, checkedAt, config)
          if (failedIds.length > 0) {
            errors += 1
            actions.push({
              type: 'update',
              snippet: truncateSnippet(result.sourceRecordIds.join(', ')),
              reason: `skipped: failed to mark ${failedIds.length} source record${failedIds.length === 1 ? '' : 's'}`,
              details: { sourceRecordIds: result.sourceRecordIds }
            })
            continue
          }
        }

        if (!result.warning) {
          skipped += 1
          actions.push({
            type: 'update',
            snippet: truncateSnippet(result.sourceRecordIds.join(', ')),
            reason: `skipped: ${result.reason ?? 'no warning generated'}`,
            details: { sourceRecordIds: result.sourceRecordIds }
          })
          continue
        }

        const duplicate = await findSimilarWarning(result.warning, config)
        if (duplicate) {
          const percent = Math.round(duplicate.similarity * 100)
          skipped += 1
          actions.push({
            type: 'update',
            snippet: truncateSnippet(result.warning.avoid),
            reason: `skipped: similar warning exists (${percent}%)`,
            details: { sourceRecordIds: result.sourceRecordIds }
          })
          continue
        }

        if (dryRun) {
          created += 1
          actions.push({
            type: 'update',
            // No recordId in dry run - the warning wasn't actually inserted
            snippet: truncateSnippet(result.warning.avoid),
            reason: `warning: ${result.warning.avoid}`,
            details: { sourceRecordIds: result.sourceRecordIds }
          })
        } else {
          await insertRecord(result.warning, config)
          created += 1
          actions.push({
            type: 'update',
            recordId: result.warning.id,
            snippet: truncateSnippet(result.warning.avoid),
            reason: `warning: ${result.warning.avoid}`,
            details: { sourceRecordIds: result.sourceRecordIds }
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

export function filterContradictionMerge(
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
