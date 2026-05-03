import { randomUUID } from 'crypto'
import type Anthropic from '@anthropic-ai/sdk'
import {
  hybridSearch,
  insertRecord,
  updateRecord,
  deleteRecord,
  getRecord
} from '../../../src/lib/lancedb.js'
import { markDeprecated } from '../../../src/lib/maintenance/operations.js'
import { paginateExtractionRuns, loadExtractionRunDetail } from '../../../src/lib/extraction-query.js'
import {
  asBoolean,
  asConfidence,
  asNumber,
  asOutcome,
  asRecordType,
  asScope,
  asSeverity,
  asStringArray,
  asTrimmedString
} from '../../../src/lib/parsing.js'
import type { Config, MemoryRecord, RecordType } from '../../../src/lib/types.js'
import type { ExtractionReview, ExtractionRun, HybridSearchResult } from '../../../shared/types.js'
import { parseNonNegativeInt } from '../utils/params.js'

export type ChatToolName = 'search_memories' | 'create_memory' | 'update_memory' | 'delete_memories' | 'list_extractions' | 'get_extraction'

const MAX_SEARCH_LIMIT = 50
const DEFAULT_SEARCH_LIMIT = 8

const SEARCH_TOOL_SCHEMA: Anthropic.Tool['input_schema'] = {
  type: 'object',
  additionalProperties: false,
  required: ['query'],
  properties: {
    query: { type: 'string', description: 'Search query for memory retrieval.' },
    min_similarity: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description: 'Minimum cosine similarity threshold (0 to 1).'
    },
    limit: {
      type: 'number',
      minimum: 1,
      maximum: MAX_SEARCH_LIMIT,
      description: `Maximum number of results (1-${MAX_SEARCH_LIMIT}).`
    },
    offset: {
      type: 'number',
      minimum: 0,
      description: 'Results offset for pagination (default 0).'
    },
    type: { type: 'string', enum: ['command', 'error', 'discovery', 'procedure', 'warning'] },
    project: { type: 'string', description: 'Project root to filter results.' },
    exclude_deprecated: {
      type: 'boolean',
      description: 'Exclude deprecated records (default true).'
    }
  }
}

const CREATE_TOOL_SCHEMA: Anthropic.Tool['input_schema'] = {
  type: 'object',
  additionalProperties: false,
  required: ['type'],
  properties: {
    type: { type: 'string', enum: ['command', 'error', 'discovery', 'procedure', 'warning'] },
    scope: { type: 'string', enum: ['global', 'project'], description: 'Memory scope (default: project).' },
    project: { type: 'string', description: 'Project root path. Auto-filled from context if omitted.' },
    // command fields
    command: { type: 'string', description: 'Command text. Required for command records.' },
    exitCode: { type: 'number', description: 'Command exit code. Required for command records.' },
    outcome: { type: 'string', enum: ['success', 'failure', 'partial'], description: 'Command outcome. Required for command records.' },
    intent: { type: 'string', description: 'What the command was trying to accomplish. Required for command records.' },
    resolution: { type: 'string', description: 'How the issue was resolved (command/error records).' },
    truncatedOutput: { type: 'string', description: 'Truncated command output (command records).' },
    // error fields
    errorText: { type: 'string', description: 'Error text. Required for error records.' },
    errorType: { type: 'string', description: 'Error type/category. Required for error records.' },
    cause: { type: 'string', description: 'Root cause of the error (error records).' },
    // discovery fields
    what: { type: 'string', description: 'Discovery summary. Required for discovery records.' },
    where: { type: 'string', description: 'Discovery context/location. Required for discovery records.' },
    evidence: { type: 'string', description: 'Supporting evidence. Required for discovery records.' },
    confidence: {
      type: 'string',
      enum: ['verified', 'inferred', 'tentative'],
      description: 'Discovery confidence. Required for discovery records.'
    },
    // procedure fields
    name: { type: 'string', description: 'Procedure name. Required for procedure records.' },
    steps: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      description: 'Procedure steps. Required for procedure records.'
    },
    prerequisites: {
      type: 'array',
      items: { type: 'string' },
      description: 'Prerequisites for the procedure (procedure records).'
    },
    verification: { type: 'string', description: 'How to verify the procedure succeeded (procedure records).' },
    // warning fields
    avoid: { type: 'string', description: 'What to avoid. Required for warning records.' },
    useInstead: { type: 'string', description: 'Recommended alternative. Required for warning records.' },
    reason: { type: 'string', description: 'Why this should be avoided. Required for warning records.' },
    severity: {
      type: 'string',
      enum: ['caution', 'warning', 'critical'],
      description: 'Warning severity. Required for warning records.'
    }
  }
}

const UPDATE_TOOL_SCHEMA: Anthropic.Tool['input_schema'] = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: {
    id: { type: 'string', description: 'Memory record ID to update.' },
    deprecated: { type: 'boolean', description: 'Mark record as deprecated.' },
    scope: { type: 'string', enum: ['global', 'project'], description: 'Set memory scope.' },
    command: { type: 'string', description: 'Command text (command records only).' },
    exitCode: { type: 'number', description: 'Command exit code (command records only).' },
    outcome: { type: 'string', enum: ['success', 'failure', 'partial'], description: 'Command outcome.' },
    resolution: { type: 'string', description: 'Resolution text (command/error records).' },
    truncatedOutput: { type: 'string', description: 'Truncated command output (command records).' },
    errorText: { type: 'string', description: 'Error text (error records).' },
    errorType: { type: 'string', description: 'Error type/category (error records).' },
    what: { type: 'string', description: 'Discovery summary (discovery records).' },
    where: { type: 'string', description: 'Discovery context/location (discovery records).' },
    confidence: {
      type: 'string',
      enum: ['verified', 'inferred', 'tentative'],
      description: 'Discovery confidence.'
    },
    name: { type: 'string', description: 'Procedure name (procedure records).' },
    steps: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      description: 'Procedure steps (procedure records).'
    },
    avoid: { type: 'string', description: 'Warning avoid text (warning records).' },
    useInstead: { type: 'string', description: 'Warning alternative (warning records).' },
    reason: { type: 'string', description: 'Warning rationale (warning records).' },
    severity: {
      type: 'string',
      enum: ['caution', 'warning', 'critical'],
      description: 'Warning severity.'
    }
  }
}

const DELETE_TOOL_SCHEMA: Anthropic.Tool['input_schema'] = {
  type: 'object',
  additionalProperties: false,
  required: ['ids'],
  properties: {
    ids: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      description: 'Memory record IDs to delete.'
    }
  }
}

const LIST_EXTRACTIONS_SCHEMA: Anthropic.Tool['input_schema'] = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: {
      type: 'number',
      minimum: 1,
      maximum: 50,
      description: 'Maximum number of extraction runs to return (default 10).'
    },
    offset: {
      type: 'number',
      minimum: 0,
      description: 'Offset for pagination (default 0).'
    }
  }
}

const GET_EXTRACTION_SCHEMA: Anthropic.Tool['input_schema'] = {
  type: 'object',
  additionalProperties: false,
  required: ['runId'],
  properties: {
    runId: { type: 'string', description: 'Extraction run ID.' },
    includeReview: {
      type: 'boolean',
      description: 'Include the review for this extraction if one exists (default true).'
    },
    includeRecords: {
      type: 'boolean',
      description: 'Include the extracted memory records (default true).'
    }
  }
}

export const CHAT_TOOLS: Anthropic.Tool[] = [
  {
    name: 'search_memories',
    description: 'Semantic search across memory records with optional filters.',
    input_schema: SEARCH_TOOL_SCHEMA
  },
  {
    name: 'create_memory',
    description: 'Create a new memory record. Requires type and the relevant fields for that type.',
    input_schema: CREATE_TOOL_SCHEMA
  },
  {
    name: 'update_memory',
    description: 'Update a memory record metadata or content fields.',
    input_schema: UPDATE_TOOL_SCHEMA
  },
  {
    name: 'delete_memories',
    description: 'Delete one or more memory records by ID.',
    input_schema: DELETE_TOOL_SCHEMA
  },
  {
    name: 'list_extractions',
    description: 'List recent extraction runs with timestamps, record counts, and session info.',
    input_schema: LIST_EXTRACTIONS_SCHEMA
  },
  {
    name: 'get_extraction',
    description: 'Get details of a specific extraction run, including extracted records and review (if available).',
    input_schema: GET_EXTRACTION_SCHEMA
  }
]

export type SearchMemoriesResult = {
  query: string
  count: number
  results: HybridSearchResult[]
}

export type CreateMemoryResult = {
  id: string
  success: boolean
  record: MemoryRecord
  error?: string
}

export type UpdateMemoryResult = {
  id: string
  success: boolean
  updates: Partial<MemoryRecord>
  record?: MemoryRecord | null
  error?: string
}

export type DeleteMemoriesResult = {
  ids: string[]
  deleted: number
  missing: string[]
  error?: string
}

export type ListExtractionsResult = {
  runs: ExtractionRun[]
  count: number
  total: number
  offset: number
  limit: number
}

export type GetExtractionResult = {
  run: ExtractionRun
  records?: MemoryRecord[]
  review?: ExtractionReview | null
  error?: string
}

export type ChatToolResult =
  | SearchMemoriesResult
  | CreateMemoryResult
  | UpdateMemoryResult
  | DeleteMemoriesResult
  | ListExtractionsResult
  | GetExtractionResult
  | { error: string }

export type ChatToolExecution = {
  result: ChatToolResult
  isError?: boolean
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function parseLimit(value: unknown): number {
  const parsed = parseNonNegativeInt(value, DEFAULT_SEARCH_LIMIT)
  return Math.min(Math.max(parsed, 1), MAX_SEARCH_LIMIT)
}

function parseMinSimilarity(value: unknown): number {
  const parsed = asNumber(value)
  if (parsed === null) return 0
  return clampNumber(parsed, 0, 1)
}

function parseOffset(value: unknown): number {
  return parseNonNegativeInt(value, 0)
}

function parseSteps(value: unknown): string[] | null {
  const steps = asStringArray(value, { trim: true, filterEmpty: true })
  return steps.length > 0 ? steps : null
}

function parseIds(value: unknown): string[] {
  return asStringArray(value, { trim: true, filterEmpty: true, unique: true })
}

export async function executeChatTool(
  name: ChatToolName,
  input: unknown,
  context: { config: Config; project?: string }
): Promise<ChatToolExecution> {
  switch (name) {
    case 'search_memories':
      return runSearchTool(input, context)
    case 'create_memory':
      return runCreateTool(input, context)
    case 'update_memory':
      return runUpdateTool(input, context)
    case 'delete_memories':
      return runDeleteTool(input, context)
    case 'list_extractions':
      return runListExtractionsTool(input, context)
    case 'get_extraction':
      return runGetExtractionTool(input, context)
    default:
      return { result: { error: `Unknown tool: ${name}` }, isError: true }
  }
}

async function runSearchTool(
  input: unknown,
  context: { config: Config; project?: string }
): Promise<ChatToolExecution> {
  if (!input || typeof input !== 'object') {
    return { result: { error: 'Invalid input for search_memories.' }, isError: true }
  }
  const record = input as Record<string, unknown>
  const query = asTrimmedString(record.query)
  if (!query) {
    return { result: { error: 'Query is required for search_memories.' }, isError: true }
  }

  const limit = parseLimit(record.limit)
  const offset = parseOffset(record.offset)
  const minSimilarity = parseMinSimilarity(record.min_similarity)
  const type = asRecordType(record.type) as RecordType | undefined
  const project = asTrimmedString(record.project) ?? context.project
  const excludeDeprecated = asBoolean(record.exclude_deprecated) ?? true
  const searchLimit = clampNumber(limit + offset, 1, MAX_SEARCH_LIMIT)

  const results = await hybridSearch({
    query,
    limit: searchLimit,
    minSimilarity,
    vectorWeight: 1,
    keywordWeight: 0,
    minScore: 0,
    usageRatioWeight: 0,
    type,
    project,
    excludeDeprecated
  }, context.config)

  const pagedResults = offset > 0 ? results.slice(offset, offset + limit) : results

  return {
    result: {
      query,
      count: pagedResults.length,
      results: pagedResults
    }
  }
}

async function runCreateTool(
  input: unknown,
  context: { config: Config; project?: string }
): Promise<ChatToolExecution> {
  if (!input || typeof input !== 'object') {
    return { result: { error: 'Invalid input for create_memory.' }, isError: true }
  }
  const raw = input as Record<string, unknown>
  const type = asRecordType(raw.type) as RecordType | undefined
  if (!type) {
    return { result: { error: 'type is required (command, error, discovery, procedure, warning).' }, isError: true }
  }

  const id = randomUUID()
  const project = asTrimmedString(raw.project) ?? context.project ?? ''
  const scope = asScope(raw.scope) ?? (project ? 'project' : 'global')
  const base = { id, type, scope, project, timestamp: Date.now() }

  let record: MemoryRecord
  switch (type) {
    case 'command': {
      const command = asTrimmedString(raw.command)
      const exitCode = asNumber(raw.exitCode)
      const outcome = asOutcome(raw.outcome)
      const intent = asTrimmedString(raw.intent)
      if (!command) return { result: { error: 'command is required for command records.' }, isError: true }
      if (exitCode === null) return { result: { error: 'exitCode is required for command records.' }, isError: true }
      if (!outcome) return { result: { error: 'outcome is required for command records (success/failure/partial).' }, isError: true }
      if (!intent) return { result: { error: 'intent is required for command records.' }, isError: true }
      record = {
        ...base, type: 'command', command,
        exitCode: Math.trunc(exitCode),
        outcome,
        context: { project, cwd: project, intent },
      } as MemoryRecord
      const resolution = asTrimmedString(raw.resolution)
      if (resolution) record.resolution = resolution
      const truncatedOutput = asTrimmedString(raw.truncatedOutput)
      if (truncatedOutput) record.truncatedOutput = truncatedOutput
      break
    }
    case 'error': {
      const errorText = asTrimmedString(raw.errorText)
      const errorType = asTrimmedString(raw.errorType)
      const resolution = asTrimmedString(raw.resolution)
      if (!errorText) return { result: { error: 'errorText is required for error records.' }, isError: true }
      if (!errorType) return { result: { error: 'errorType is required for error records.' }, isError: true }
      if (!resolution) return { result: { error: 'resolution is required for error records.' }, isError: true }
      record = {
        ...base, type: 'error', errorText, errorType, resolution,
        context: { project },
      } as MemoryRecord
      const cause = asTrimmedString(raw.cause)
      if (cause) record.cause = cause
      break
    }
    case 'discovery': {
      const what = asTrimmedString(raw.what)
      const where = asTrimmedString(raw.where)
      const evidence = asTrimmedString(raw.evidence)
      const confidence = asConfidence(raw.confidence)
      if (!what) return { result: { error: 'what is required for discovery records.' }, isError: true }
      if (!where) return { result: { error: 'where is required for discovery records.' }, isError: true }
      if (!evidence) return { result: { error: 'evidence is required for discovery records.' }, isError: true }
      if (!confidence) return { result: { error: 'confidence is required for discovery records (verified/inferred/tentative).' }, isError: true }
      record = {
        ...base, type: 'discovery', what, where, evidence, confidence,
      } as MemoryRecord
      break
    }
    case 'procedure': {
      const name = asTrimmedString(raw.name)
      const steps = parseSteps(raw.steps)
      if (!name) return { result: { error: 'name is required for procedure records.' }, isError: true }
      if (!steps) return { result: { error: 'steps array is required for procedure records.' }, isError: true }
      record = {
        ...base, type: 'procedure', name, steps,
        context: { ...(project ? { project } : {}) },
      } as MemoryRecord
      const prerequisites = asStringArray(raw.prerequisites, { trim: true, filterEmpty: true })
      if (prerequisites.length > 0) record.prerequisites = prerequisites
      const verification = asTrimmedString(raw.verification)
      if (verification) record.verification = verification
      break
    }
    case 'warning': {
      const avoid = asTrimmedString(raw.avoid)
      const useInstead = asTrimmedString(raw.useInstead)
      const reason = asTrimmedString(raw.reason)
      const severity = asSeverity(raw.severity)
      if (!avoid) return { result: { error: 'avoid is required for warning records.' }, isError: true }
      if (!useInstead) return { result: { error: 'useInstead is required for warning records.' }, isError: true }
      if (!reason) return { result: { error: 'reason is required for warning records.' }, isError: true }
      if (!severity) return { result: { error: 'severity is required for warning records (caution/warning/critical).' }, isError: true }
      record = {
        ...base, type: 'warning', avoid, useInstead, reason, severity,
      } as MemoryRecord
      break
    }
  }

  try {
    await insertRecord(record, context.config)
    return { result: { id, success: true, record } }
  } catch (err) {
    return { result: { error: `Failed to create memory: ${err instanceof Error ? err.message : String(err)}` }, isError: true }
  }
}

async function runUpdateTool(
  input: unknown,
  context: { config: Config }
): Promise<ChatToolExecution> {
  if (!input || typeof input !== 'object') {
    return { result: { error: 'Invalid input for update_memory.' }, isError: true }
  }
  const record = input as Record<string, unknown>
  const id = asTrimmedString(record.id)
  if (!id) {
    return { result: { error: 'id is required for update_memory.' }, isError: true }
  }

  const updates: Partial<MemoryRecord> = {}
  const deprecated = asBoolean(record.deprecated)
  const shouldDeprecate = deprecated === true
  if (deprecated === false) updates.deprecated = false

  const scope = asScope(record.scope)
  if (scope) updates.scope = scope

  const command = asTrimmedString(record.command)
  if (command) updates.command = command

  const exitCode = asNumber(record.exitCode)
  if (exitCode !== null) updates.exitCode = Math.trunc(exitCode)

  const outcome = asOutcome(record.outcome)
  if (outcome) updates.outcome = outcome

  const resolution = asTrimmedString(record.resolution)
  if (resolution) updates.resolution = resolution

  const truncatedOutput = asTrimmedString(record.truncatedOutput)
  if (truncatedOutput) updates.truncatedOutput = truncatedOutput

  const errorText = asTrimmedString(record.errorText)
  if (errorText) updates.errorText = errorText

  const errorType = asTrimmedString(record.errorType)
  if (errorType) updates.errorType = errorType

  const what = asTrimmedString(record.what)
  if (what) updates.what = what

  const where = asTrimmedString(record.where)
  if (where) updates.where = where

  const confidence = asConfidence(record.confidence)
  if (confidence) updates.confidence = confidence

  const name = asTrimmedString(record.name)
  if (name) updates.name = name

  const steps = parseSteps(record.steps)
  if (steps) updates.steps = steps

  const avoid = asTrimmedString(record.avoid)
  if (avoid) updates.avoid = avoid

  const useInstead = asTrimmedString(record.useInstead)
  if (useInstead) updates.useInstead = useInstead

  const reason = asTrimmedString(record.reason)
  if (reason) updates.reason = reason

  const severity = asSeverity(record.severity)
  if (severity) updates.severity = severity

  if (Object.keys(updates).length === 0 && !shouldDeprecate) {
    return { result: { id, success: false, updates, error: 'No updates provided.' }, isError: true }
  }

  let success = true
  if (Object.keys(updates).length > 0) {
    success = await updateRecord(id, updates, context.config)
  }
  if (success && shouldDeprecate) {
    success = await markDeprecated(id, context.config, { reason: 'manual:dashboard' })
  }
  const updatedRecord = success ? await getRecord(id, context.config) : null

  return {
    result: {
      id,
      success,
      updates,
      record: updatedRecord,
      ...(success ? {} : { error: 'Memory not found.' })
    },
    isError: !success
  }
}

async function runDeleteTool(
  input: unknown,
  context: { config: Config }
): Promise<ChatToolExecution> {
  if (!input || typeof input !== 'object') {
    return { result: { error: 'Invalid input for delete_memories.' }, isError: true }
  }
  const record = input as Record<string, unknown>
  const ids = parseIds(record.ids)
  if (ids.length === 0) {
    return { result: { error: 'ids array is required for delete_memories.' }, isError: true }
  }

  let deleted = 0
  const missing: string[] = []

  for (const id of ids) {
    const existing = await getRecord(id, context.config)
    if (!existing) {
      missing.push(id)
      continue
    }
    await deleteRecord(id, context.config)
    deleted += 1
  }

  return {
    result: {
      ids,
      deleted,
      missing
    }
  }
}

function runListExtractionsTool(
  input: unknown,
  context: { config: Config }
): ChatToolExecution {
  const raw = (input && typeof input === 'object') ? input as Record<string, unknown> : {}
  const limit = Math.min(Math.max(asNumber(raw.limit) ?? 10, 1), 50)
  const offset = Math.max(asNumber(raw.offset) ?? 0, 0)

  try {
    return { result: paginateExtractionRuns(context.config.lancedb.table, limit, offset) }
  } catch (err) {
    return { result: { error: `Failed to list extractions: ${err instanceof Error ? err.message : String(err)}` }, isError: true }
  }
}

async function runGetExtractionTool(
  input: unknown,
  context: { config: Config }
): Promise<ChatToolExecution> {
  if (!input || typeof input !== 'object') {
    return { result: { error: 'Invalid input for get_extraction.' }, isError: true }
  }
  const raw = input as Record<string, unknown>
  const runId = asTrimmedString(raw.runId)
  if (!runId) {
    return { result: { error: 'runId is required for get_extraction.' }, isError: true }
  }

  const includeReview = asBoolean(raw.includeReview) ?? true
  const includeRecords = asBoolean(raw.includeRecords) ?? true

  try {
    const detail = await loadExtractionRunDetail(runId, context.config, { includeRecords, includeReview })
    if (!detail) {
      return { result: { error: `Extraction run not found: ${runId}` }, isError: true }
    }
    return { result: detail }
  } catch (err) {
    return { result: { error: `Failed to get extraction: ${err instanceof Error ? err.message : String(err)}` }, isError: true }
  }
}
