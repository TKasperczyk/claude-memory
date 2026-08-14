import { DEFAULT_CONFIG, type Config, type MemoryRecord } from '../../types.js'
import { batchUpdateRecords, iterateRecords } from '../../lancedb.js'
import { serializeRecord } from '../../lancedb-records.js'
import { createLogger } from '../../logger.js'
import { computeEntityIdf } from '../../entities.js'
import { normalizeRelations, upsertRelation } from '../../relations.js'
import { buildRecordSnippet, truncateSnippet } from '../../shared.js'
import { loadSettings, type RetrievalSettings } from '../../settings.js'
import { buildAction, buildErrorResult, buildResult, toErrorMessage } from './shared.js'
import type { MaintenanceRunResult } from './types.js'

const logger = createLogger('maintenance')

/** Entities in fewer than this many records cannot form an overlap edge. */
const ENTITY_MIN_DF = 2
/** Entities in more than this fraction of the corpus are treated as noise. */
const ENTITY_MAX_DF_RATIO = 0.1
/** Pair-explosion guard: a df-40 entity already yields 780 pairs. */
const ENTITY_BUCKET_CAP = 40
/**
 * Scales summed entity IDF into an edge weight. Hop expansion scores
 * candidates at rootScore * weight * hopDecay, so ~0.4 for a single strong
 * shared entity keeps entity edges conservative relative to co-occurrence
 * edges (weight = cooccurrenceCount / 10).
 */
const ENTITY_WEIGHT_MULTIPLIER = 0.4
/** Pairs below this weight are not worth an edge. */
const ENTITY_MIN_EDGE_WEIGHT = 0.1
// buildLanceRow throws above CONTENT_MAX_LENGTH (16384); leave headroom.
const CONTENT_SIZE_MARGIN = 16_000

type EntityPairCandidate = {
  a: string
  b: string
  sharedEntities: string[]
  weight: number
}

export async function runEntityOverlapDiscovery(
  dryRun: boolean,
  config: Config = DEFAULT_CONFIG,
  settings: Pick<RetrievalSettings, 'maxRelationsPerRecord'> = loadSettings()
): Promise<MaintenanceRunResult> {
  const actions: MaintenanceRunResult['actions'] = []
  const candidates: MaintenanceRunResult['candidates'] = []
  let scanned = 0
  let withEntities = 0
  let eligibleEntities = 0
  let pairs = 0
  let updated = 0
  let skipped = 0
  let errors = 0

  try {
    // Full JS scan (established pattern — see relations.ts cleanup pass):
    // entities live inside the content JSON, so no SQL-side filtering exists.
    const recordsById = new Map<string, MemoryRecord>()
    for await (const record of iterateRecords({ filter: 'deprecated = false', includeEmbeddings: true }, config)) {
      scanned += 1
      recordsById.set(record.id, record)
      if (record.entities && record.entities.length > 0) withEntities += 1
    }

    const buckets = buildEntityBuckets(recordsById)
    const corpusSize = recordsById.size
    const maxDf = Math.max(ENTITY_MIN_DF, Math.floor(corpusSize * ENTITY_MAX_DF_RATIO))

    const idfByEntity = new Map<string, number>()
    for (const [entity, ids] of buckets) {
      if (ids.length < ENTITY_MIN_DF || ids.length > maxDf || ids.length > ENTITY_BUCKET_CAP) continue
      idfByEntity.set(entity, computeEntityIdf(ids.length, corpusSize))
    }
    eligibleEntities = idfByEntity.size

    const pairCandidates = buildPairCandidates(buckets, idfByEntity)
    pairs = pairCandidates.length

    const changedRecordIds = new Set<string>()
    const maxRelationsPerRecord = Math.max(0, Math.trunc(settings.maxRelationsPerRecord))
    const now = new Date().toISOString()

    const pendingWrites = new Map<string, MemoryRecord>()
    for (const pair of pairCandidates) {
      const a = recordsById.get(pair.a)
      const b = recordsById.get(pair.b)
      if (!a || !b) {
        skipped += 1
        continue
      }
      // Records already related by any kind keep their existing edge; entity
      // overlap only adds edges that no other mechanism has discovered.
      if (hasAnyRelation(a, b.id) || hasAnyRelation(b, a.id)) {
        skipped += 1
        continue
      }

      const changedA = upsertRelation(a, { targetId: b.id, kind: 'shares_entity', weight: pair.weight, now })
      const changedB = upsertRelation(b, { targetId: a.id, kind: 'shares_entity', weight: pair.weight, now })
      if (changedA || changedB) {
        pendingWrites.set(a.id, a)
        pendingWrites.set(b.id, b)
        changedRecordIds.add(a.id)
        changedRecordIds.add(b.id)
      }

      actions.push(buildAction({
        type: 'update',
        recordId: a.id,
        snippet: truncateSnippet(buildRecordSnippet(a)),
        reason: `shares_entity ${b.id} via ${pair.sharedEntities.join(', ')}`,
        details: {
          targetId: b.id,
          kind: 'shares_entity',
          sharedEntities: pair.sharedEntities.join(', '),
          weight: pair.weight
        }
      }))
    }

    for (const record of pendingWrites.values()) {
      const capped = capSharesEntityRelations(record, maxRelationsPerRecord)
      if (capped) changedRecordIds.add(record.id)
      if (serializeRecord(record).length > CONTENT_SIZE_MARGIN) {
        // Weakest-first trim keeps the record under the content ceiling.
        trimSharesEntityRelations(record, CONTENT_SIZE_MARGIN)
      }
    }

    if (!dryRun && pendingWrites.size > 0) {
      const records = Array.from(pendingWrites.values())
      const result = await batchUpdateRecords(records, {}, config)
      if (result.failed > 0) {
        errors += result.failed
        logger.warn(`Failed to persist ${result.failed} entity-edge records`)
      }
      updated = result.updated
    } else {
      updated = changedRecordIds.size
    }
  } catch (error) {
    errors += 1
    logger.error(`Entity overlap discovery failed: ${toErrorMessage(error)}`)
    return buildErrorResult(
      actions,
      { scanned, withEntities, eligibleEntities, pairs, updated, skipped, errors },
      candidates,
      error
    )
  }

  logger.info(`Entity overlap discovery complete: ${pairs} pairs, ${updated} records updated, ${skipped} skipped`)
  return buildResult(actions, { scanned, withEntities, eligibleEntities, pairs, updated, skipped, errors }, candidates)
}

function buildEntityBuckets(recordsById: Map<string, MemoryRecord>): Map<string, string[]> {
  const buckets = new Map<string, string[]>()
  for (const record of recordsById.values()) {
    for (const entity of record.entities ?? []) {
      const bucket = buckets.get(entity)
      if (bucket) bucket.push(record.id)
      else buckets.set(entity, [record.id])
    }
  }
  return buckets
}

function buildPairCandidates(
  buckets: Map<string, string[]>,
  idfByEntity: Map<string, number>
): EntityPairCandidate[] {
  const sharedByPair = new Map<string, string[]>()
  for (const [entity, ids] of buckets) {
    if (!idfByEntity.has(entity)) continue
    const sorted = [...ids].sort()
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        const key = `${sorted[i]}\0${sorted[j]}`
        const shared = sharedByPair.get(key)
        if (shared) shared.push(entity)
        else sharedByPair.set(key, [entity])
      }
    }
  }

  const pairs: EntityPairCandidate[] = []
  for (const [key, sharedEntities] of sharedByPair) {
    const idfSum = sharedEntities.reduce((sum, entity) => sum + (idfByEntity.get(entity) ?? 0), 0)
    const weight = Math.min(1, ENTITY_WEIGHT_MULTIPLIER * idfSum)
    if (weight < ENTITY_MIN_EDGE_WEIGHT) continue
    const [a, b] = key.split('\0')
    pairs.push({ a, b, sharedEntities: [...sharedEntities].sort(), weight })
  }

  return pairs.sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight
    return `${a.a}:${a.b}`.localeCompare(`${b.a}:${b.b}`)
  })
}

function hasAnyRelation(record: MemoryRecord, targetId: string): boolean {
  return Boolean(record.relations?.some(relation => relation.targetId === targetId))
}

/**
 * Cap shares_entity edges per record, keeping the strongest. Mirrors
 * capRelatesToRelations in relations.ts, which deliberately caps only
 * relates_to — the two budgets are independent.
 */
function capSharesEntityRelations(record: MemoryRecord, maxRelationsPerRecord: number): boolean {
  const relations = normalizeRelations(record.relations)
  const others = relations.filter(relation => relation.kind !== 'shares_entity')
  const sharesEntity = relations
    .filter(relation => relation.kind === 'shares_entity')
    .sort((a, b) => {
      if (b.weight !== a.weight) return b.weight - a.weight
      return a.targetId.localeCompare(b.targetId)
    })
  const capped = maxRelationsPerRecord <= 0 ? [] : sharesEntity.slice(0, maxRelationsPerRecord)
  if (capped.length === sharesEntity.length) return false
  record.relations = [...others, ...capped]
  return true
}

function trimSharesEntityRelations(record: MemoryRecord, sizeMargin: number): void {
  while (serializeRecord(record).length > sizeMargin) {
    const relations = normalizeRelations(record.relations)
    const sharesEntity = relations.filter(relation => relation.kind === 'shares_entity')
    if (sharesEntity.length === 0) return
    const weakest = sharesEntity.reduce((min, relation) => (relation.weight < min.weight ? relation : min))
    record.relations = relations.filter(relation => relation !== weakest)
  }
}
