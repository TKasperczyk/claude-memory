import type Anthropic from '@anthropic-ai/sdk'
import { createHash } from 'crypto'
import { fetchRecordsByIds } from './milvus.js'
import { loadSettings, type MaintenanceSettings } from './settings.js'
import { DEFAULT_CONFIG, type Config, type MemoryRecord } from './types.js'
import {
  clampScore,
  coerceMaintenanceActionReviewItem,
  coerceSettingsRecommendation,
  parseReviewRating
} from './review-coercion.js'
import { asString, isPlainObject } from './parsing.js'
import { executeReview, executeReviewStreaming, type ThinkingCallback } from './review-framework.js'
import { buildRecordSnippet, truncateSnippet, truncateWithTail } from './shared.js'
import { safeStringify } from './json.js'
import type { MaintenanceReview, OperationResult, MaintenanceAction, MaintenanceCandidateGroup } from '../../shared/types.js'

export type { MaintenanceReview } from '../../shared/types.js'

const REVIEW_MODEL = 'claude-opus-4-5-20251101'
const REVIEW_TOOL_NAME = 'emit_maintenance_review'
const REVIEW_MAX_TOKENS = 6000
const REVIEW_MAX_ACTIONS = 50
const REVIEW_MAX_CANDIDATE_GROUPS = 30
const REVIEW_MAX_CANDIDATE_RECORDS = 30
const REVIEW_MAX_RECORDS = 100
const REVIEW_MAX_RECORD_DETAILS = 50
const REVIEW_MAX_ACTION_DIFF_CHARS = 8000

const OPERATION_PROMPTS: Record<string, string> = {
  'stale-check': 'This operation identifies records unused for 90+ days. Goal: Deprecate truly obsolete records while preserving valuable niche knowledge. Key question: Are deprecated records truly obsolete?',
  'stale-unused-deprecation': 'This operation deprecates old records that have never been used. Goal: Remove unused memories while preserving niche knowledge.',
  'low-usage': 'This operation deprecates records with poor usage ratios. Goal: Remove memories that consistently fail to help. Key question: Are these bad memories or valuable niche knowledge?',
  'low-usage-deprecation': 'This operation deprecates records with zero usage despite retrievals. Goal: Remove memories that never provide value.',
  'consolidation': 'This operation merges near-duplicate records. Goal: Reduce redundancy while keeping the best version. Key question: Were the right records kept?',
  'cross-type-consolidation': 'This operation merges highly similar records across different types. Goal: Keep the most actionable representative record. Key question: Did the chosen type and recency make sense?',
  'conflict-resolution': 'This operation resolves conflicts between new and existing records. Goal: Deprecate superseded knowledge. Key question: Are the LLM verdicts correct?',
  'warning-synthesis': 'This operation creates warning records from repeated failures. Goal: Extract actionable warnings. Key question: Are synthesized warnings useful?',
  'global-promotion': 'This operation elevates project-scoped records to global scope. Goal: Share universal knowledge. Key question: Are promoted records truly universal?',
  'promotion-suggestions': 'This operation generates CLAUDE.md and skill file suggestions. Goal: Surface high-value memories for documentation.'
}

const OPERATION_SETTINGS: Record<string, Array<keyof MaintenanceSettings>> = {
  'stale-check': ['staleDays', 'discoveryMaxAgeDays', 'procedureStepCheckCount'],
  'stale-unused-deprecation': ['staleUnusedDays'],
  'low-usage': ['lowUsageMinRetrievals', 'lowUsageRatioThreshold'],
  'low-usage-deprecation': ['lowUsageHighRetrievalMin'],
  'consolidation': [
    'consolidationThreshold',
    'consolidationSearchLimit',
    'consolidationMaxClusterSize',
    'consolidationRecheckDays'
  ],
  'cross-type-consolidation': [
    'crossTypeConsolidationThreshold',
    'consolidationSearchLimit',
    'consolidationMaxClusterSize',
    'consolidationRecheckDays'
  ],
  'conflict-resolution': ['conflictSimilarityThreshold', 'conflictCheckBatchSize'],
  'warning-synthesis': [
    'warningSynthesisMinFailures',
    'warningClusterSimilarityThreshold',
    'warningClusterLimit',
    'warningSynthesisBatchSize',
    'warningSynthesisRecheckDays'
  ],
  'global-promotion': [
    'globalPromotionMinSuccessCount',
    'globalPromotionMinUsageRatio',
    'globalPromotionMinRetrievalsForUsageRatio',
    'globalPromotionBatchSize',
    'globalPromotionRecheckDays'
  ],
  'promotion-suggestions': []
}

const REVIEW_SYSTEM_PROMPT = `You are reviewing a maintenance operation result.

Rules:
- Output ONLY via the tool call "${REVIEW_TOOL_NAME}" exactly once.
- Evaluate each action against the operation's goal.
- "correct" = action aligns with goal, "questionable" = uncertain/borderline, "incorrect" = action contradicts goal
- overallRating must be exactly one of: good, mixed, poor
- assessmentScore must be a 0-100 number
- Always include a concise summary string
- Consider whether settings thresholds are appropriate.
- Be concrete and specific in reasons.
`

const REVIEW_TOOL_DESCRIPTION = 'Emit a maintenance review with action verdicts, settings recommendations, and an overall rating.'
const REVIEW_TOOL_SCHEMA: Anthropic.Tool['input_schema'] = {
  type: 'object',
  additionalProperties: false,
  required: ['overallRating', 'assessmentScore', 'actionVerdicts', 'settingsRecommendations', 'summary'],
  properties: {
    resultId: { type: 'string' },
    operation: { type: 'string' },
    dryRun: { type: 'boolean' },
    reviewedAt: { type: 'number' },
    overallRating: { type: 'string', enum: ['good', 'mixed', 'poor'] },
    assessmentScore: { type: 'number', description: 'Assessment score from 0 to 100 (not 0-1)' },
    actionVerdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'snippet', 'verdict', 'reason'],
        properties: {
          recordId: { type: 'string' },
          action: { type: 'string', enum: ['deprecate', 'update', 'merge', 'promote', 'suggestion'] },
          snippet: { type: 'string' },
          verdict: { type: 'string', enum: ['correct', 'questionable', 'incorrect'] },
          reason: { type: 'string' }
        }
      }
    },
    settingsRecommendations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['setting', 'currentValue', 'recommendation', 'reason'],
        properties: {
          setting: { type: 'string' },
          currentValue: { type: ['string', 'number'] },
          recommendation: { type: 'string', enum: ['too_aggressive', 'too_lenient', 'appropriate'] },
          suggestedValue: { type: ['string', 'number'] },
          reason: { type: 'string' }
        }
      }
    },
    summary: { type: 'string' },
    model: { type: 'string' },
    durationMs: { type: 'number' }
  }
}

type ReviewPayload = {
  overallRating: MaintenanceReview['overallRating']
  assessmentScore: number
  actionVerdicts: MaintenanceReview['actionVerdicts']
  settingsRecommendations: MaintenanceReview['settingsRecommendations']
  summary: string
}

type MaintenanceReviewInput = {
  result: OperationResult
  records: MemoryRecord[]
  settings: MaintenanceSettings
}

export async function reviewMaintenanceResult(
  result: OperationResult,
  config: Config = DEFAULT_CONFIG
): Promise<MaintenanceReview> {
  const startTime = Date.now()
  const { input, resultId } = await buildMaintenanceReviewInput(result, config)
  const { payload, reviewedAt, model, durationMs } = await executeReview(input, {
    toolName: REVIEW_TOOL_NAME,
    toolDescription: REVIEW_TOOL_DESCRIPTION,
    toolSchema: REVIEW_TOOL_SCHEMA,
    maxTokens: REVIEW_MAX_TOKENS,
    systemPrompt: REVIEW_SYSTEM_PROMPT,
    model: REVIEW_MODEL,
    buildPrompt: buildMaintenanceReviewPrompt,
    coercePayload: coerceReviewPayload,
    authErrorMessage: 'No authentication available for maintenance review. Set ANTHROPIC_API_KEY or run kira login.',
    startedAt: startTime,
    onInvalidPayload: toolInput => {
      const issues = describeReviewPayloadIssues(toolInput)
      const snapshot = truncateWithTail(safeStringify(toolInput), 2000)
      console.error('[claude-memory] Maintenance review payload invalid:', { issues, input: snapshot })
    }
  }, config)

  return {
    resultId,
    operation: result.operation,
    dryRun: result.dryRun,
    reviewedAt,
    overallRating: payload.overallRating,
    assessmentScore: payload.assessmentScore,
    actionVerdicts: payload.actionVerdicts,
    settingsRecommendations: payload.settingsRecommendations,
    summary: payload.summary,
    model,
    durationMs
  }
}

export async function reviewMaintenanceResultStreaming(
  result: OperationResult,
  config: Config,
  onThinking: ThinkingCallback,
  abortSignal?: AbortSignal
): Promise<MaintenanceReview> {
  const startTime = Date.now()
  const { input, resultId } = await buildMaintenanceReviewInput(result, config)
  const { payload, reviewedAt, model, durationMs } = await executeReviewStreaming(input, {
    toolName: REVIEW_TOOL_NAME,
    toolDescription: REVIEW_TOOL_DESCRIPTION,
    toolSchema: REVIEW_TOOL_SCHEMA,
    maxTokens: REVIEW_MAX_TOKENS,
    systemPrompt: REVIEW_SYSTEM_PROMPT,
    model: REVIEW_MODEL,
    buildPrompt: buildMaintenanceReviewPrompt,
    coercePayload: coerceReviewPayload,
    authErrorMessage: 'No authentication available for maintenance review. Set ANTHROPIC_API_KEY or run kira login.',
    startedAt: startTime,
    onInvalidPayload: toolInput => {
      const issues = describeReviewPayloadIssues(toolInput)
      const snapshot = truncateWithTail(safeStringify(toolInput), 2000)
      console.error('[claude-memory] Maintenance review payload invalid:', { issues, input: snapshot })
    }
  }, config, onThinking, abortSignal)

  return {
    resultId,
    operation: result.operation,
    dryRun: result.dryRun,
    reviewedAt,
    overallRating: payload.overallRating,
    assessmentScore: payload.assessmentScore,
    actionVerdicts: payload.actionVerdicts,
    settingsRecommendations: payload.settingsRecommendations,
    summary: payload.summary,
    model,
    durationMs
  }
}

async function buildMaintenanceReviewInput(
  result: OperationResult,
  config: Config
): Promise<{ input: MaintenanceReviewInput; resultId: string }> {
  const resultId = buildResultId(result)
  const settings = loadSettings()

  const recordIds = collectRecordIds(result)
  let records: MemoryRecord[] = []
  if (recordIds.length > 0) {
    try {
      records = await fetchRecordsByIds(recordIds, config)
    } catch (error) {
      console.error('[claude-memory] Failed to fetch maintenance records for review:', error)
    }
  }

  return {
    input: {
      result,
      records,
      settings
    },
    resultId
  }
}

export function buildResultId(result: OperationResult): string {
  const actionIds = result.actions.map(action => action.recordId).filter(Boolean).join(',')
  const candidateIds = result.candidates
    .map(group => {
      const recordIds = group.records.map(record => record.id).filter(Boolean).join(',')
      return `${group.id}:${recordIds}`
    })
    .join('|')
  const payload = [
    result.operation,
    String(result.dryRun),
    JSON.stringify(result.summary),
    actionIds,
    candidateIds
  ].join('|')
  return createHash('sha256').update(payload).digest('hex').slice(0, 16)
}

function collectRecordIds(result: OperationResult): string[] {
  const recordIds = new Set<string>()

  for (const action of result.actions) {
    if (action.recordId) recordIds.add(action.recordId)

    if (!isPlainObject(action.details)) continue
    const details = action.details

    const keptId = asString(details.keptId)
    if (keptId) recordIds.add(keptId)

    const candidateId = asString(details.candidateId)
    if (candidateId) recordIds.add(candidateId)

    const existingId = asString(details.existingId)
    if (existingId) recordIds.add(existingId)

    if (Array.isArray(details.deprecatedIds)) {
      for (const id of details.deprecatedIds) {
        if (typeof id === 'string' && id.trim()) recordIds.add(id)
      }
    }
  }

  for (const group of result.candidates) {
    for (const record of group.records) {
      if (record.id) recordIds.add(record.id)
    }
  }

  return Array.from(recordIds)
}

function buildMaintenanceReviewPrompt(input: {
  result: OperationResult
  records: MemoryRecord[]
  settings: MaintenanceSettings
}): string {
  const { result, records, settings } = input
  const actionPayload = result.actions.slice(0, REVIEW_MAX_ACTIONS).map(formatReviewAction)
  const actionOverflow = Math.max(0, result.actions.length - actionPayload.length)
  const candidatePayload = result.candidates
    .slice(0, REVIEW_MAX_CANDIDATE_GROUPS)
    .map(formatCandidateGroup)
  const candidateOverflow = Math.max(0, result.candidates.length - candidatePayload.length)
  const recordPayload = records
    .slice(0, REVIEW_MAX_RECORDS)
    .map((record, index) =>
      index < REVIEW_MAX_RECORD_DETAILS ? formatReviewRecord(record) : formatReviewRecordSnippet(record)
    )
  const recordOverflow = Math.max(0, records.length - recordPayload.length)
  const recordSnippetCount = Math.max(0, recordPayload.length - Math.min(recordPayload.length, REVIEW_MAX_RECORD_DETAILS))
  const operationPrompt = result.operation === 'stale-check'
    ? `This operation identifies records unused for ${settings.staleDays}+ days. Goal: Deprecate truly obsolete records while preserving valuable niche knowledge. Key question: Are deprecated records truly obsolete?`
    : OPERATION_PROMPTS[result.operation] ?? 'Review this maintenance operation result.'

  const settingsKeys = OPERATION_SETTINGS[result.operation] ?? []
  const settingsPayload = settingsKeys.map(setting => ({
    setting,
    value: settings[setting] ?? null
  }))

  const recordIds = collectRecordIds(result)
  const recordMap = new Map(records.map(record => [record.id, record]))
  const missingRecordIds = recordIds.filter(id => !recordMap.has(id))

  return `Maintenance operation:
- operation: ${result.operation}
- dry_run: ${result.dryRun}
- duration_ms: ${result.duration}
- error: ${result.error ?? 'none'}

Operation goal:
${operationPrompt}

Relevant settings (JSON):
${JSON.stringify(settingsPayload, null, 2)}

Summary metrics (JSON):
${JSON.stringify(result.summary, null, 2)}

Actions (JSON):
${JSON.stringify(actionPayload, null, 2)}
Actions omitted: ${actionOverflow}

Candidate groups (JSON):
${JSON.stringify(candidatePayload, null, 2)}
Candidate groups omitted: ${candidateOverflow}

Records (JSON):
${JSON.stringify(recordPayload, null, 2)}
Record snippets: ${recordSnippetCount}
Records omitted: ${recordOverflow}

Missing record IDs (JSON):
${JSON.stringify(missingRecordIds, null, 2)}
`
}

function formatReviewAction(action: MaintenanceAction): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    action: action.type,
    snippet: action.snippet,
    reason: action.reason
  }

  if (action.recordId) payload.recordId = action.recordId
  if (action.details) {
    const details = { ...action.details }
    if (typeof details.diff === 'string') {
      details.diff = truncateWithTail(details.diff, REVIEW_MAX_ACTION_DIFF_CHARS)
    }
    payload.details = details
  }

  return payload
}

function formatCandidateGroup(group: MaintenanceCandidateGroup): Record<string, unknown> {
  const records = group.records.slice(0, REVIEW_MAX_CANDIDATE_RECORDS)
  const omittedRecords = Math.max(0, group.records.length - records.length)
  const payload: Record<string, unknown> = {
    id: group.id,
    label: group.label,
    reason: group.reason,
    records: records.map(record => ({
      id: record.id,
      type: record.type,
      snippet: record.snippet,
      reason: record.reason,
      details: record.details
    }))
  }
  if (omittedRecords > 0) payload.omittedRecords = omittedRecords
  return payload
}

function formatReviewRecordSnippet(record: MemoryRecord): Record<string, unknown> {
  return {
    id: record.id,
    type: record.type,
    summary: truncateSnippet(buildRecordSnippet(record), 160),
    scope: record.scope,
    project: record.project,
    domain: record.domain,
    truncated: true
  }
}

function formatReviewRecord(record: MemoryRecord): Record<string, unknown> {
  const base = {
    id: record.id,
    type: record.type,
    summary: truncateSnippet(buildRecordSnippet(record), 160),
    scope: record.scope,
    project: record.project,
    domain: record.domain,
    timestamp: record.timestamp,
    lastUsed: record.lastUsed,
    retrievalCount: record.retrievalCount,
    usageCount: record.usageCount,
    successCount: record.successCount,
    failureCount: record.failureCount,
    deprecated: record.deprecated,
    generalized: record.generalized,
    lastGeneralizationCheck: record.lastGeneralizationCheck,
    lastGlobalCheck: record.lastGlobalCheck,
    lastConsolidationCheck: record.lastConsolidationCheck,
    lastConflictCheck: record.lastConflictCheck,
    lastWarningSynthesisCheck: record.lastWarningSynthesisCheck
  }

  switch (record.type) {
    case 'command':
      return {
        ...base,
        command: record.command,
        exitCode: record.exitCode,
        outcome: record.outcome,
        truncatedOutput: record.truncatedOutput,
        resolution: record.resolution,
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

function coerceReviewPayload(input: unknown): ReviewPayload | null {
  if (!isPlainObject(input)) return null
  const record = input

  const overallRating = parseReviewRating(record.overallRating ?? record.overallAssessment)
  const assessmentScore = parseAssessmentScore(record.assessmentScore)
  const summary = coerceSummary(record.summary)

  const actionVerdicts = Array.isArray(record.actionVerdicts)
    ? record.actionVerdicts
      .map(coerceMaintenanceActionReviewItem)
      .filter((item): item is MaintenanceReview['actionVerdicts'][number] => Boolean(item))
    : []

  const settingsRecommendations = Array.isArray(record.settingsRecommendations)
    ? record.settingsRecommendations
      .map(coerceSettingsRecommendation)
      .filter((item): item is MaintenanceReview['settingsRecommendations'][number] => Boolean(item))
    : []

  if (!overallRating || assessmentScore === null) return null

  return {
    overallRating,
    assessmentScore,
    actionVerdicts,
    settingsRecommendations,
    summary: summary || ''
  }
}

function parseAssessmentScore(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return clampScore(value)
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const trimmed = value.trim()
    const parsed = Number(trimmed)
    if (Number.isFinite(parsed)) return clampScore(parsed)
    const match = trimmed.match(/-?\d+(\.\d+)?/)
    if (match) {
      const extracted = Number(match[0])
      if (Number.isFinite(extracted)) return clampScore(extracted)
    }
  }
  return null
}

function coerceSummary(value: unknown): string {
  const summary = asString(value)?.trim()
  if (summary) return summary

  if (Array.isArray(value)) {
    const parts = value.map(entry => asString(entry)?.trim()).filter(Boolean)
    if (parts.length > 0) return parts.join('\n')
  }

  if (isPlainObject(value)) {
    const text = asString(value.text)?.trim()
    if (text) return text
  }

  return ''
}

function describeReviewPayloadIssues(input: unknown): string[] {
  if (!isPlainObject(input)) return ['tool input is not an object']

  const issues: string[] = []
  const overallRating = input.overallRating ?? input.overallAssessment
  if (!parseReviewRating(overallRating)) {
    issues.push(`overallRating invalid: ${safeStringify(overallRating)}`)
  }
  if (parseAssessmentScore(input.assessmentScore) === null) {
    issues.push(`assessmentScore invalid: ${safeStringify(input.assessmentScore)}`)
  }
  if (!coerceSummary(input.summary)) {
    issues.push('summary missing or empty')
  }

  return issues.length ? issues : ['unknown validation failure']
}
