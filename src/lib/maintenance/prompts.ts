import type Anthropic from '@anthropic-ai/sdk'
import { createAnthropicClient } from '../anthropic.js'
import type { MemoryRecord } from '../types.js'

export const GENERALIZATION_MAX_TOKENS = 1500
export const CONTRADICTION_MAX_TOKENS = 1200
export const CONFLICT_ADJUDICATION_MAX_TOKENS = 1200
export const CONFLICT_ADJUDICATION_TOOL_NAME = 'emit_conflict_verdict'
export const GLOBAL_PROMOTION_MAX_TOKENS = 800
export const WARNING_SYNTHESIS_MAX_TOKENS = 1500
export const WARNING_SYNTHESIS_TOOL_NAME = 'emit_warning'
export const CONSOLIDATION_VERIFICATION_MAX_TOKENS = 1200
export const CONSOLIDATION_VERIFICATION_TOOL_NAME = 'emit_consolidation_verification'

export const GENERALIZATION_PROMPT = `Evaluate this memory record for reusability across different contexts.

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

export const CONTRADICTION_PROMPT = `Analyze these two memory records for contradiction.

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

export const CONFLICT_ADJUDICATION_PROMPT = `You adjudicate conflicts between a newly extracted memory and an existing memory.

Compare the Existing Memory and the New Candidate. Determine their relationship and emit a verdict:
- "supersedes": the new memory updates/corrects the existing fact; deprecate the existing record.
- "variant": both can be true in different contexts; keep both records.
- "hallucination": the new memory is vague/incorrect compared to the existing; deprecate the new record.

Rules:
- Use only the provided records; do not invent context.
- Be conservative: choose "variant" when both could be true.
- Provide a concise reason.
- Output ONLY via the tool call "${CONFLICT_ADJUDICATION_TOOL_NAME}" exactly once.`

export const GLOBAL_PROMOTION_PROMPT = `Evaluate if this memory record should be promoted to global scope.

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

export const CONSOLIDATION_VERIFICATION_PROMPT = `Verify if a cluster of similar memory records should be consolidated, and if so, select the best representative.

First, determine if these records are TRUE DUPLICATES (same information, different wording) vs RELATED BUT DISTINCT (different systems, APIs, environments, or complementary information).

MERGE if:
- Records describe the same fact, error, or procedure with minor wording differences
- Records are redundant - one subsumes the other completely
- Records describe the same system/API/environment with different levels of detail

DO NOT MERGE if:
- Records describe DIFFERENT systems (e.g., Anthropic API vs Gemini API)
- Records describe DIFFERENT environments (e.g., local vs remote, dev vs prod)
- Records contain COMPLEMENTARY information (both are useful together)
- Records describe different aspects of the same topic that aren't redundant

If merging, select the best representative considering:
- For cross-type clusters: procedure > warning > error > discovery > command
- Usage stats (usageCount, retrievalCount, successCount), and recency
- Prefer records that provide concrete steps or actionable fixes

Return ONLY via the tool call "${CONSOLIDATION_VERIFICATION_TOOL_NAME}" exactly once.`

export const WARNING_SYNTHESIS_PROMPT = `Analyze these failure records and synthesize a warning if there's a clear anti-pattern.

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

export const WARNING_SYNTHESIS_TOOL: Anthropic.Tool = {
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

export const CONSOLIDATION_VERIFICATION_TOOL: Anthropic.Tool = {
  name: CONSOLIDATION_VERIFICATION_TOOL_NAME,
  description: 'Verify consolidation and select the representative record.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['shouldMerge', 'reason'],
    properties: {
      shouldMerge: {
        type: 'boolean',
        description: 'True if records are true duplicates and should be merged. False if they are related but distinct.'
      },
      keptId: {
        type: 'string',
        description: 'ID of the record to keep. Required if shouldMerge is true.'
      },
      reason: {
        type: 'string',
        description: 'Explanation of why records should or should not be merged.'
      }
    }
  }
}

export const CONFLICT_ADJUDICATION_TOOL: Anthropic.Tool = {
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

export async function getAnthropicClient(): Promise<Awaited<ReturnType<typeof createAnthropicClient>>> {
  if (cachedAnthropicClient !== undefined) {
    return cachedAnthropicClient
  }

  cachedAnthropicClient = await createAnthropicClient()
  return cachedAnthropicClient
}

export function buildGeneralizationInput(record: MemoryRecord): Record<string, unknown> {
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

export function extractResponseText(
  content: Array<{ type: string; text?: string }>
): string {
  return content
    .filter(block => block.type === 'text')
    .map(block => block.text ?? '')
    .join('\n')
    .trim()
}

export function coerceBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true') return true
    if (normalized === 'false') return false
  }
  return false
}

export function extractJsonObject(rawText: string): unknown {
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
