import { describe, expect, it } from 'vitest'
import { randomUUID } from 'crypto'
import {
  computeEntityIdf,
  extractEntityNeedles,
  normalizeEntities,
  normalizeEntity
} from '../src/lib/entities.js'
import { normalizeRelations } from '../src/lib/relations.js'
import { buildExactText } from '../src/lib/shared.js'
import {
  buildEmbeddingInput,
  needsEmbeddingRefresh,
  parseRecordFromRow
} from '../src/lib/lancedb-records.js'
import { getDefaultRetrievalSettings } from '../src/lib/settings.js'
import type { DiscoveryRecord } from '../src/lib/types.js'

const SAMPLE_ENTITIES = ['phantom', 'src/lib/retrieval.ts', 'claude-memory']

function makeDiscovery(overrides: Partial<DiscoveryRecord> = {}): DiscoveryRecord {
  return {
    id: randomUUID(),
    type: 'discovery',
    what: 'LanceDB stores relations inside the content JSON column',
    where: 'src/lib/lancedb-records.ts',
    evidence: 'serializeRecord embeds the full record as JSON',
    confidence: 'verified',
    project: '/test/project',
    scope: 'project',
    timestamp: Date.now(),
    ...overrides
  }
}

describe('normalizeEntity', () => {
  it('lowercases, trims, and strips wrapping/trailing punctuation', () => {
    expect(normalizeEntity('  Phantom  ')).toBe('phantom')
    expect(normalizeEntity('`claude-memory`')).toBe('claude-memory')
    expect(normalizeEntity('"config.json".')).toBe('config.json')
    expect(normalizeEntity('retrieval.ts:')).toBe('retrieval.ts')
  })

  it('rejects non-strings, short/long values, letterless values, and generic terms', () => {
    expect(normalizeEntity(42)).toBeNull()
    expect(normalizeEntity(undefined)).toBeNull()
    expect(normalizeEntity('p4')).toBeNull()
    expect(normalizeEntity('x'.repeat(121))).toBeNull()
    expect(normalizeEntity('19530')).toBeNull()
    expect(normalizeEntity('1.2.3')).toBeNull()
    expect(normalizeEntity('git')).toBeNull()
    expect(normalizeEntity('Config')).toBeNull()
  })

  it('keeps digit-bearing values containing letters', () => {
    expect(normalizeEntity('sha256')).toBe('sha256')
    expect(normalizeEntity('10.0.6.23:8080x')).toBe('10.0.6.23:8080x')
  })
})

describe('normalizeEntities', () => {
  it('coerces, dedupes case-insensitively, and caps at 8', () => {
    const values = ['Phantom', 'phantom', 'arroyo', 42, '', ...Array.from({ length: 10 }, (_, i) => `entity-${i}`)]
    const entities = normalizeEntities(values)
    expect(entities[0]).toBe('phantom')
    expect(entities[1]).toBe('arroyo')
    expect(entities).toHaveLength(8)
  })

  it('returns empty array for non-arrays', () => {
    expect(normalizeEntities('phantom')).toEqual([])
    expect(normalizeEntities(null)).toEqual([])
  })
})

describe('extractEntityNeedles', () => {
  const PROMPT = 'Check the systemd unit on Phantom for mic_cms and look at src/lib/retrieval.ts plus the ESXi host'

  it('extracts pathish tokens first, then proper nouns and compounds', () => {
    const needles = extractEntityNeedles(PROMPT, 3)
    expect(needles[0]).toBe('src/lib/retrieval.ts')
    expect(needles).toContain('phantom')
    expect(needles).toHaveLength(3)
  })

  it('ignores plain lowercase words unless present in the vocabulary', () => {
    const withoutVocab = extractEntityNeedles('restart caddy on the apps box', 5)
    expect(withoutVocab).toEqual([])

    const withVocab = extractEntityNeedles('restart caddy on the apps box', 5, new Set(['caddy']))
    expect(withVocab).toEqual(['caddy'])
  })

  it('respects the needle budget and returns nothing for a zero budget', () => {
    expect(extractEntityNeedles(PROMPT, 0)).toEqual([])
    expect(extractEntityNeedles(PROMPT, 1)).toHaveLength(1)
  })
})

describe('computeEntityIdf', () => {
  it('is 1 near df=2, decays with df, clamped to [0, 1]', () => {
    expect(computeEntityIdf(2, 1000)).toBeCloseTo(1, 5)
    const atTenPercent = computeEntityIdf(100, 1000)
    expect(atTenPercent).toBeGreaterThan(0.3)
    expect(atTenPercent).toBeLessThan(0.5)
    expect(computeEntityIdf(500, 1000)).toBeLessThan(atTenPercent)
    expect(computeEntityIdf(1, 1000)).toBe(1)
    expect(computeEntityIdf(0, 1000)).toBe(0)
    expect(computeEntityIdf(1000, 1000)).toBe(0)
  })
})

describe('shares_entity relation kind', () => {
  it('survives normalizeRelations', () => {
    const relations = normalizeRelations([
      {
        targetId: randomUUID(),
        kind: 'shares_entity',
        weight: 0.4,
        createdAt: new Date().toISOString(),
        lastReinforcedAt: new Date().toISOString(),
        reinforcementCount: 1
      }
    ])
    expect(relations).toHaveLength(1)
    expect(relations[0].kind).toBe('shares_entity')
  })
})

describe('entities on records', () => {
  it('round-trips through content JSON serialization', () => {
    const record = makeDiscovery({ entities: SAMPLE_ENTITIES })
    const row = { id: record.id, type: record.type, content: JSON.stringify(record) }
    const parsed = parseRecordFromRow(row)
    expect(parsed?.entities).toEqual(SAMPLE_ENTITIES)
  })

  it('stays out of exact text and embedding input', () => {
    const bare = makeDiscovery()
    const withEntities = { ...bare, entities: SAMPLE_ENTITIES }
    expect(buildExactText(withEntities)).toBe(buildExactText(bare))
    expect(buildEmbeddingInput(withEntities)).toBe(buildEmbeddingInput(bare))
  })

  it('does not trigger an embedding refresh when added to a record', () => {
    const bare = makeDiscovery()
    const withEntities = { ...bare, entities: SAMPLE_ENTITIES }
    expect(needsEmbeddingRefresh(bare, withEntities)).toBe(false)
  })
})

describe('entity retrieval settings', () => {
  it('default to disabled', () => {
    const defaults = getDefaultRetrievalSettings()
    expect(defaults.enableEntityEdges).toBe(false)
    expect(defaults.enableEntityKeywords).toBe(false)
  })
})
