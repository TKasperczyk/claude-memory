import Anthropic from '@anthropic-ai/sdk'
import fs from 'fs'
import { CLAUDE_CODE_SYSTEM_PROMPT, createAnthropicClient } from './anthropic.js'
import { asStringArray, asTrimmedString, isPlainObject, isToolUseBlock, type ToolUseBlock } from './parsing.js'
import { truncateText, withTimeout } from './shared.js'
import { parseTranscriptTurns, type TranscriptTurn } from './transcript.js'
import { extractTokenUsage } from './token-usage.js'
import type { TokenUsage } from './types.js'

export interface RetrievalQueryPlan {
  resolvedQuery: string
  keywordQueries: string[]
  semanticQueries: string[]
}

export interface RetrievalQueryPlanGenerationResult {
  plan: RetrievalQueryPlan | null
  tokenUsage: TokenUsage
  model: string
}

const TOOL_NAME = 'emit_query_plan'
const HAIKU_MODEL = 'claude-haiku-4-5-20251001'
const QUERY_MAX_TOKENS = 1000
const MAX_CONTEXT_TURNS = 8
const MAX_TURN_CHARS = 4000
const MIN_SEMANTIC_VARIANTS = 1
const MAX_SEMANTIC_VARIANTS = 8

const SYSTEM_PROMPT = `You generate search queries for a technical memory database.

You will receive:
CONTEXT: recent conversation turns (user + assistant).
FOCUS: the current user prompt that needs memory retrieval.
SEMANTIC_VARIANT_COUNT: integer N, the exact number of semantic query variants to return.

Goal: resolve what the FOCUS refers to using CONTEXT, then produce a retrieval plan.

How search works (use this to inform your choices):
- keywordQueries run as exact substring matches (SQL LIKE "%term%") against stored text. A term only matches if it literally appears in the record. Prefer short, concrete terms. Add synonyms because the stored text may use different vocabulary than the query.
- semanticQueries are each embedded into vectors and compared by cosine similarity. Keep each focused on the core technical intent — conversational framing and filler words dilute the signal.

Definitions:
- resolvedQuery: rewrite FOCUS with pronouns/ellipses resolved. Keep the user's intent.
- keywordQueries: search terms for substring matching. Include the union of useful terms across all semantic variants: exact names (commands, files, tools, flags), individual significant words from compound phrases, and domain synonyms/alternative terms.
- semanticQueries: exactly N distinct reformulations capturing the core technical intent; good for embeddings. Strip conversational framing.

High-signal token preservation:
- Preserve high-signal technical tokens verbatim in resolvedQuery, keywordQueries, and at least one semanticQueries entry. This includes product/tool names (docker, kubernetes, postgres, redis, Ubiquiti, UniFi), version strings (Node 22.11.0, PostgreSQL 16, v1.2.3), error codes/statuses (EADDRINUSE, ECONNRESET, HTTP 429, ORA-00942), file paths (/etc/nginx/nginx.conf, src/lib/retrieval.ts), command names and flags (docker exec, kubectl rollout, pnpm build, -selection clipboard), and hostnames/domains (api.local, db-prod-01, 127.0.0.1).
- Do not replace or generalize those tokens away. If FOCUS says "ubiquiti gateway docker setup", at least one semanticQueries entry must include "ubiquiti" and "docker"; keywordQueries should include "ubiquiti", "docker", and grounded aliases like "UniFi" when useful.

Semantic variant strategy:
- If N is 1, return one focused query using the same behavior as a single semantic reformulation.
- If N is greater than 1, vary vocabulary and aspect emphasis. Use one verbatim-preserving variant, one synonym/alias-expanded variant, and one specific-aspect-focused variant when applicable.
- Variants must not be trivial paraphrases of each other. Change technical angle, specificity, or terminology while preserving the user's intent.
Examples:
CONTEXT:
User: "We store embeddings in LanceDB under table cc_memories."
Assistant: "Use the LanceDB client."
FOCUS: "How do I query it?"
SEMANTIC_VARIANT_COUNT: 1
resolvedQuery: "How do I query the LanceDB table cc_memories?"
keywordQueries: ["LanceDB", "cc_memories", "query table"]
semanticQueries: ["How to query the LanceDB table cc_memories for stored embeddings."]

CONTEXT:
User: "The \`xclip -selection clipboard\` command overwrote my clipboard."
FOCUS: "Would it pollute my clipboard?"
SEMANTIC_VARIANT_COUNT: 1
resolvedQuery: "Would running \`xclip -selection clipboard\` pollute my clipboard?"
keywordQueries: ["xclip", "-selection clipboard", "clipboard"]
semanticQueries: ["Does running xclip with -selection clipboard overwrite or pollute the clipboard?"]

CONTEXT:
User: "I tried deploying but the rollout keeps failing."
FOCUS: "How do I check the rollout status?"
SEMANTIC_VARIANT_COUNT: 3
resolvedQuery: "How do I check the deployment rollout status?"
keywordQueries: ["rollout status", "deployment", "deploy", "kubectl rollout"]
semanticQueries: [
  "How to check the status of a Kubernetes deployment rollout that is failing.",
  "Troubleshoot failing kubectl rollout status and deployment progress in Kubernetes.",
  "Commands and procedure for diagnosing a stuck or failed Kubernetes deployment rollout."
]

Rules:
- Do NOT invent details not in CONTEXT or FOCUS.
- If CONTEXT is empty or not helpful, resolvedQuery can equal FOCUS.
- For keywordQueries: include both compound phrases AND their significant individual words. Add domain synonyms for technical concepts (the database may use different terminology than the query).
- NEVER emit generic single words as keywords (e.g., "save", "file", "run", "check", "error", "output", "data", "config"). Always pair common verbs/nouns with a specific qualifier (e.g., "save parquet" not "save", "config file" not "config").
- ALWAYS emit proper nouns (tool/service/product names like "jira", "grafana", "kubernetes", "redis") as standalone keywords even when they also appear in a compound phrase. These are high-signal identifiers that records are likely indexed by.
- Output ONLY via the tool "${TOOL_NAME}" exactly once.`

function buildQueryTool(semanticVariantCount: number): Anthropic.Tool {
  return {
    name: TOOL_NAME,
    description: 'Emit a retrieval query plan for memory search.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['resolvedQuery', 'keywordQueries', 'semanticQueries'],
      properties: {
        resolvedQuery: { type: 'string' },
        keywordQueries: {
          type: 'array',
          items: { type: 'string' }
        },
        semanticQueries: {
          type: 'array',
          minItems: semanticVariantCount,
          maxItems: semanticVariantCount,
          items: { type: 'string' }
        }
      }
    }
  }
}

export async function generateRetrievalQueryPlan(
  prompt: string,
  transcriptPath: string | undefined,
  options: { signal?: AbortSignal; timeoutMs?: number; maxTurns?: number; expansionCount?: number } = {}
): Promise<RetrievalQueryPlanGenerationResult | null> {
  if (!prompt || !prompt.trim()) {
    return null
  }
  if (options.signal?.aborted) return null
  const semanticVariantCount = normalizeSemanticVariantCount(options.expansionCount)

  try {
    const result = await withTimeout(async (signal) => {
      let turns: TranscriptTurn[] = []
      if (transcriptPath && fs.existsSync(transcriptPath)) {
        turns = await parseTranscriptTurns(
          transcriptPath,
          options.maxTurns ?? MAX_CONTEXT_TURNS,
          signal
        )
      }
      if (signal.aborted) return null

      const client = await createAnthropicClient()
      if (!client) {
        console.error('[claude-memory] No authentication available for retrieval query generation.')
        return null
      }

      const userPrompt = buildUserPrompt(turns, prompt, semanticVariantCount)

      const response = await client.messages.create({
        model: HAIKU_MODEL,
        max_tokens: QUERY_MAX_TOKENS,
        temperature: 0,
        system: [
          { type: 'text', text: CLAUDE_CODE_SYSTEM_PROMPT },
          { type: 'text', text: SYSTEM_PROMPT }
        ],
        messages: [{ role: 'user', content: userPrompt }],
        tools: [buildQueryTool(semanticVariantCount)],
        tool_choice: { type: 'tool', name: TOOL_NAME }
      }, { signal })
      const tokenUsage = extractTokenUsage(response)

      const toolInput = response.content.find((block): block is ToolUseBlock =>
        isToolUseBlock(block) && block.name === TOOL_NAME
      )?.input
      if (!toolInput) {
        console.warn('[claude-memory] Haiku query generation returned no tool output')
        return {
          plan: null,
          tokenUsage,
          model: HAIKU_MODEL
        }
      }
      const plan = coerceRetrievalQueryPlan(toolInput, semanticVariantCount)
      if (!plan) {
        console.warn('[claude-memory] Haiku query plan failed validation:', JSON.stringify(toolInput))
      }
      return {
        plan,
        tokenUsage,
        model: HAIKU_MODEL
      }
    }, { timeoutMs: options.timeoutMs, signal: options.signal })

    if (!result.completed) {
      if (result.timedOut) {
        console.warn(`[claude-memory] Haiku query generation timed out after ${options.timeoutMs ?? '?'}ms`)
      }
      return null
    }
    return result.value ?? null
  } catch (error) {
    console.error('[claude-memory] Retrieval query generation failed:', error)
    return null
  }
}

function coerceRetrievalQueryPlan(value: unknown, semanticVariantCount: number): RetrievalQueryPlan | null {
  if (!isPlainObject(value)) return null
  const resolvedQuery = asTrimmedString(value.resolvedQuery)
  const keywordQueries = asStringArray(value.keywordQueries)
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0)
  const semanticQueries = dedupeStrings(asStringArray(value.semanticQueries)
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0))
    .slice(0, semanticVariantCount)
  if (!resolvedQuery || semanticQueries.length === 0) return null

  return {
    resolvedQuery,
    keywordQueries,
    semanticQueries
  }
}

function normalizeSemanticVariantCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return MIN_SEMANTIC_VARIANTS
  return Math.min(MAX_SEMANTIC_VARIANTS, Math.max(MIN_SEMANTIC_VARIANTS, Math.trunc(value)))
}

function dedupeStrings(entries: string[]): string[] {
  const seen = new Set<string>()
  return entries.filter(entry => {
    const key = entry.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function buildUserPrompt(turns: TranscriptTurn[], focus: string, semanticVariantCount: number): string {
  const context = turns.length > 0
    ? turns.map((turn, index) => formatTurn(turn, index)).join('\n\n')
    : '[no prior turns]'
  const trimmedFocus = focus.trim()
  return `CONTEXT (previous turns, oldest to newest):
${context}

FOCUS (current user prompt):
${trimmedFocus}

SEMANTIC_VARIANT_COUNT:
${semanticVariantCount}`
}

function formatTurn(turn: TranscriptTurn, index: number): string {
  const user = truncateText(turn.user, MAX_TURN_CHARS)
  const assistant = turn.assistant ? truncateText(turn.assistant, MAX_TURN_CHARS) : null
  const lines = [`Turn ${index + 1}`, `User: ${user}`]
  if (assistant) lines.push(`Assistant: ${assistant}`)
  return lines.join('\n')
}
