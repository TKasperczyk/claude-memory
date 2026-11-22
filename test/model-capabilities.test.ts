import { describe, expect, it } from 'vitest'
import {
  buildToolCallParams,
  clampModelMaxTokens,
  getModelCapabilities,
  getModelMaxOutputTokens
} from '../src/lib/model-capabilities.js'

describe('model capabilities', () => {
  it('returns current lineup capabilities', () => {
    expect(getModelCapabilities('claude-fable-5')).toEqual({
      maxOutputTokens: 128000,
      thinkingStyle: 'always_on'
    })
    expect(getModelCapabilities('claude-opus-4-8')).toEqual({
      maxOutputTokens: 128000,
      thinkingStyle: 'adaptive'
    })
    expect(getModelCapabilities('claude-opus-4-7')).toEqual({
      maxOutputTokens: 128000,
      thinkingStyle: 'adaptive'
    })
    expect(getModelCapabilities('claude-opus-4-6')).toEqual({
      maxOutputTokens: 128000,
      thinkingStyle: 'adaptive'
    })
    expect(getModelCapabilities('claude-sonnet-4-6')).toEqual({
      maxOutputTokens: 64000,
      thinkingStyle: 'adaptive'
    })
    expect(getModelCapabilities('claude-haiku-5-5')).toEqual({
      maxOutputTokens: 128000,
      thinkingStyle: 'adaptive'
    })
    expect(getModelCapabilities('claude-haiku-4-5-20251001')).toEqual({
      maxOutputTokens: 64000,
      thinkingStyle: 'budget'
    })
  })

  it('keeps legacy model capabilities', () => {
    expect(getModelCapabilities('claude-sonnet-4-5-20250929')).toEqual({
      maxOutputTokens: 64000,
      thinkingStyle: 'budget'
    })
    expect(getModelCapabilities('claude-opus-4-5-20251101')).toEqual({
      maxOutputTokens: 64000,
      thinkingStyle: 'budget'
    })
  })

  it('uses conservative defaults for unknown model ids', () => {
    expect(getModelCapabilities('claude-future-model')).toEqual({
      maxOutputTokens: 64000,
      thinkingStyle: 'adaptive'
    })
    expect(getModelMaxOutputTokens('claude-future-model')).toBe(64000)
    expect(clampModelMaxTokens('claude-future-model', 128000)).toBe(64000)
  })

  it('forces the tool only on models that accept it', () => {
    expect(buildToolCallParams('claude-opus-4-8', 'emit', 1200)).toEqual({
      tool_choice: { type: 'tool', name: 'emit' },
      max_tokens: 1200
    })
    for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5']) {
      expect(buildToolCallParams(model, 'emit', 1200)).toEqual({
        tool_choice: { type: 'auto' },
        max_tokens: 17200
      })
      expect(buildToolCallParams(model, 'emit', 128000).max_tokens).toBe(128000)
    }
  })
})
