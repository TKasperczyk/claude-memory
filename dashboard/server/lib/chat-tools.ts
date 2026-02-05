import type Anthropic from '@anthropic-ai/sdk'
import {
  hybridSearch,
  updateRecord,
  deleteRecord,
  getRecord
} from '../../../src/lib/milvus.js'
import {
  asBoolean,
  asConfidence,
  asNumber,
  asOutcome,
  asRecordType,
  asScope,
  asSeverity,
  asTrimmedString
} from '../../../src/lib/parsing.js'
import type { Config, MemoryRecord, RecordType } from '../../../src/lib/types.js'
import type { HybridSearchResult } from '../../../shared/types.js'

export type ChatToolName = 'search_memories' | 'update_memory' | 'delete_memories'

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
    domain: { type: 'string', description: 'Domain filter.' },
    exclude_deprecated: {
      type: 'boolean',
      description: 'Exclude deprecated records (default false).'
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
    domain: {
      type: 'string',
      description: 'Set domain (use empty string to clear).'
    },
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

export const CHAT_TOOLS: Anthropic.Tool[] = [
  {
    name: 'search_memories',
    description: 'Semantic search across memory records with optional filters.',
    input_schema: SEARCH_TOOL_SCHEMA
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
  }
]

export type SearchMemoriesResult = {
  query: string
  count: number
  results: HybridSearchResult[]
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

export type ChatToolResult =
  | SearchMemoriesResult
  | UpdateMemoryResult
  | DeleteMemoriesResult
  | { error: string }

export type ChatToolExecution = {
  result: ChatToolResult
  isError?: boolean
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function parseLimit(value: unknown): number {
  const parsed = asNumber(value)
  if (parsed === null) return DEFAULT_SEARCH_LIMIT
  return clampNumber(Math.trunc(parsed), 1, MAX_SEARCH_LIMIT)
}

function parseMinSimilarity(value: unknown): number {
  const parsed = asNumber(value)
  if (parsed === null) return 0
  return clampNumber(parsed, 0, 1)
}

function parseOffset(value: unknown): number {
  const parsed = asNumber(value)
  if (parsed === null) return 0
  return Math.max(0, Math.trunc(parsed))
}

function parseDomain(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function parseSteps(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const steps = value
    .map(entry => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(entry => entry.length > 0)
  return steps.length > 0 ? steps : null
}

function parseIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const ids = value
    .map(entry => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(entry => entry.length > 0)
  return Array.from(new Set(ids))
}

export async function executeChatTool(
  name: ChatToolName,
  input: unknown,
  context: { config: Config; project?: string }
): Promise<ChatToolExecution> {
  switch (name) {
    case 'search_memories':
      return runSearchTool(input, context)
    case 'update_memory':
      return runUpdateTool(input, context)
    case 'delete_memories':
      return runDeleteTool(input, context)
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
  const domain = parseDomain(record.domain)
  const excludeDeprecated = asBoolean(record.exclude_deprecated) ?? false
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
    domain,
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
  if (deprecated !== null) updates.deprecated = deprecated

  const scope = asScope(record.scope)
  if (scope) updates.scope = scope

  if (Object.prototype.hasOwnProperty.call(record, 'domain')) {
    if (typeof record.domain === 'string') {
      updates.domain = record.domain.trim()
    } else if (record.domain === null) {
      updates.domain = ''
    }
  }

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

  if (Object.keys(updates).length === 0) {
    return { result: { id, success: false, updates, error: 'No updates provided.' }, isError: true }
  }

  const success = await updateRecord(id, updates, context.config)
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
