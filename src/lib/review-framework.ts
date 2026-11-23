import type Anthropic from '@anthropic-ai/sdk'
import { CLAUDE_CODE_SYSTEM_PROMPT, createAnthropicClient } from './anthropic.js'
import { applyToolUseDelta, finalizeToolUses, type ToolUseAccumulator } from './anthropic-stream.js'
import {
  buildToolCallParams,
  clampModelMaxTokens,
  computeMaxTokensWithThinkingHeadroom,
  getModelCapabilities
} from './model-capabilities.js'
import { isToolUseBlock, unwrapSingleKeyPayload, type ToolUseBlock } from './parsing.js'
import { recordTokenUsageEventsAsync, recordTokenUsageFromResponse } from './token-usage-events.js'
import { type Config } from './types.js'

export interface ReviewFrameworkConfig<TInput, TPayload> {
  toolName: string
  toolDescription: string
  toolSchema: Anthropic.Tool['input_schema']
  maxTokens: number
  systemPrompt: string
  buildPrompt: (input: TInput) => string
  coercePayload: (raw: unknown) => TPayload | null
  model: string
  authErrorMessage: string
  startedAt?: number
  onInvalidPayload?: (raw: unknown) => void
}

export interface ReviewResult<TPayload> {
  payload: TPayload
  reviewedAt: number
  model: string
  durationMs: number
}

export type ThinkingCallback = (chunk: string) => void

const THINKING_BUDGET_TOKENS = 8000

export async function executeReview<TInput, TPayload>(
  input: TInput,
  frameworkConfig: ReviewFrameworkConfig<TInput, TPayload>,
  config: Config
): Promise<ReviewResult<TPayload>> {
  const startTime = frameworkConfig.startedAt ?? Date.now()
  const client = await createAnthropicClient()
  if (!client) {
    throw new Error(frameworkConfig.authErrorMessage)
  }

  const tool: Anthropic.Tool = {
    name: frameworkConfig.toolName,
    description: frameworkConfig.toolDescription,
    input_schema: frameworkConfig.toolSchema
  }

  const prompt = frameworkConfig.buildPrompt(input)
  const response = await client.messages.create({
    model: frameworkConfig.model,
    system: [
      { type: 'text', text: CLAUDE_CODE_SYSTEM_PROMPT },
      { type: 'text', text: frameworkConfig.systemPrompt, cache_control: { type: 'ephemeral' } }
    ],
    messages: [{ role: 'user', content: prompt }],
    tools: [tool],
    ...buildToolCallParams(frameworkConfig.model, frameworkConfig.toolName, Math.min(frameworkConfig.maxTokens, config.extraction.maxTokens))
  })
  recordTokenUsageFromResponse('review', frameworkConfig.model, response, {
    collection: config.lancedb.table
  })

  const toolInput = response.content.find((block): block is ToolUseBlock =>
    isToolUseBlock(block) && block.name === frameworkConfig.toolName
  )?.input

  if (!toolInput) {
    throw new Error('Review tool call missing in response.')
  }

  const payload = frameworkConfig.coercePayload(unwrapSingleKeyPayload(toolInput))
  if (!payload) {
    frameworkConfig.onInvalidPayload?.(toolInput)
    throw new Error('Review response invalid or incomplete.')
  }

  const reviewedAt = Date.now()
  return {
    payload,
    reviewedAt,
    model: frameworkConfig.model,
    durationMs: reviewedAt - startTime
  }
}

export async function executeReviewStreaming<TInput, TPayload>(
  input: TInput,
  frameworkConfig: ReviewFrameworkConfig<TInput, TPayload>,
  config: Config,
  onThinking: ThinkingCallback,
  abortSignal?: AbortSignal
): Promise<ReviewResult<TPayload>> {
  const startTime = frameworkConfig.startedAt ?? Date.now()
  const client = await createAnthropicClient()
  if (!client) {
    throw new Error(frameworkConfig.authErrorMessage)
  }

  const tool: Anthropic.Tool = {
    name: frameworkConfig.toolName,
    description: frameworkConfig.toolDescription,
    input_schema: frameworkConfig.toolSchema
  }

  const prompt = frameworkConfig.buildPrompt(input)
  const capabilities = getModelCapabilities(frameworkConfig.model)
  const baseMaxTokens = Math.min(frameworkConfig.maxTokens, config.extraction.maxTokens)
  const thinkingBudget = THINKING_BUDGET_TOKENS
  const maxTokens = capabilities.thinkingStyle === 'budget'
    ? clampModelMaxTokens(frameworkConfig.model, baseMaxTokens + thinkingBudget)
    : computeMaxTokensWithThinkingHeadroom(frameworkConfig.model, baseMaxTokens)
  const thinkingParam = capabilities.thinkingStyle === 'budget'
    ? { thinking: { type: 'enabled' as const, budget_tokens: thinkingBudget } }
    : capabilities.thinkingStyle === 'adaptive'
      ? { thinking: { type: 'adaptive' } as unknown as Anthropic.ThinkingConfigParam }
      : {}
  // Streaming reviews use auto tool choice so budget/adaptive thinking can be sent
  // for models that support explicit thinking controls. Fable thinking is always on
  // and rejects an explicit thinking param, so that style omits the field entirely.
  const systemPromptWithToolInstruction = `${frameworkConfig.systemPrompt}

IMPORTANT: You MUST call the ${frameworkConfig.toolName} tool to submit your review. Do not respond with text - always use the tool.`

  const stream = await client.messages.create({
    model: frameworkConfig.model,
    max_tokens: maxTokens,
    system: [
      { type: 'text', text: CLAUDE_CODE_SYSTEM_PROMPT },
      { type: 'text', text: systemPromptWithToolInstruction, cache_control: { type: 'ephemeral' } }
    ],
    messages: [{ role: 'user', content: prompt }],
    tools: [tool],
    tool_choice: { type: 'auto' },
    ...thinkingParam,
    stream: true
  }, abortSignal ? { signal: abortSignal } : undefined)

  const toolInputs = new Map<number, ToolUseAccumulator>()
  let inputTokens = 0
  let outputTokens = 0
  let cacheCreationInputTokens = 0
  let cacheReadInputTokens = 0

  for await (const event of stream) {
    applyToolUseDelta(toolInputs, event as { type?: string; index?: number; content_block?: any; delta?: any })
    if (event.type === 'content_block_delta' && event.delta.type === 'thinking_delta') {
      if (event.delta.thinking) onThinking(event.delta.thinking)
    } else if (event.type === 'message_start') {
      const usage = event.message?.usage as {
        input_tokens?: number
        output_tokens?: number
        cache_creation_input_tokens?: number | null
        cache_read_input_tokens?: number | null
      } | undefined
      if (usage) {
        if (typeof usage.input_tokens === 'number') inputTokens = usage.input_tokens
        if (typeof usage.output_tokens === 'number') outputTokens = usage.output_tokens
        if (typeof usage.cache_creation_input_tokens === 'number') cacheCreationInputTokens = usage.cache_creation_input_tokens
        if (typeof usage.cache_read_input_tokens === 'number') cacheReadInputTokens = usage.cache_read_input_tokens
      }
    } else if (event.type === 'message_delta') {
      const usage = (event as { usage?: { output_tokens?: number } }).usage
      if (typeof usage?.output_tokens === 'number') {
        outputTokens = usage.output_tokens
      }
    }
  }

  if (inputTokens > 0 || outputTokens > 0 || cacheCreationInputTokens > 0 || cacheReadInputTokens > 0) {
    recordTokenUsageEventsAsync([{
      timestamp: Date.now(),
      source: 'review',
      model: frameworkConfig.model,
      inputTokens,
      outputTokens,
      cacheCreationInputTokens,
      cacheReadInputTokens
    }], { collection: config.lancedb.table })
  }

  const toolUseBlocks: ToolUseBlock[] = finalizeToolUses(toolInputs).map(entry => ({
    type: 'tool_use',
    id: entry.id,
    name: entry.name,
    input: entry.input
  }))

  const toolInput = toolUseBlocks.find(block => block.name === frameworkConfig.toolName)?.input

  if (!toolInput) {
    throw new Error('Review tool call missing in response.')
  }

  const payload = frameworkConfig.coercePayload(unwrapSingleKeyPayload(toolInput))
  if (!payload) {
    frameworkConfig.onInvalidPayload?.(toolInput)
    throw new Error('Review response invalid or incomplete.')
  }

  const reviewedAt = Date.now()
  return {
    payload,
    reviewedAt,
    model: frameworkConfig.model,
    durationMs: reviewedAt - startTime
  }
}
