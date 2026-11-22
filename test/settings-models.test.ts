import { describe, expect, it } from 'vitest'
import { DEFAULT_MODEL_SETTINGS, MODEL_OPTIONS } from '../src/lib/settings-schema.js'
import { validateSettingValue } from '../src/lib/settings.js'

describe('model settings', () => {
  it('uses the current default models and keeps legacy options selectable', () => {
    expect(DEFAULT_MODEL_SETTINGS).toEqual({
      extractionModel: 'claude-sonnet-5-5',
      reviewModel: 'claude-opus-5-5',
      chatModel: 'claude-opus-5-5'
    })
    expect(MODEL_OPTIONS.map(option => option.value)).toEqual([
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-fable-5-2',
      'claude-fable-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      'claude-haiku-5-5',
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
