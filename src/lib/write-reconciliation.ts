import Anthropic from '@anthropic-ai/sdk'
import { CLAUDE_CODE_SYSTEM_PROMPT, createAnthropicClient } from './anthropic.js'
import { formatRecordSnippet } from './context.js'
import { buildToolCallParams } from './model-capabilities.js'
import { asConfidence, asOutcome, asSeverity, asTrimmedString, isPlainObject, isToolUseBlock, type ToolUseBlock } from './parsing.js'
import { buildCacheControl } from './prompt-cache.js'
import { resolveMaintenanceModel } from './settings.js'
import { truncateText, withTimeout } from './shared.js'
import { extractTokenUsage } from './token-usage.js'
import { recordTokenUsageEventsAsync } from './token-usage-events.js'
import type { Config, MemoryRecord, TokenUsage } from './types.js'

const TOOL_NAME = 'emit_reconciliation_decision'
const RECONCILE_MAX_TOKENS = 600
const DEFAULT_TIMEOUT_MS = 15_000

const SYSTEM_PROMPT = `You reconcile a newly extracted memory record against existing similar memories in a technical knowledge base.

You will receive:
- INCOMING: a newly extracted memory candidate.
- NEIGHBORS: existing active records in the same project/environment/global scope that are semantically similar (cosine >= 0.70), numbered [0]..[N-1] with their IDs.

Choose EXACTLY ONE action:
1. NOOP: An existing neighbor ALREADY captures the same technical fact/command/fix/warning accurately and completely. Do not insert a duplicate. Set targetIndex to that neighbor.
2. UPDATE: An existing neighbor covers the SAME topic/fact/command/error, and INCOMING adds useful refinements, concrete details, or clearer resolution without contradicting it. Set targetIndex to that neighbor and provide concise merged text fields (only fields valid for the neighbor's type) if needed.
3. SUPERSEDE: INCOMING replaces or contradicts an outdated/incorrect/obsolete neighbor (e.g. architecture changed, setting default changed, new command replaced old one). Set targetIndex to the obsolete neighbor so it will be deprecated and replaced by INCOMING.
4. ADD: INCOMING is genuinely distinct knowledge (different root cause, different subsystem, different command/constraint) that should coexist alongside all neighbors.

Rules:
- Prefer NOOP when INCOMING is just a paraphrase of an existing neighbor with no durable new information.
- Prefer SUPERSEDE over ADD whenever keeping both records would confuse future sessions with conflicting facts.
- Prefer UPDATE when enriching an existing same-type record (keep neighbor's identity and usage history).
- Output ONLY via the tool "${TOOL_NAME}" exactly once.`

export type WriteReconciliationAction = 'ADD' | 'NOOP' | 'UPDATE' | 'SUPERSEDE'

export interface NeighborCandidate {
  record: MemoryRecord
  similarity: number
}

export interface WriteReconciliationResult {
  action: WriteReconciliationAction
  targetRecord?: MemoryRecord
  targetSimilarity?: number
  mergedUpdates?: Partial<MemoryRecord>
  reason: string
  tokenUsage?: TokenUsage
  model: string
}

function buildReconcileTool(maxNeighborIndex: number): Anthropic.Tool {
  return {
    name: TOOL_NAME,
    description: 'Decide whether to ADD, NOOP, UPDATE, or SUPERSEDE an incoming memory record against existing neighbors.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['action', 'reason'],
      properties: {
        action: {
          type: 'string',
          enum: ['ADD', 'NOOP', 'UPDATE', 'SUPERSEDE']
        },
        targetIndex: {
          type: 'integer',
          minimum: 0,
          maximum: Math.max(0, maxNeighborIndex),
          description: 'Required for NOOP, UPDATE, and SUPERSEDE: 0-based index of the matching neighbor.'
        },
        reason: {
          type: 'string',
          description: 'Short rationale for the reconciliation choice.'
        },
        mergedUpdates: {
          type: 'object',
          description: 'Optional field updates for UPDATE (only fields belonging to the target neighbor record type, e.g. what/evidence, resolution/cause, steps, avoid/useInstead/reason).'
        }
      }
    }
  }
}

function describeRecordForReconcile(record: MemoryRecord): string {
  const snippet = formatRecordSnippet(record) ?? ''
  const fields: Record<string, unknown> = {
    type: record.type,
    scope: record.scope ?? 'project',
    ...(record.project ? { project: record.project } : {}),
    ...(record.volatility ? { volatility: record.volatility } : {}),
    ...(record.ttlDays ? { ttlDays: record.ttlDays } : {})
  }
  switch (record.type) {
    case 'command':
      fields.command = record.command
      fields.outcome = record.outcome
      fields.intent = record.context?.intent
      if (record.resolution) fields.resolution = record.resolution
      break
    case 'error':
      fields.errorText = record.errorText
      fields.errorType = record.errorType
      if (record.cause) fields.cause = record.cause
      fields.resolution = record.resolution
      break
    case 'discovery':
      fields.what = record.what
      fields.where = record.where
      fields.evidence = record.evidence
      break
    case 'procedure':
      fields.name = record.name
      fields.steps = record.steps
      if (record.verification) fields.verification = record.verification
      break
    case 'warning':
      fields.avoid = record.avoid
      fields.useInstead = record.useInstead
      fields.reason = record.reason
      fields.severity = record.severity
      break
  }
  return truncateText(JSON.stringify(fields) || snippet, 900)
}

export function sanitizeMergedUpdates(target: MemoryRecord, raw: unknown): Partial<MemoryRecord> | undefined {
  if (!isPlainObject(raw)) return undefined
  const allowedByType: Record<MemoryRecord['type'], readonly string[]> = {
    command: ['command', 'outcome', 'resolution', 'truncatedOutput'],
    error: ['errorText', 'errorType', 'cause', 'resolution'],
    discovery: ['what', 'where', 'evidence', 'confidence'],
    procedure: ['name', 'steps', 'prerequisites', 'verification'],
    warning: ['avoid', 'useInstead', 'reason', 'severity']
  }
  const allowed = new Set(allowedByType[target.type])
  const cleaned: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(raw)) {
    if (!allowed.has(key)) continue
    if (key === 'outcome') {
      const parsed = asOutcome(val)
      if (parsed) cleaned.outcome = parsed
      continue
    }
    if (key === 'confidence') {
      const parsed = asConfidence(val)
      if (parsed) cleaned.confidence = parsed
      continue
    }
    if (key === 'severity') {
      const parsed = asSeverity(val)
      if (parsed) cleaned.severity = parsed
      continue
    }
    if (key === 'steps' || key === 'prerequisites') {
      if (Array.isArray(val)) {
        const items = val
          .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
          .map(item => item.trim())
        if (items.length > 0) cleaned[key] = items
      }
      continue
    }
    if (typeof val === 'string' && val.trim()) {
      cleaned[key] = val.trim()
    }
  }
  return Object.keys(cleaned).length > 0 ? (cleaned as Partial<MemoryRecord>) : undefined
}

export function selectReconcileTarget(
  neighbors: NeighborCandidate[],
  rawIndex: unknown
): NeighborCandidate | null {
  const hasValidIndex = typeof rawIndex === 'number'
    && Number.isInteger(rawIndex)
    && rawIndex >= 0
    && rawIndex < neighbors.length
  if (!hasValidIndex && (rawIndex !== undefined || neighbors.length > 1)) {
    return null
  }
  return neighbors[hasValidIndex ? rawIndex : 0] ?? null
}

/**
 * Reconcile an extracted memory against top semantic neighbors at write time.
 * Returns null if the LLM is unavailable or errors so the caller falls back to
 * threshold-based dedup cleanly.
 */
export async function reconcileIncomingRecord(
  incoming: MemoryRecord,
  neighbors: NeighborCandidate[],
  config: Config,
  options: { sessionId?: string; runId?: string; timeoutMs?: number; model?: string } = {}
): Promise<WriteReconciliationResult | null> {
  if (neighbors.length === 0) {
    return {
      action: 'ADD',
      reason: 'no_similar_neighbors',
      model: options.model ?? resolveMaintenanceModel()
    }
  }

  const model = options.model ?? resolveMaintenanceModel()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  try {
    const wrapped = await withTimeout(async (signal) => {
      const client = await createAnthropicClient()
      if (!client) return null

      const neighborBlock = neighbors.map((n, idx) =>
        `[${idx}] (sim=${n.similarity.toFixed(3)}, id=${n.record.id.slice(0, 8)}, used=${n.record.usageCount ?? 0}) ${describeRecordForReconcile(n.record)}`
      ).join('\n')

      const userPrompt = `INCOMING:\n${describeRecordForReconcile(incoming)}\n\nNEIGHBORS:\n${neighborBlock}`

      const response = await client.messages.create({
        model,
        ...buildToolCallParams(model, TOOL_NAME, RECONCILE_MAX_TOKENS),
        system: [
          { type: 'text', text: CLAUDE_CODE_SYSTEM_PROMPT },
          { type: 'text', text: SYSTEM_PROMPT, cache_control: buildCacheControl('1h') }
        ],
        messages: [{ role: 'user', content: userPrompt }],
        tools: [buildReconcileTool(neighbors.length - 1)]
      }, { signal })

      const tokenUsage = extractTokenUsage(response)
      if (tokenUsage) {
        recordTokenUsageEventsAsync([{
          timestamp: Date.now(),
          source: 'reconcile',
          model,
          ...(options.sessionId ? { sessionId: options.sessionId } : {}),
          ...(options.runId ? { runId: options.runId } : {}),
          inputTokens: tokenUsage.inputTokens,
          outputTokens: tokenUsage.outputTokens,
          cacheCreationInputTokens: tokenUsage.cacheCreationInputTokens,
          cacheReadInputTokens: tokenUsage.cacheReadInputTokens
        }], { collection: config.lancedb.table })
      }

      const toolInput = response.content.find((block): block is ToolUseBlock =>
        isToolUseBlock(block) && block.name === TOOL_NAME
      )?.input

      if (!isPlainObject(toolInput)) return null
      const rawAction = toolInput.action
      if (rawAction !== 'ADD' && rawAction !== 'NOOP' && rawAction !== 'UPDATE' && rawAction !== 'SUPERSEDE') {
        return null
      }
      const action: WriteReconciliationAction = rawAction
      const reason = asTrimmedString(toolInput.reason) ?? action

      if (action === 'ADD') {
        return { action, reason, tokenUsage, model }
      }

      const target = selectReconcileTarget(neighbors, toolInput.targetIndex)
      if (!target) {
        return null
      }

      const mergedUpdates = action === 'UPDATE'
        ? sanitizeMergedUpdates(target.record, toolInput.mergedUpdates)
        : undefined

      return {
        action,
        targetRecord: target.record,
        targetSimilarity: target.similarity,
        ...(mergedUpdates ? { mergedUpdates } : {}),
        reason,
        tokenUsage,
        model
      }
    }, { timeoutMs })

    if (!wrapped.completed) return null
    return wrapped.value ?? null
  } catch (error) {
    console.error('[claude-memory] Write-time reconciliation failed; falling back to threshold dedup:', error)
    return null
  }
}
