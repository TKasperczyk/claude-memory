import type Anthropic from '@anthropic-ai/sdk'
import { CLAUDE_CODE_SYSTEM_PROMPT, createAnthropicClient } from './anthropic.js'
import { applyToolUseDelta, finalizeToolUses, type ToolUseAccumulator } from './anthropic-stream.js'
import { clampModelMaxTokens, getModelCapabilities } from './model-capabilities.js'
import { isToolUseBlock, type ToolUseBlock } from './parsing.js'
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
    max_tokens: clampModelMaxTokens(
      frameworkConfig.model,
      Math.min(frameworkConfig.maxTokens, config.extraction.maxTokens)
    ),
    system: [
      { type: 'text', text: CLAUDE_CODE_SYSTEM_PROMPT },
      { type: 'text', text: frameworkConfig.systemPrompt }
    ],
    messages: [{ role: 'user', content: prompt }],
    tools: [tool],
    tool_choice: { type: 'tool', name: frameworkConfig.toolName }
  })

  const toolInput = response.content.find((block): block is ToolUseBlock =>
    isToolUseBlock(block) && block.name === frameworkConfig.toolName
  )?.input

  if (!toolInput) {
    throw new Error('Review tool call missing in response.')
  }

  const payload = frameworkConfig.coercePayload(toolInput)
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
  const requestedMaxTokens = capabilities.thinkingStyle === 'budget'
    ? baseMaxTokens + thinkingBudget
    : baseMaxTokens
  const maxTokens = clampModelMaxTokens(frameworkConfig.model, requestedMaxTokens)
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
      { type: 'text', text: systemPromptWithToolInstruction }
    ],
    messages: [{ role: 'user', content: prompt }],
    tools: [tool],
    tool_choice: { type: 'auto' },
    ...thinkingParam,
    stream: true
  }, abortSignal ? { signal: abortSignal } : undefined)

  const toolInputs = new Map<number, ToolUseAccumulator>()

  for await (const event of stream) {
    applyToolUseDelta(toolInputs, event as { type?: string; index?: number; content_block?: any; delta?: any })
    if (event.type === 'content_block_delta' && event.delta.type === 'thinking_delta') {
      if (event.delta.thinking) onThinking(event.delta.thinking)
    }
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

  const payload = frameworkConfig.coercePayload(toolInput)
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
