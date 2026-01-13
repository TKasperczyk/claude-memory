import type Anthropic from '@anthropic-ai/sdk'
import { CLAUDE_CODE_SYSTEM_PROMPT, createAnthropicClient } from './anthropic.js'
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

type ToolUseAccumulator = {
  id: string
  name: string
  index: number
  input: unknown
  inputJson: string
  hasInputDeltas: boolean
}

function parseToolInputJson(value: string): unknown | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return undefined
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
    temperature: 0,
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
    if (event.type === 'content_block_start') {
      const block = event.content_block
      if (block.type === 'tool_use') {
        toolInputs.set(event.index, {
          id: block.id,
          name: block.name,
          index: event.index,
          input: block.input,
          inputJson: '',
          hasInputDeltas: false
        })
      }
      continue
    }

    if (event.type === 'content_block_delta') {
      if (event.delta.type === 'thinking_delta') {
        if (event.delta.thinking) onThinking(event.delta.thinking)
        continue
      }
      if (event.delta.type === 'input_json_delta') {
        const accumulator = toolInputs.get(event.index)
        if (accumulator) {
          accumulator.inputJson += event.delta.partial_json
          accumulator.hasInputDeltas = true
        }
      }
    }
  }

  const toolUseBlocks: ToolUseBlock[] = Array.from(toolInputs.values())
    .sort((a, b) => a.index - b.index)
    .map(entry => ({
      type: 'tool_use',
      id: entry.id,
      name: entry.name,
      input: entry.hasInputDeltas
        ? parseToolInputJson(entry.inputJson) ?? entry.inputJson
        : entry.input
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
