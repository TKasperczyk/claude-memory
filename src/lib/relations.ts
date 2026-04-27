import type { MemoryRecord, Relation, RelationKind } from './types.js'

export type RelationInput = {
  targetId: string
  kind: RelationKind
  weight: number
  reinforcementCount?: number
  reinforcementMode?: 'increment' | 'set'
  now?: string
}

export function normalizeRelations(value: unknown): Relation[] {
  if (!Array.isArray(value)) return []

  const relations: Relation[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const relation = normalizeRelation(item)
    if (!relation) continue
    const key = relationKey(relation.targetId, relation.kind)
    if (seen.has(key)) continue
    seen.add(key)
    relations.push(relation)
  }
  return relations
}

export function upsertRelation(record: MemoryRecord, input: RelationInput): boolean {
  const targetId = input.targetId.trim()
  if (!targetId || targetId === record.id) return false

  const now = input.now ?? new Date().toISOString()
  const weight = clampWeight(input.weight)
  const reinforcementCount = Math.max(0, Math.trunc(input.reinforcementCount ?? 1))
  const shouldSetCount = input.reinforcementMode === 'set'
  const reinforcementDelta = Math.max(1, reinforcementCount)
  const relations = normalizeRelations(record.relations)
  const existing = relations.find(relation =>
    relation.targetId === targetId && relation.kind === input.kind
  )

  if (existing) {
    existing.weight = shouldSetCount ? weight : Math.max(existing.weight, weight)
    existing.lastReinforcedAt = now
    existing.reinforcementCount = shouldSetCount
      ? reinforcementCount
      : Math.max(0, existing.reinforcementCount) + reinforcementDelta
    record.relations = relations
    return true
  }

  relations.push({
    targetId,
    kind: input.kind,
    weight,
    createdAt: now,
    lastReinforcedAt: now,
    reinforcementCount: shouldSetCount ? reinforcementCount : reinforcementDelta
  })
  record.relations = relations
  return true
}

function normalizeRelation(value: unknown): Relation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const targetId = typeof raw.targetId === 'string' ? raw.targetId.trim() : ''
  const kind = normalizeRelationKind(raw.kind)
  const weight = normalizeWeight(raw.weight)
  const createdAt = normalizeDateString(raw.createdAt)
  const lastReinforcedAt = normalizeDateString(raw.lastReinforcedAt)
  const reinforcementCount = normalizeCount(raw.reinforcementCount)
  if (!targetId || !kind || weight === null || !createdAt || !lastReinforcedAt || reinforcementCount === null) {
    return null
  }
  return { targetId, kind, weight, createdAt, lastReinforcedAt, reinforcementCount }
}

function normalizeRelationKind(value: unknown): RelationKind | null {
  return value === 'relates_to' || value === 'supersedes' ? value : null
}

function normalizeWeight(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return clampWeight(value)
}

function normalizeCount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.max(0, Math.trunc(value))
}

function normalizeDateString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const timestamp = Date.parse(trimmed)
  return Number.isNaN(timestamp) ? null : trimmed
}

function clampWeight(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

function relationKey(targetId: string, kind: RelationKind): string {
  return `${kind}:${targetId}`
}
