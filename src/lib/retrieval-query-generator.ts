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
  semanticQuery: string
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

const SYSTEM_PROMPT = `You generate search queries for a technical memory database.

You will receive:
CONTEXT: recent conversation turns (user + assistant).
FOCUS: the current user prompt that needs memory retrieval.

Goal: resolve what the FOCUS refers to using CONTEXT, then produce a retrieval plan.

How search works (use this to inform your choices):
- keywordQueries run as exact substring matches (SQL LIKE "%term%") against stored text. A term only matches if it literally appears in the record. Prefer short, concrete terms. Add synonyms because the stored text may use different vocabulary than the query.
- semanticQuery is embedded into a vector and compared by cosine similarity. Keep it focused on the core technical intent — conversational framing and filler words dilute the signal.

Definitions:
- resolvedQuery: rewrite FOCUS with pronouns/ellipses resolved. Keep the user's intent.
- keywordQueries: 1-5 search terms for substring matching. Include: exact names (commands, files, tools, flags), individual significant words from compound phrases, and domain synonyms/alternative terms.
- semanticQuery: 1-3 sentences capturing the core technical intent; good for embeddings. Strip conversational framing.
Examples:
CONTEXT:
User: "We store embeddings in Milvus under collection cc_memories."
Assistant: "Use the Milvus client."
FOCUS: "How do I query it?"
resolvedQuery: "How do I query the Milvus collection cc_memories?"
keywordQueries: ["Milvus", "cc_memories", "query collection"]
semanticQuery: "How to query the Milvus collection cc_memories for stored embeddings."

CONTEXT:
User: "The \`xclip -selection clipboard\` command overwrote my clipboard."
FOCUS: "Would it pollute my clipboard?"
resolvedQuery: "Would running \`xclip -selection clipboard\` pollute my clipboard?"
keywordQueries: ["xclip", "-selection clipboard", "clipboard"]
semanticQuery: "Does running xclip with -selection clipboard overwrite or pollute the clipboard?"

CONTEXT:
User: "I tried deploying but the rollout keeps failing."
FOCUS: "How do I check the rollout status?"
resolvedQuery: "How do I check the deployment rollout status?"
keywordQueries: ["rollout status", "deployment", "deploy", "kubectl rollout"]
semanticQuery: "How to check the status of a Kubernetes deployment rollout that is failing."

Rules:
- Do NOT invent details not in CONTEXT or FOCUS.
- If CONTEXT is empty or not helpful, resolvedQuery can equal FOCUS.
- For keywordQueries: include both compound phrases AND their significant individual words. Add domain synonyms for technical concepts (the database may use different terminology than the query).
- Output ONLY via the tool "${TOOL_NAME}" exactly once.`

const QUERY_TOOL: Anthropic.Tool = {
  name: TOOL_NAME,
  description: 'Emit a retrieval query plan for memory search.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['resolvedQuery', 'keywordQueries', 'semanticQuery'],
    properties: {
      resolvedQuery: { type: 'string' },
      keywordQueries: {
        type: 'array',
        items: { type: 'string' }
      },
      semanticQuery: { type: 'string' }
    }
  }
}

export async function generateRetrievalQueryPlan(
  prompt: string,
  transcriptPath: string | undefined,
  options: { signal?: AbortSignal; timeoutMs?: number; maxTurns?: number } = {}
): Promise<RetrievalQueryPlanGenerationResult | null> {
  if (!prompt || !prompt.trim()) {
    return null
  }
  if (options.signal?.aborted) return null

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

      const userPrompt = buildUserPrompt(turns, prompt)

      const response = await client.messages.create({
        model: HAIKU_MODEL,
        max_tokens: QUERY_MAX_TOKENS,
        temperature: 0,
        system: [
          { type: 'text', text: CLAUDE_CODE_SYSTEM_PROMPT },
          { type: 'text', text: SYSTEM_PROMPT }
        ],
        messages: [{ role: 'user', content: userPrompt }],
        tools: [QUERY_TOOL],
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
      const plan = coerceRetrievalQueryPlan(toolInput)
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

function coerceRetrievalQueryPlan(value: unknown): RetrievalQueryPlan | null {
  if (!isPlainObject(value)) return null
  const resolvedQuery = asTrimmedString(value.resolvedQuery)
  const semanticQuery = asTrimmedString(value.semanticQuery)
  const keywordQueries = asStringArray(value.keywordQueries)
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0)
  if (!resolvedQuery || !semanticQuery) return null

  return {
    resolvedQuery,
    keywordQueries,
    semanticQuery
  }
}

function buildUserPrompt(turns: TranscriptTurn[], focus: string): string {
  const context = turns.length > 0
    ? turns.map((turn, index) => formatTurn(turn, index)).join('\n\n')
    : '[no prior turns]'
  const trimmedFocus = focus.trim()
  return `CONTEXT (previous turns, oldest to newest):
${context}

FOCUS (current user prompt):
${trimmedFocus}`
}

function formatTurn(turn: TranscriptTurn, index: number): string {
  const user = truncateText(turn.user, MAX_TURN_CHARS)
  const assistant = turn.assistant ? truncateText(turn.assistant, MAX_TURN_CHARS) : null
  const lines = [`Turn ${index + 1}`, `User: ${user}`]
  if (assistant) lines.push(`Assistant: ${assistant}`)
  return lines.join('\n')
}
