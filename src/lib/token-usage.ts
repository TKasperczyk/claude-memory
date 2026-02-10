import type { TokenUsage } from './types.js'

type UsageResponse = {
  usage?: {
    input_tokens?: number | null
    output_tokens?: number | null
    cache_creation_input_tokens?: number | null
    cache_read_input_tokens?: number | null
  } | null
}

export function emptyTokenUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0
  }
}

export function addTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens
  }
}

export function hasTokenUsage(usage: TokenUsage): boolean {
  return (
    usage.inputTokens > 0
    || usage.outputTokens > 0
    || usage.cacheCreationInputTokens > 0
    || usage.cacheReadInputTokens > 0
  )
}

export function extractTokenUsage(response: UsageResponse): TokenUsage {
  const usage = response.usage
  return {
    inputTokens: asTokenCount(usage?.input_tokens),
    outputTokens: asTokenCount(usage?.output_tokens),
    cacheCreationInputTokens: asTokenCount(usage?.cache_creation_input_tokens),
    cacheReadInputTokens: asTokenCount(usage?.cache_read_input_tokens)
  }
}

function asTokenCount(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.trunc(value))
}
