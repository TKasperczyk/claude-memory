export type ThinkingStyle = 'always_on' | 'adaptive' | 'budget'

export interface ModelCapabilities {
  maxOutputTokens: number
  thinkingStyle: ThinkingStyle
  /** These models 400 on tool_choice type "tool"/"any" and always think, so tool calls go through "auto". */
  rejectsForcedToolChoice?: boolean
}

export const MODEL_CAPABILITIES: Record<string, ModelCapabilities> = {
  'claude-opus-5-5': {
    maxOutputTokens: 128000,
    thinkingStyle: 'adaptive',
    rejectsForcedToolChoice: true
  },
  'claude-sonnet-5-5': {
    maxOutputTokens: 128000,
    thinkingStyle: 'adaptive',
    rejectsForcedToolChoice: true
  },
  'claude-opus-5': {
    maxOutputTokens: 128000,
    thinkingStyle: 'adaptive'
  },
  'claude-sonnet-5': {
    maxOutputTokens: 64000,
    thinkingStyle: 'adaptive'
  },
  'claude-fable-5': {
    maxOutputTokens: 128000,
    thinkingStyle: 'always_on'
  },
  'claude-haiku-5-5': {
    maxOutputTokens: 128000,
    thinkingStyle: 'adaptive'
  },
  'claude-opus-4-8': {
    maxOutputTokens: 128000,
    thinkingStyle: 'adaptive'
  },
  'claude-opus-4-7': {
    maxOutputTokens: 128000,
    thinkingStyle: 'adaptive'
  },
  'claude-opus-4-6': {
    maxOutputTokens: 128000,
    thinkingStyle: 'adaptive'
  },
  'claude-sonnet-4-6': {
    maxOutputTokens: 64000,
    thinkingStyle: 'adaptive'
  },
  'claude-sonnet-4-5-20250929': {
    maxOutputTokens: 64000,
    thinkingStyle: 'budget'
  },
  'claude-opus-4-5-20251101': {
    maxOutputTokens: 64000,
    thinkingStyle: 'budget'
  },
  'claude-haiku-4-5-20251001': {
    maxOutputTokens: 64000,
    thinkingStyle: 'budget'
  }
}

export const UNKNOWN_MODEL_CAPABILITIES: ModelCapabilities = {
  maxOutputTokens: 64000,
  thinkingStyle: 'adaptive'
}

export function getModelCapabilities(model: string): ModelCapabilities {
  return MODEL_CAPABILITIES[model] ?? UNKNOWN_MODEL_CAPABILITIES
}

export function getModelMaxOutputTokens(model: string): number {
  return getModelCapabilities(model).maxOutputTokens
}

export function clampModelMaxTokens(model: string, requestedMaxTokens: number): number {
  return Math.min(requestedMaxTokens, getModelMaxOutputTokens(model))
}

// Thinking counts toward max_tokens; caps sized for a bare tool call would
// truncate before the tool_use block on models that cannot skip thinking.
const AUTO_TOOL_CHOICE_THINKING_HEADROOM_TOKENS = 16000

export type ToolCallParams = {
  tool_choice: { type: 'tool'; name: string } | { type: 'auto' }
  max_tokens: number
}

/**
 * Force the named tool where the model allows it. Otherwise fall back to
 * "auto" (the prompts already demand the tool, and every caller handles a
 * missing tool_use block) with extra room for thinking.
 */
export function buildToolCallParams(model: string, toolName: string, maxTokens: number): ToolCallParams {
  if (getModelCapabilities(model).rejectsForcedToolChoice) {
    return {
      tool_choice: { type: 'auto' },
      max_tokens: clampModelMaxTokens(model, maxTokens + AUTO_TOOL_CHOICE_THINKING_HEADROOM_TOKENS)
    }
  }
  return {
    tool_choice: { type: 'tool', name: toolName },
    max_tokens: clampModelMaxTokens(model, maxTokens)
  }
}
