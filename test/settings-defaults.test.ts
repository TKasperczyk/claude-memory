import { describe, expect, it } from 'vitest'
import { DEFAULT_MAINTENANCE_SETTINGS, DEFAULT_RETRIEVAL_SETTINGS, RETRIEVAL_FIELDS } from '../src/lib/settings-schema.js'
import { validateSettingValue } from '../src/lib/settings.js'

describe('retrieval and maintenance setting defaults', () => {
  it('uses the empirically selected semantic thresholds', () => {
    expect(DEFAULT_RETRIEVAL_SETTINGS.minSemanticSimilarity).toBe(0.65)
    expect(DEFAULT_RETRIEVAL_SETTINGS.semanticAnchorThreshold).toBe(0.65)
    expect(RETRIEVAL_FIELDS.find(field => field.key === 'semanticAnchorThreshold')?.description).toContain(
      'qualified raw-keyword matches survive'
    )
  })

  it('defines and validates the consolidation no-merge backoff', () => {
    expect(DEFAULT_MAINTENANCE_SETTINGS.consolidationNoMergeBackoffDays).toBe(90)
    expect(validateSettingValue('consolidationNoMergeBackoffDays', '120')).toEqual({
      ok: true,
      normalized: 120
    })
    expect(validateSettingValue('consolidationNoMergeBackoffDays', 0)).toEqual({
      ok: false,
      error: 'value must be >= 1'
    })
  })

  it('enables memory_write hints by default and validates boolean overrides', () => {
    expect(DEFAULT_MAINTENANCE_SETTINGS.enableMemoryWriteHints).toBe(true)
    expect(validateSettingValue('enableMemoryWriteHints', false)).toEqual({
      ok: true,
      normalized: false
    })
    expect(validateSettingValue('enableMemoryWriteHints', 'true')).toEqual({
      ok: true,
      normalized: true
    })
    expect(validateSettingValue('enableMemoryWriteHints', 'yes')).toEqual({
      ok: false,
      error: 'value must be a boolean'
    })
  })
})
