export type ThinkingStyle = 'always_on' | 'adaptive' | 'budget'

export interface ModelCapabilities {
  maxOutputTokens: number
  thinkingStyle: ThinkingStyle
}

export const MODEL_CAPABILITIES: Record<string, ModelCapabilities> = {
  'claude-fable-5': {
    maxOutputTokens: 128000,
    thinkingStyle: 'always_on'
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
