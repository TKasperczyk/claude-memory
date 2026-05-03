import { describe, expect, it } from 'vitest'
import { classifySimilarityTier } from '../scripts/audit-deprecation-similarity.js'

describe('deprecation similarity audit tiering', () => {
  it('labels a high-similarity candidate with a wide margin as strong active', () => {
    const result = classifySimilarityTier([
      { id: 'active-1', similarity: 0.86 },
      { id: 'active-2', similarity: 0.80 }
    ])

    expect(result).toEqual({
      tier: 'strong-similar-active',
      label: 'audit:strong-similar-active:active-1:0.860',
      margin: 0.06,
      topCandidateId: 'active-1',
      topSimilarity: 0.86
    })
  })

  it('labels a high-similarity candidate with a thin margin as strong multi', () => {
    const result = classifySimilarityTier([
      { id: 'active-1', similarity: 0.86 },
      { id: 'active-2', similarity: 0.84 }
    ])

    expect(result).toEqual({
      tier: 'strong-similar-multi',
      label: 'audit:strong-similar-multi:0.860',
      margin: 0.02,
      topSimilarity: 0.86
    })
  })

  it('labels mid-similarity candidates as weak active', () => {
    const result = classifySimilarityTier([
      { id: 'active-1', similarity: 0.75 },
      { id: 'active-2', similarity: 0.60 }
    ])

    expect(result).toEqual({
      tier: 'weak-similar-active',
      label: 'audit:weak-similar-active:active-1:0.750',
      margin: 0.15,
      topCandidateId: 'active-1',
      topSimilarity: 0.75
    })
  })

  it('labels low-similarity candidates as no similar active', () => {
    const result = classifySimilarityTier([
      { id: 'active-1', similarity: 0.64 },
      { id: 'active-2', similarity: 0.63 }
    ])

    expect(result).toEqual({
      tier: 'no-similar-active',
      label: 'audit:no-similar-active',
      margin: 0.01,
      topCandidateId: 'active-1',
      topSimilarity: 0.64
    })
  })

  it('labels empty candidate sets as no similar active', () => {
    const result = classifySimilarityTier([])

    expect(result).toEqual({
      tier: 'no-similar-active',
      label: 'audit:no-similar-active',
      margin: null,
      topCandidateId: undefined,
      topSimilarity: undefined
    })
  })
})
