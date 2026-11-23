import type Anthropic from '@anthropic-ai/sdk'

export type PromptCacheTtl = '5m' | '1h'
export type EphemeralCacheControl = Anthropic.CacheControlEphemeral & { ttl?: PromptCacheTtl }

/**
 * Build an Anthropic ephemeral cache_control breakpoint.
 * Sparse interactive calls (retrieval, extraction, review) default to '1h' so
 * prompts spaced 5–30 minutes apart still hit the cache; dense maintenance batch
 * loops can pass '5m' to avoid the 1h cache-write premium.
 */
export function buildCacheControl(defaultTtl: PromptCacheTtl = '1h'): EphemeralCacheControl {
  const override = process.env.CC_PROMPT_CACHE_TTL?.trim().toLowerCase()
  const ttl: PromptCacheTtl = override === '5m' || override === '1h' ? override : defaultTtl
  return ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' }
}
