import { DEFAULT_CONFIG, type Config, type MemoryRecord } from '../../types.js'
import { batchUpdateRecords, fetchRecordsByIds, iterateRecords } from '../../lancedb.js'
import { createLogger } from '../../logger.js'
import { normalizeRelations, upsertRelation } from '../../relations.js'
import { buildRecordSnippet, truncateSnippet } from '../../shared.js'
import { listRetrievalEvents } from '../../retrieval-events.js'
import { loadSettings, type RetrievalSettings } from '../../settings.js'
import { buildAction, buildErrorResult, buildResult, toErrorMessage } from './shared.js'
import type { MaintenanceRunResult } from './types.js'

const logger = createLogger('maintenance')
const RELATION_DISCOVERY_DAYS = 30
const RELATION_COOCCURRENCE_THRESHOLD = 3

type PairCandidate = {
  a: string
  b: string
  count: number
  latestTimestamp: number
  weight: number
}

type InjectionGroup = {
  ids: string[]
  timestamp: number
}

type PairCount = {
  count: number
  latestTimestamp: number
}

export async function runRelationDiscovery(
  dryRun: boolean,
  config: Config = DEFAULT_CONFIG,
  settings: Pick<RetrievalSettings, 'maxRelationsPerRecord'> = loadSettings()
): Promise<MaintenanceRunResult> {
  const actions: MaintenanceRunResult['actions'] = []
  const candidates: MaintenanceRunResult['candidates'] = []
  let groups = 0
  let pairs = 0
  let eligiblePairs = 0
  let updated = 0
  let skipped = 0
  let errors = 0

  try {
    const events = listRetrievalEvents({
      collection: config.lancedb.table,
      days: RELATION_DISCOVERY_DAYS
    })
    const groupsById = buildInjectionGroups(events)
    groups = groupsById.size
    const pairCounts = countPairs(groupsById)
    pairs = pairCounts.size
    const pairCandidates: PairCandidate[] = Array.from(pairCounts.entries())
      .map(([key, pair]) => {
        const [a, b] = key.split('\0')
        return {
          a,
          b,
          count: pair.count,
          latestTimestamp: pair.latestTimestamp,
          weight: Math.min(1, pair.count / 10)
        }
      })
      .filter(pair => pair.count >= RELATION_COOCCURRENCE_THRESHOLD)
      .sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count
        return `${a.a}:${a.b}`.localeCompare(`${b.a}:${b.b}`)
      })

    eligiblePairs = pairCandidates.length

    const ids = uniqueIds(pairCandidates.flatMap(pair => [pair.a, pair.b]))
    const records = await fetchRecordsByIds(ids, config, { includeEmbeddings: true })
    const recordsById = new Map(records.map(record => [record.id, record]))
    const changedRecordIds = new Set<string>()
    const maxRelationsPerRecord = Math.max(0, Math.trunc(settings.maxRelationsPerRecord))

    for (const pair of pairCandidates) {
      const a = recordsById.get(pair.a)
      const b = recordsById.get(pair.b)
      if (!a || !b || a.deprecated || b.deprecated) {
        skipped += 1
        continue
      }

      const changedA = upsertRelation(a, {
        targetId: b.id,
        kind: 'relates_to',
        weight: pair.weight,
        reinforcementCount: pair.count,
        reinforcementMode: 'set',
        now: new Date(pair.latestTimestamp).toISOString()
      })
      const changedB = upsertRelation(b, {
        targetId: a.id,
        kind: 'relates_to',
        weight: pair.weight,
        reinforcementCount: pair.count,
        reinforcementMode: 'set',
        now: new Date(pair.latestTimestamp).toISOString()
      })
      const cappedA = capRelatesToRelations(a, maxRelationsPerRecord)
      const cappedB = capRelatesToRelations(b, maxRelationsPerRecord)

      if (changedA || changedB || cappedA || cappedB) {
        if (dryRun) {
          changedRecordIds.add(a.id)
          changedRecordIds.add(b.id)
        } else {
          try {
            const result = await batchUpdateRecords([a, b], {}, config)
            if (result.updated === 2 && result.failed === 0) {
              changedRecordIds.add(a.id)
              changedRecordIds.add(b.id)
            } else {
              errors += Math.max(1, result.failed)
              logger.warn(`Failed to persist bidirectional relation pair ${a.id}<->${b.id}; updated=${result.updated}, failed=${result.failed}`)
            }
          } catch (error) {
            errors += 1
            logger.warn(`Failed to persist bidirectional relation pair ${a.id}<->${b.id}: ${toErrorMessage(error)}`)
          }
        }
      }

      actions.push(buildAction({
        type: 'update',
        recordId: a.id,
        snippet: truncateSnippet(buildRecordSnippet(a)),
        reason: `relates_to ${b.id} via ${pair.count} co-injections`,
        details: {
          targetId: b.id,
          kind: 'relates_to',
          cooccurrenceCount: pair.count,
          weight: pair.weight
        }
      }))
    }

    const cleanupRecords = await collectRelationCleanupRecords(pairCounts, maxRelationsPerRecord, config)
    if (!dryRun && cleanupRecords.length > 0) {
      const result = await batchUpdateRecords(cleanupRecords, {}, config)
      if (result.updated === cleanupRecords.length && result.failed === 0) {
        for (const record of cleanupRecords) changedRecordIds.add(record.id)
      } else {
        errors += Math.max(1, result.failed)
        logger.warn(`Failed to persist ${result.failed} relation-cleanup records`)
      }
    } else if (dryRun) {
      for (const record of cleanupRecords) changedRecordIds.add(record.id)
    }

    updated = changedRecordIds.size
  } catch (error) {
    errors += 1
    logger.error(`Relation discovery failed: ${toErrorMessage(error)}`)
    return buildErrorResult(
      actions,
      { groups, pairs, eligiblePairs, updated, skipped, errors },
      candidates,
      error
    )
  }

  logger.info(`Relation discovery complete: ${eligiblePairs} eligible pairs, ${updated} records updated, ${skipped} skipped`)
  return buildResult(actions, { groups, pairs, eligiblePairs, updated, skipped, errors }, candidates)
}

function buildInjectionGroups(events: ReturnType<typeof listRetrievalEvents>): Map<string, InjectionGroup> {
  const groups = new Map<string, { ids: Set<string>; timestamp: number }>()
  for (const event of events) {
    if (!event.groupId || !event.coInjectedIds || event.coInjectedIds.length < 2) continue
    const group = groups.get(event.groupId) ?? { ids: new Set<string>(), timestamp: event.timestamp }
    for (const id of event.coInjectedIds) {
      if (id) group.ids.add(id)
    }
    group.timestamp = Math.max(group.timestamp, event.timestamp)
    groups.set(event.groupId, group)
  }

  return new Map(
    Array.from(groups.entries())
      .map(([groupId, group]) => [groupId, { ids: Array.from(group.ids).sort(), timestamp: group.timestamp }] as const)
      .filter(([, group]) => group.ids.length >= 2)
  )
}

function countPairs(groups: Map<string, InjectionGroup>): Map<string, PairCount> {
  const counts = new Map<string, PairCount>()
  for (const group of groups.values()) {
    const { ids } = group
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const key = pairKey(ids[i], ids[j])
        const existing = counts.get(key)
        counts.set(key, {
          count: (existing?.count ?? 0) + 1,
          latestTimestamp: Math.max(existing?.latestTimestamp ?? 0, group.timestamp)
        })
      }
    }
  }
  return counts
}

function uniqueIds(ids: string[]): string[] {
  return Array.from(new Set(ids.filter(id => id.trim().length > 0)))
}

async function collectRelationCleanupRecords(
  observedPairs: Map<string, PairCount>,
  maxRelationsPerRecord: number,
  config: Config
): Promise<MemoryRecord[]> {
  const changed: MemoryRecord[] = []

  for await (const record of iterateRecords({ includeEmbeddings: true }, config)) {
    if (!record.relations || record.relations.length === 0) continue

    const pruned = pruneStaleRelatesTo(record, observedPairs)
    const capped = capRelatesToRelations(record, maxRelationsPerRecord)
    if (pruned || capped) {
      changed.push(record)
    }
  }

  return changed
}

function pruneStaleRelatesTo(record: MemoryRecord, observedPairs: Map<string, PairCount>): boolean {
  const relations = normalizeRelations(record.relations)
  const next = relations.filter(relation =>
    relation.kind !== 'relates_to' || observedPairs.has(pairKey(record.id, relation.targetId))
  )
  if (next.length === relations.length) return false
  record.relations = next
  return true
}

function capRelatesToRelations(record: MemoryRecord, maxRelationsPerRecord: number): boolean {
  const relations = normalizeRelations(record.relations)
  const persistent = relations.filter(relation => relation.kind !== 'relates_to')
  const relatesTo = relations
    .filter(relation => relation.kind === 'relates_to')
    .sort((a, b) => {
      if (b.weight !== a.weight) return b.weight - a.weight
      if (b.reinforcementCount !== a.reinforcementCount) return b.reinforcementCount - a.reinforcementCount
      const bTime = Date.parse(b.lastReinforcedAt)
      const aTime = Date.parse(a.lastReinforcedAt)
      if (bTime !== aTime) return bTime - aTime
      return a.targetId.localeCompare(b.targetId)
    })
  const capped = maxRelationsPerRecord <= 0 ? [] : relatesTo.slice(0, maxRelationsPerRecord)
  if (capped.length === relatesTo.length && relations.length === persistent.length + capped.length) return false
  record.relations = [...persistent, ...capped]
  return true
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}\0${b}` : `${b}\0${a}`
}
