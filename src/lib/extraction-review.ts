import Anthropic from '@anthropic-ai/sdk'
import { CLAUDE_CODE_SYSTEM_PROMPT, createAnthropicClient } from './anthropic.js'
import { embedBatch } from './embed.js'
import { getExtractionRun } from './extraction-log.js'
import { escapeFilterValue, queryRecords, vectorSearchSimilar } from './milvus.js'
import { asString, isPlainObject } from './parsing.js'
import { clampScore, coerceReviewIssue, parseOverallAccuracy } from './review-coercion.js'
import { buildRecordSnippet, truncateSnippet, truncateWithTail } from './shared.js'
import { loadSettings } from './settings.js'
import { DEFAULT_CONFIG, type Config, type MemoryRecord } from './types.js'

export interface ExtractionReviewIssue {
  recordId?: string
  type: 'inaccurate' | 'partial' | 'hallucinated' | 'missed' | 'duplicate'
  severity: 'critical' | 'major' | 'minor'
  description: string
  evidence: string
  suggestedFix?: string
}

export interface ExtractionReview {
  runId: string
  reviewedAt: number
  overallAccuracy: 'good' | 'acceptable' | 'poor'
  accuracyScore: number
  issues: ExtractionReviewIssue[]
  summary: string
  model: string
  durationMs: number
}

const REVIEW_MODEL = 'claude-opus-4-5-20251101'
const REVIEW_TOOL_NAME = 'emit_review'
const REVIEW_MAX_TOKENS = 1800
const REVIEW_SIMILAR_LIMIT = 15
const REVIEW_SIMILAR_COMBINED_MAX_CHARS = 12000

const REVIEW_SYSTEM_PROMPT = `You are reviewing the quality of extracted technical memories.

Rules:
- Output ONLY via the tool call "${REVIEW_TOOL_NAME}" exactly once.
- Use the transcript segments as the source of truth.
- Commands and errorText must be verbatim; flag any paraphrasing.
- Every issue must include a short evidence quote from the transcript segments.
- Identify missed extractions if something important appears but is not captured.
- For missed issues, use suggestedFix to describe what should have been extracted.
- Check extracted records against similar existing memories; flag duplicates with type "duplicate".
- Be precise and concrete in descriptions and suggested fixes.
`

const EXTRACTION_SCHEMA_DESCRIPTION = `Record types:
- command: { command, exitCode, outcome, truncatedOutput?, resolution?, context:{ project, cwd, intent } }
- error: { errorText, errorType, cause?, resolution, context:{ project, file?, tool? } }
- discovery: { what, where, evidence, confidence }
- procedure: { name, steps[], prerequisites?, verification?, context:{ project?, domain } }
`

const REVIEW_TOOL: Anthropic.Tool = {
  name: REVIEW_TOOL_NAME,
  description: 'Emit an extraction quality review with issues (including duplicates) and accuracy rating.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['overallAccuracy', 'accuracyScore', 'issues', 'summary'],
    properties: {
      runId: { type: 'string' },
      reviewedAt: { type: 'number' },
      overallAccuracy: { type: 'string', enum: ['good', 'acceptable', 'poor'] },
      accuracyScore: { type: 'number' },
      issues: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'severity', 'description', 'evidence'],
          properties: {
            recordId: { type: 'string' },
            type: { type: 'string', enum: ['inaccurate', 'partial', 'hallucinated', 'missed', 'duplicate'] },
            severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
            description: { type: 'string' },
            evidence: { type: 'string' },
            suggestedFix: { type: 'string' }
          }
        }
      },
      summary: { type: 'string' },
      model: { type: 'string' },
      durationMs: { type: 'number' }
    }
  }
}

type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: unknown }

type ReviewPayload = {
  overallAccuracy: ExtractionReview['overallAccuracy']
  accuracyScore: number
  issues: ExtractionReviewIssue[]
  summary: string
}

export async function reviewExtraction(
  runId: string,
  config: Config = DEFAULT_CONFIG
): Promise<ExtractionReview> {
  const startTime = Date.now()
  const run = getExtractionRun(runId)
  if (!run) {
    throw new Error('Extraction run not found.')
  }

  const extractedIds = run.extractedRecordIds ?? []
  if (extractedIds.length === 0) {
    throw new Error('No extracted record IDs in this run. This may be an older extraction log or a run with only duplicates.')
  }
  const records = await fetchRecordsByIds(extractedIds, config)
  if (records.length === 0) {
    throw new Error('Could not fetch extracted records from Milvus. They may have been deleted.')
  }

  const { reviewSimilarThreshold, reviewDuplicateWarningThreshold } = loadSettings()

  let similarMemories: Array<{ record: MemoryRecord; similarity: number }> = []
  try {
    const transcriptSegments = collectTranscriptSegments(records)
    similarMemories = await collectSimilarMemories(
      transcriptSegments,
      extractedIds,
      config,
      reviewSimilarThreshold
    )
  } catch (error) {
    console.error('[claude-memory] Failed to fetch similar memories for review:', error)
  }

  const client = await createAnthropicClient()
  if (!client) {
    throw new Error('No authentication available for extraction review. Set ANTHROPIC_API_KEY or run kira login.')
  }

  const prompt = buildReviewPrompt(run, records, similarMemories, {
    reviewSimilarThreshold,
    reviewDuplicateWarningThreshold
  })

  const response = await client.messages.create({
    model: REVIEW_MODEL,
    max_tokens: Math.min(REVIEW_MAX_TOKENS, config.extraction.maxTokens),
    temperature: 0,
    system: [
      { type: 'text', text: CLAUDE_CODE_SYSTEM_PROMPT },
      { type: 'text', text: REVIEW_SYSTEM_PROMPT }
    ],
    messages: [{ role: 'user', content: prompt }],
    tools: [REVIEW_TOOL],
    tool_choice: { type: 'tool', name: REVIEW_TOOL_NAME }
  })

  const toolInput = response.content.find((block): block is ToolUseBlock =>
    isToolUseBlock(block) && block.name === REVIEW_TOOL_NAME
  )?.input

  if (!toolInput) {
    throw new Error('Review tool call missing in response.')
  }

  const payload = coerceReviewPayload(toolInput)
  if (!payload) {
    throw new Error('Review response invalid or incomplete.')
  }

  const reviewedAt = Date.now()
  return {
    runId,
    reviewedAt,
    overallAccuracy: payload.overallAccuracy,
    accuracyScore: payload.accuracyScore,
    issues: payload.issues,
    summary: payload.summary,
    model: REVIEW_MODEL,
    durationMs: reviewedAt - startTime
  }
}

async function fetchRecordsByIds(ids: string[], config: Config): Promise<MemoryRecord[]> {
  if (ids.length === 0) return []

  const records: MemoryRecord[] = []
  const batchSize = 1000

  for (let i = 0; i < ids.length; i += batchSize) {
    const batchIds = ids.slice(i, i + batchSize)
    const idFilter = batchIds.map(id => `"${escapeFilterValue(id)}"`).join(', ')
    const batch = await queryRecords({
      filter: `id in [${idFilter}]`,
      limit: batchIds.length,
      includeEmbeddings: true
    }, config)
    records.push(...batch)
  }

  const byId = new Map(records.map(record => [record.id, record]))
  return ids
    .map(id => byId.get(id))
    .filter((record): record is MemoryRecord => Boolean(record))
}

function collectTranscriptSegments(records: MemoryRecord[]): string[] {
  const segments: string[] = []

  for (const record of records) {
    if (!record.sourceExcerpt) continue
    const trimmed = record.sourceExcerpt.trim()
    if (trimmed) segments.push(trimmed)
  }

  return Array.from(new Set(segments))
}

async function collectSimilarMemories(
  transcriptSegments: string[],
  excludeIds: string[],
  config: Config,
  similarityThreshold: number
): Promise<Array<{ record: MemoryRecord; similarity: number }>> {
  const inputs = buildTranscriptEmbeddingInputs(transcriptSegments)
  if (inputs.length === 0) return []

  const filter = buildExcludeFilter(excludeIds)
  const excludeSet = new Set(excludeIds)
  const seen = new Map<string, { record: MemoryRecord; similarity: number }>()

  const embeddings = await embedBatch(inputs, config)

  for (const embedding of embeddings) {
    const results = await vectorSearchSimilar(embedding, {
      filter,
      limit: REVIEW_SIMILAR_LIMIT,
      similarityThreshold
    }, config)

    for (const result of results) {
      if (excludeSet.has(result.record.id)) continue
      const existing = seen.get(result.record.id)
      if (!existing || result.similarity > existing.similarity) {
        seen.set(result.record.id, result)
      }
    }
  }

  return Array.from(seen.values())
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, REVIEW_SIMILAR_LIMIT)
}

function buildTranscriptEmbeddingInputs(segments: string[]): string[] {
  const cleaned = segments.map(segment => segment.trim()).filter(Boolean)
  if (cleaned.length === 0) return []

  const uniqueSegments = Array.from(new Set(cleaned))
  const combined = truncateWithTail(uniqueSegments.join('\n\n'), REVIEW_SIMILAR_COMBINED_MAX_CHARS)

  if (combined && !uniqueSegments.includes(combined)) {
    return [...uniqueSegments, combined]
  }

  return uniqueSegments
}

function buildExcludeFilter(excludeIds: string[]): string {
  const parts = ['deprecated == false']
  for (const id of excludeIds) {
    parts.push(`id != "${escapeFilterValue(id)}"`)
  }
  return parts.join(' && ')
}

function buildReviewPrompt(
  run: { runId: string; sessionId: string; transcriptPath: string; recordCount: number; parseErrorCount: number },
  records: MemoryRecord[],
  similar: Array<{ record: MemoryRecord; similarity: number }>,
  thresholds: { reviewSimilarThreshold: number; reviewDuplicateWarningThreshold: number }
): string {
  const recordPayload = records.map(formatReviewRecord)
  const transcriptPayload = records.map(record => ({
    recordId: record.id,
    excerpt: record.sourceExcerpt ?? '(missing source excerpt)'
  }))
  const duplicateThreshold = thresholds.reviewDuplicateWarningThreshold
  const similarThreshold = thresholds.reviewSimilarThreshold
  const potentialDuplicates = similar.filter(entry => entry.similarity >= duplicateThreshold)
  const relatedMemories = similar.filter(entry => entry.similarity < duplicateThreshold)
  const duplicatePayload = potentialDuplicates.map(entry => formatSimilarRecord(entry.record, entry.similarity))
  const relatedPayload = relatedMemories.map(entry => formatSimilarRecord(entry.record, entry.similarity))
  const duplicatePercent = Math.round(duplicateThreshold * 100)
  const similarPercent = Math.round(similarThreshold * 100)

  return `Run metadata:
- run_id: ${run.runId}
- session_id: ${run.sessionId}
- transcript_path: ${run.transcriptPath}
- record_count: ${run.recordCount}
- parse_error_count: ${run.parseErrorCount}

Extraction schema:
${EXTRACTION_SCHEMA_DESCRIPTION}

Extracted records (JSON):
${JSON.stringify(recordPayload, null, 2)}

Transcript segments by recordId (JSON):
${JSON.stringify(transcriptPayload, null, 2)}

Similar existing memories - check for duplicates and flag them using issue type "duplicate".
Potential duplicates (>= ${duplicatePercent}% similarity; review carefully):
${JSON.stringify(duplicatePayload, null, 2)}

Related memories for context (>= ${similarPercent}% similarity; may not appear in transcript):
${JSON.stringify(relatedPayload, null, 2)}
`
}

function formatReviewRecord(record: MemoryRecord): Record<string, unknown> {
  const base = {
    id: record.id,
    type: record.type,
    project: record.project,
    domain: record.domain,
    scope: record.scope
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

function formatSimilarRecord(record: MemoryRecord, similarity: number): Record<string, unknown> {
  const summary = truncateSnippet(buildRecordSnippet(record), 160)
  return {
    id: record.id,
    type: record.type,
    similarity: Number(similarity.toFixed(3)),
    summary,
    project: record.project,
    domain: record.domain,
    scope: record.scope
  }
}

function coerceReviewPayload(input: unknown): ReviewPayload | null {
  if (!isPlainObject(input)) return null
  const record = input

  const overallAccuracy = parseOverallAccuracy(record.overallAccuracy)
  const accuracyScore = parseAccuracyScore(record.accuracyScore)
  const summary = asString(record.summary)?.trim() ?? ''
  const issues = Array.isArray(record.issues)
    ? record.issues.map(coerceReviewIssue).filter((issue): issue is ExtractionReviewIssue => Boolean(issue))
    : []

  if (!overallAccuracy || accuracyScore === null || summary === '') return null

  return {
    overallAccuracy,
    accuracyScore,
    issues,
    summary
  }
}

function parseAccuracyScore(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return clampScore(value)
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return clampScore(parsed)
  }
  return null
}

function isToolUseBlock(value: unknown): value is ToolUseBlock {
  return (
    isPlainObject(value)
    && value.type === 'tool_use'
    && typeof value.id === 'string'
    && typeof value.name === 'string'
    && 'input' in value
  )
}
