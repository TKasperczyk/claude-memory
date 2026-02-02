import { type RowData } from '@zilliz/milvus2-sdk-node'
import { embed, ensureEmbeddingDim } from './embed.js'
import { buildExactText } from './shared.js'
import {
  CONTENT_MAX_LENGTH,
  EXACT_TEXT_MAX_LENGTH,
  SOURCE_EXCERPT_MAX_LENGTH,
  SOURCE_SESSION_ID_MAX_LENGTH
} from './milvus-schema.js'
import {
  type Config,
  type MemoryRecord,
  type RecordType
} from './types.js'
import { isValidConfidence, isValidOutcome, isValidSeverity, normalizeScope } from './parsing.js'

export async function buildMilvusRow(record: MemoryRecord, config: Config): Promise<RowData> {
  const normalized = normalizeRecord(record)
  const content = serializeRecord(normalized)
  if (content.length > CONTENT_MAX_LENGTH) {
    throw new Error(`Record content exceeds ${CONTENT_MAX_LENGTH} chars (id: ${normalized.id})`)
  }

  const exactTextRaw = buildExactText(normalized)
  const exactText = truncateString(exactTextRaw, EXACT_TEXT_MAX_LENGTH)
  const sourceSessionId = normalizeOptionalString(normalized.sourceSessionId)
  const sourceExcerpt = normalizeOptionalString(normalized.sourceExcerpt)

  const embedding = normalized.embedding
    ?? await embed(buildEmbeddingInput(normalized, exactTextRaw, content), config)
  ensureEmbeddingDim(embedding)

  return {
    id: normalized.id,
    type: normalized.type,
    content,
    exact_text: exactText,
    project: normalized.project ?? '',
    scope: normalized.scope,
    domain: normalized.domain ?? '',
    timestamp: toInt64(normalized.timestamp, Date.now()),
    success_count: toInt64(normalized.successCount, 0),
    failure_count: toInt64(normalized.failureCount, 0),
    retrieval_count: toInt64(normalized.retrievalCount, 0),
    usage_count: toInt64(normalized.usageCount, 0),
    last_used: toInt64(normalized.lastUsed, normalized.timestamp ?? Date.now()),
    deprecated: Boolean(normalized.deprecated),
    generalized: Boolean(normalized.generalized),
    last_generalization_check: toInt64(normalized.lastGeneralizationCheck, 0),
    last_global_check: toInt64(normalized.lastGlobalCheck, 0),
    last_consolidation_check: toInt64(normalized.lastConsolidationCheck, 0),
    last_conflict_check: toInt64(normalized.lastConflictCheck, 0),
    last_warning_synthesis_check: toInt64(normalized.lastWarningSynthesisCheck, 0),
    source_session_id: sourceSessionId ? truncateString(sourceSessionId, SOURCE_SESSION_ID_MAX_LENGTH) : null,
    source_excerpt: sourceExcerpt ? truncateString(sourceExcerpt, SOURCE_EXCERPT_MAX_LENGTH) : null,
    embedding
  }
}

export function buildEmbeddingInput(
  record: MemoryRecord,
  exactTextRaw?: string,
  content?: string
): string {
  const exactText = (exactTextRaw ?? buildExactText(record)).trim()
  const supplemental = buildSupplementalEmbeddingText(record)
  const combined = [exactText, supplemental].filter(part => part && part.length > 0).join('\n').trim()
  if (combined.length > 0) return combined
  return content ?? serializeRecord(record)
}

export function parseRecordFromRow(row: Record<string, unknown>): MemoryRecord | null {
  let parsed: Partial<MemoryRecord> = {}

  if (typeof row.content === 'string') {
    try {
      parsed = JSON.parse(row.content) as Partial<MemoryRecord>
    } catch (error) {
      console.error('[claude-memory] Failed to parse record content:', error)
    }
  }

  const rawType = row.type ?? parsed.type
  if (!isRecordType(rawType)) {
    console.error('[claude-memory] Record type missing or invalid in stored row.')
    return null
  }

  const idValue = row.id ?? parsed.id
  if (!isNonEmptyString(idValue)) {
    console.error('[claude-memory] Record id missing in stored row.')
    return null
  }

  const record = {
    ...parsed,
    id: idValue,
    type: rawType,
    project: (row.project as string | undefined) ?? parsed.project,
    scope: normalizeScope(row.scope ?? parsed.scope),
    domain: (row.domain as string | undefined) ?? parsed.domain,
    timestamp: toInt64((row.timestamp as number | string | undefined) ?? parsed.timestamp, 0),
    successCount: toInt64((row.success_count as number | string | undefined) ?? parsed.successCount, 0),
    failureCount: toInt64((row.failure_count as number | string | undefined) ?? parsed.failureCount, 0),
    retrievalCount: toInt64((row.retrieval_count as number | string | undefined) ?? parsed.retrievalCount, 0),
    usageCount: toInt64((row.usage_count as number | string | undefined) ?? parsed.usageCount, 0),
    lastUsed: toInt64((row.last_used as number | string | undefined) ?? parsed.lastUsed, 0),
    deprecated: toBoolean(row.deprecated ?? parsed.deprecated, false),
    generalized: toBoolean(row.generalized ?? parsed.generalized, false),
    lastGeneralizationCheck: toInt64(
      (row.last_generalization_check as number | string | undefined) ?? parsed.lastGeneralizationCheck,
      0
    ),
    lastGlobalCheck: toInt64(
      (row.last_global_check as number | string | undefined) ?? parsed.lastGlobalCheck,
      0
    ),
    lastConsolidationCheck: toInt64(
      (row.last_consolidation_check as number | string | undefined) ?? parsed.lastConsolidationCheck,
      0
    ),
    lastConflictCheck: toInt64(
      (row.last_conflict_check as number | string | undefined) ?? parsed.lastConflictCheck,
      0
    ),
    lastWarningSynthesisCheck: toInt64(
      (row.last_warning_synthesis_check as number | string | undefined) ?? parsed.lastWarningSynthesisCheck,
      0
    ),
    sourceSessionId: coerceOptionalString(row.source_session_id) ?? parsed.sourceSessionId,
    sourceExcerpt: coerceOptionalString(row.source_excerpt) ?? parsed.sourceExcerpt
  } as MemoryRecord

  if (!isValidRecord(record)) {
    console.error(`[claude-memory] Invalid record; skipping id=${record.id} type=${record.type}`)
    return null
  }

  if (Array.isArray(row.embedding)) {
    record.embedding = row.embedding as number[]
  }

  return record
}

export function mergeRecords(existing: MemoryRecord, updates: Partial<MemoryRecord>): MemoryRecord {
  const merged = { ...existing, ...updates } as MemoryRecord

  // Only merge context for types that have it (command, error, procedure - not discovery or warning)
  if (existing.type !== 'discovery' && existing.type !== 'warning' && 'context' in updates && updates.context) {
    const mergedWithContext = merged as Exclude<MemoryRecord, { type: 'discovery' } | { type: 'warning' }>
    mergedWithContext.context = {
      ...existing.context,
      ...(updates.context as typeof existing.context)
    }
  }

  return merged
}

export function needsEmbeddingRefresh(existing: MemoryRecord, updated: MemoryRecord): boolean {
  return buildEmbeddingInput(existing) !== buildEmbeddingInput(updated)
}

export function resolveProject(record: MemoryRecord): string | undefined {
  if (record.project) return record.project
  if ('context' in record && record.context && 'project' in record.context) {
    return record.context.project
  }
  return undefined
}

export function resolveDomain(record: MemoryRecord): string | undefined {
  if (record.domain) return record.domain
  if (record.type === 'procedure') return record.context.domain
  return undefined
}

function normalizeRecord(record: MemoryRecord): MemoryRecord {
  const project = record.project ?? resolveProject(record)
  const domain = record.domain ?? resolveDomain(record)
  const scope = normalizeScope(record.scope)
  const timestamp = toInt64(record.timestamp, Date.now())
  const successCount = toInt64(record.successCount, 0)
  const failureCount = toInt64(record.failureCount, 0)
  const retrievalCount = toInt64(record.retrievalCount, 0)
  const usageCount = toInt64(record.usageCount, 0)
  const lastUsed = toInt64(record.lastUsed, timestamp)
  const deprecated = Boolean(record.deprecated ?? false)
  const generalized = toBoolean(record.generalized, false)
  const lastGeneralizationCheck = toInt64(record.lastGeneralizationCheck, 0)
  const lastGlobalCheck = toInt64(record.lastGlobalCheck, 0)
  const lastConsolidationCheck = toInt64(record.lastConsolidationCheck, 0)
  const lastConflictCheck = toInt64(record.lastConflictCheck, 0)

  return {
    ...record,
    project,
    scope,
    domain,
    timestamp,
    successCount,
    failureCount,
    retrievalCount,
    usageCount,
    lastUsed,
    deprecated,
    generalized,
    lastGeneralizationCheck,
    lastGlobalCheck,
    lastConsolidationCheck,
    lastConflictCheck
  }
}

function buildSupplementalEmbeddingText(record: MemoryRecord): string | undefined {
  switch (record.type) {
    case 'command':
      return joinEmbeddingParts([record.resolution])
    case 'error':
      return joinEmbeddingParts([record.cause, record.resolution])
    case 'discovery':
      return joinEmbeddingParts([record.evidence])
    case 'procedure':
      return joinEmbeddingParts([record.prerequisites?.join('\n'), record.verification])
    case 'warning':
      return undefined
  }
}

function joinEmbeddingParts(parts: Array<string | undefined>): string | undefined {
  const filtered = parts
    .map(part => (typeof part === 'string' ? part.trim() : ''))
    .filter(part => part.length > 0)
  return filtered.length > 0 ? filtered.join('\n') : undefined
}

function serializeRecord(record: MemoryRecord): string {
  const { embedding: _embedding, ...rest } = record as MemoryRecord & { embedding?: number[] }
  return JSON.stringify(rest)
}

function truncateString(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return value.slice(0, maxLength)
}

function toInt64(value: number | string | undefined, fallback: number): number {
  if (typeof value === 'number' && !Number.isNaN(value)) return Math.trunc(value)
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (!Number.isNaN(parsed)) return Math.trunc(parsed)
  }
  return Math.trunc(fallback)
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true') return true
    if (normalized === 'false') return false
  }
  return fallback
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function isRecordType(value: unknown): value is RecordType {
  return value === 'command'
    || value === 'error'
    || value === 'discovery'
    || value === 'procedure'
    || value === 'warning'
}

function coerceOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string')
}

function isValidRecord(record: MemoryRecord): boolean {
  if (!isNonEmptyString(record.id)) return false

  switch (record.type) {
    case 'command':
      return isNonEmptyString(record.command)
        && typeof record.exitCode === 'number'
        && !Number.isNaN(record.exitCode)
        && isValidOutcome(record.outcome)
        && isPlainObject(record.context)
    case 'error':
      return isNonEmptyString(record.errorText)
        && isNonEmptyString(record.errorType)
        && isNonEmptyString(record.resolution)
        && isPlainObject(record.context)
    case 'discovery':
      return isNonEmptyString(record.what)
        && isNonEmptyString(record.where)
        && isNonEmptyString(record.evidence)
        && isValidConfidence(record.confidence)
    case 'procedure':
      return isNonEmptyString(record.name)
        && isStringArray(record.steps)
        && record.steps.some(step => step.trim().length > 0)
        && isPlainObject(record.context)
    case 'warning':
      return isNonEmptyString(record.avoid)
        && isNonEmptyString(record.useInstead)
        && isNonEmptyString(record.reason)
        && isValidSeverity(record.severity)
  }

  return false
}
