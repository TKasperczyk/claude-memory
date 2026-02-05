import type Anthropic from '@anthropic-ai/sdk'
import { CLAUDE_CODE_SYSTEM_PROMPT, createAnthropicClient } from './anthropic.js'
import { applyToolUseDelta, finalizeToolUses, type ToolUseAccumulator } from './anthropic-stream.js'
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
const MIN_THINKING_BUDGET = 2000

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
    max_tokens: Math.min(frameworkConfig.maxTokens, config.extraction.maxTokens),
    temperature: 0,
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
  // For streaming with thinking, we need more tokens than normal
  // The config limit applies to tool output; thinking is additional
  const baseMaxTokens = frameworkConfig.maxTokens
  const thinkingBudget = THINKING_BUDGET_TOKENS
  const maxTokens = baseMaxTokens + thinkingBudget
  // Extended thinking requires tool_choice: 'auto' - forced tool_choice is not compatible
  // The system prompt must strongly instruct the model to use the tool
  const systemPromptWithToolInstruction = `${frameworkConfig.systemPrompt}

IMPORTANT: You MUST call the ${frameworkConfig.toolName} tool to submit your review. Do not respond with text - always use the tool.`

  const stream = await client.messages.create({
    model: frameworkConfig.model,
    max_tokens: maxTokens,
    // Extended thinking requires temperature: 1
    temperature: 1,
    system: [
      { type: 'text', text: CLAUDE_CODE_SYSTEM_PROMPT },
      { type: 'text', text: systemPromptWithToolInstruction }
    ],
    messages: [{ role: 'user', content: prompt }],
    tools: [tool],
    tool_choice: { type: 'auto' },
    thinking: { type: 'enabled', budget_tokens: thinkingBudget },
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
