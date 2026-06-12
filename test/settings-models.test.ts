import { describe, expect, it } from 'vitest'
import { DEFAULT_MODEL_SETTINGS, MODEL_OPTIONS } from '../src/lib/settings-schema.js'
import { validateSettingValue } from '../src/lib/settings.js'

describe('model settings', () => {
  it('uses the current default models and keeps legacy options selectable', () => {
    expect(DEFAULT_MODEL_SETTINGS).toEqual({
      extractionModel: 'claude-sonnet-4-6',
      reviewModel: 'claude-opus-4-8',
      chatModel: 'claude-opus-4-8'
    })
    expect(MODEL_OPTIONS.map(option => option.value)).toEqual([
      'claude-fable-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      'claude-haiku-4-5-20251001',
      'claude-sonnet-4-5-20250929',
      'claude-opus-4-5-20251101'
    ])
  })

  it('allows custom model ids for model settings', () => {
    expect(validateSettingValue('extractionModel', 'claude-future-model')).toEqual({
      ok: true,
      normalized: 'claude-future-model'
    })
  })
})
