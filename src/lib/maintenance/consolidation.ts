import { CLAUDE_CODE_SYSTEM_PROMPT } from '../anthropic.js'
import {
  DEFAULT_CONFIG,
  type Config,
  type MemoryRecord,
  type RecordType
} from '../types.js'
import { buildFilter, queryRecords, updateRecord, vectorSearchSimilar } from '../lancedb.js'
import { resolveMaintenanceSettings, type MaintenanceSettings } from '../settings.js'
import { isPlainObject, isToolUseBlock, type ToolUseBlock } from '../parsing.js'
import { buildRecordSnippet, escapeFilterValue } from '../shared.js'
import {
  CONSOLIDATION_VERIFICATION_MAX_TOKENS,
  CONSOLIDATION_VERIFICATION_PROMPT,
  CONSOLIDATION_VERIFICATION_TOOL,
  CONSOLIDATION_VERIFICATION_TOOL_NAME,
  getAnthropicClient,
  buildGeneralizationInput
} from './prompts.js'
import { markDeprecated } from './operations.js'
import { QUERY_PAGE_SIZE, isValidEmbedding } from './scans.js'

interface ConsolidationResult {
  keptId: string
  deprecatedIds: string[]
  successCount: number
  failureCount: number
  retrievalCount: number
  usageCount: number
  lastUsed: number
}

interface ConsolidationMergeGroup {
  keptId: string
  mergedIds: string[]
  reason: string
  synthesizedFields?: Record<string, string>
}

interface ConsolidationVerificationResult {
  shouldMerge: boolean
  keptId?: string
  reason: string
  mergeGroups?: ConsolidationMergeGroup[]
}

interface ConsolidationClusterMember {
  record: MemoryRecord
  similarity: number
}

type ConsolidationCluster = MemoryRecord[] & {
  seedId: string
  members: ConsolidationClusterMember[]
}

const CROSS_TYPE_PRIORITY: Record<RecordType, number> = {
  procedure: 4,
  warning: 3,
  error: 2,
  discovery: 1,
  command: 0
}

class UnionFind {
  private parent = new Map<string, string>()
  private rank = new Map<string, number>()

  find(x: string): string {
    if (!this.parent.has(x)) {
      this.parent.set(x, x)
      this.rank.set(x, 0)
    }
    let root = x
    while (this.parent.get(root) !== root) root = this.parent.get(root)!
    // Path compression
    let current = x
    while (current !== root) {
      const next = this.parent.get(current)!
      this.parent.set(current, root)
      current = next
    }
    return root
  }

  union(a: string, b: string): void {
    const rootA = this.find(a)
    const rootB = this.find(b)
    if (rootA === rootB) return
    const rankA = this.rank.get(rootA) ?? 0
    const rankB = this.rank.get(rootB) ?? 0
    if (rankA < rankB) {
      this.parent.set(rootA, rootB)
    } else if (rankA > rankB) {
      this.parent.set(rootB, rootA)
    } else {
      this.parent.set(rootB, rootA)
      this.rank.set(rootA, rankA + 1)
    }
  }

  components(): Map<string, string[]> {
    const result = new Map<string, string[]>()
    for (const id of this.parent.keys()) {
      const root = this.find(id)
      if (!result.has(root)) result.set(root, [])
      result.get(root)!.push(id)
    }
    return result
  }
}

function buildClustersFromComponents(
  uf: UnionFind,
  recordById: Map<string, MemoryRecord>,
  bestSimilarity: Map<string, number>,
  maxClusterSize: number,
  requireMultipleTypes: boolean
): ConsolidationCluster[] {
  const clusters: ConsolidationCluster[] = []

  for (const memberIds of uf.components().values()) {
    if (memberIds.length < 2) continue

    const allMembers = memberIds
      .map(id => ({ record: recordById.get(id)!, similarity: bestSimilarity.get(id) ?? 0 }))
      .filter(m => m.record)

    if (allMembers.length < 2) continue

    if (requireMultipleTypes) {
      const types = new Set(allMembers.map(m => m.record.type))
      if (types.size < 2) continue
    }

    // Sort: seeds (similarity 1) first, then by similarity desc, stable by id
    const sorted = allMembers.sort((a, b) => {
      const simDiff = b.similarity - a.similarity
      if (simDiff !== 0) return simDiff
      return a.record.id < b.record.id ? -1 : 1
    })

    let capped: typeof sorted
    if (requireMultipleTypes && sorted.length > maxClusterSize) {
      // Prefer highest-similarity members, then try to inject type diversity.
      capped = sorted.slice(0, maxClusterSize)
      const initialTypes = new Set(capped.map(m => m.record.type))
      if (initialTypes.size < 2 && capped.length > 0) {
        const replacement = sorted
          .slice(maxClusterSize)
          .find(m => !initialTypes.has(m.record.type))
        if (replacement) capped[capped.length - 1] = replacement
      }
    } else {
      capped = sorted.slice(0, maxClusterSize)
    }
    if (capped.length < 2) continue

    if (requireMultipleTypes) {
      const typesIncluded = new Set(capped.map(m => m.record.type))
      if (typesIncluded.size < 2) continue
    }

    const members: ConsolidationClusterMember[] = capped.map(m => ({
      record: m.record,
      similarity: m.similarity
    }))

    const cluster = capped.map(m => m.record) as ConsolidationCluster
    cluster.seedId = capped[0].record.id
    cluster.members = members
    clusters.push(cluster)
  }

  return clusters
}

export async function findSimilarClusters(
  similarityThreshold: number | undefined = undefined,
  config: Config = DEFAULT_CONFIG,
  settings?: MaintenanceSettings
): Promise<ConsolidationCluster[]> {
  const maintenance = resolveMaintenanceSettings(settings)
  const resolvedThreshold = typeof similarityThreshold === 'number'
    ? similarityThreshold
    : maintenance.consolidationThreshold
  const recheckCutoff = Date.now() - maintenance.consolidationRecheckDays * 24 * 60 * 60 * 1000
  const recheckCutoffValue = Math.trunc(recheckCutoff)

  // Transitive clustering via union-find: collect all edges first, then merge
  // overlapping groups. This prevents greedy fragmentation where 5 related records
  // get split into disjoint pairs that the LLM evaluates (and rejects) individually.
  const uf = new UnionFind()
  const recordById = new Map<string, MemoryRecord>()
  const bestSimilarity = new Map<string, number>()
  let offset = 0

  while (true) {
    const batch = await queryRecords(
      {
        filter: 'deprecated = false',
        limit: QUERY_PAGE_SIZE,
        offset,
        includeEmbeddings: true
      },
      config
    )

    if (batch.length === 0) break

    for (const record of batch) {
      // Only seeds are gated by recheck cadence
      if (wasRecentlyConsolidationChecked(record, recheckCutoffValue)) continue
      if (!isValidEmbedding(record.embedding)) continue

      recordById.set(record.id, record)
      bestSimilarity.set(record.id, Math.max(bestSimilarity.get(record.id) ?? 0, 1))

      const matches = await vectorSearchSimilar(
        record.embedding,
        {
          filter: buildConsolidationFilter(record),
          limit: maintenance.consolidationSearchLimit,
          similarityThreshold: resolvedThreshold
        },
        config
      )

      for (const match of matches) {
        if (match.record.deprecated) continue
        recordById.set(match.record.id, match.record)
        bestSimilarity.set(match.record.id, Math.max(
          bestSimilarity.get(match.record.id) ?? 0,
          match.similarity
        ))
        uf.union(record.id, match.record.id)
      }
    }

    if (batch.length < QUERY_PAGE_SIZE) break
    offset += batch.length
  }

  return buildClustersFromComponents(
    uf, recordById, bestSimilarity,
    maintenance.consolidationMaxClusterSize, false
  )
}

export async function findCrossTypeClusters(
  similarityThreshold: number | undefined = undefined,
  config: Config = DEFAULT_CONFIG,
  settings?: MaintenanceSettings
): Promise<ConsolidationCluster[]> {
  const maintenance = resolveMaintenanceSettings(settings)
  const resolvedThreshold = typeof similarityThreshold === 'number'
    ? similarityThreshold
    : maintenance.crossTypeConsolidationThreshold
  const recheckCutoff = Date.now() - maintenance.consolidationRecheckDays * 24 * 60 * 60 * 1000
  const recheckCutoffValue = Math.trunc(recheckCutoff)

  const uf = new UnionFind()
  const recordById = new Map<string, MemoryRecord>()
  const bestSimilarity = new Map<string, number>()
  let offset = 0

  while (true) {
    const batch = await queryRecords(
      {
        filter: 'deprecated = false',
        limit: QUERY_PAGE_SIZE,
        offset,
        includeEmbeddings: true
      },
      config
    )

    if (batch.length === 0) break

    for (const record of batch) {
      if (wasRecentlyConsolidationChecked(record, recheckCutoffValue)) continue
      if (!isValidEmbedding(record.embedding)) continue

      recordById.set(record.id, record)
      bestSimilarity.set(record.id, Math.max(bestSimilarity.get(record.id) ?? 0, 1))

      const matches = await vectorSearchSimilar(
        record.embedding,
        {
          filter: buildCrossTypeConsolidationFilter(record),
          limit: maintenance.consolidationSearchLimit,
          similarityThreshold: resolvedThreshold
        },
        config
      )

      for (const match of matches) {
        if (match.record.deprecated) continue
        if (match.record.type === record.type) continue
        recordById.set(match.record.id, match.record)
        bestSimilarity.set(match.record.id, Math.max(
          bestSimilarity.get(match.record.id) ?? 0,
          match.similarity
        ))
        uf.union(record.id, match.record.id)
      }
    }

    if (batch.length < QUERY_PAGE_SIZE) break
    offset += batch.length
  }

  return buildClustersFromComponents(
    uf, recordById, bestSimilarity,
    maintenance.consolidationMaxClusterSize, true
  )
}

export async function consolidateCluster(
  cluster: MemoryRecord[],
  config: Config = DEFAULT_CONFIG,
  options: { keeperId?: string; deprecationReasonPrefix?: string } = {}
): Promise<ConsolidationResult | null> {
  if (cluster.length < 2) return null

  const explicitKeeper = options.keeperId
    ? cluster.find(record => record.id === options.keeperId)
    : undefined

  const keeper = explicitKeeper ?? [...cluster].sort((a, b) => {
    const successDiff = (b.successCount ?? 0) - (a.successCount ?? 0)
    if (successDiff !== 0) return successDiff
    const lastUsedDiff = (b.lastUsed ?? 0) - (a.lastUsed ?? 0)
    if (lastUsedDiff !== 0) return lastUsedDiff
    return (b.timestamp ?? 0) - (a.timestamp ?? 0)
  })[0]
  const totals = cluster.reduce(
    (acc, record) => {
      acc.success += record.successCount ?? 0
      acc.failure += record.failureCount ?? 0
      acc.retrieval += record.retrievalCount ?? 0
      acc.usage += record.usageCount ?? 0
      acc.lastUsed = Math.max(acc.lastUsed, record.lastUsed ?? 0)
      return acc
    },
    { success: 0, failure: 0, retrieval: 0, usage: 0, lastUsed: 0 }
  )

  const updates: Partial<MemoryRecord> = {
    successCount: totals.success,
    failureCount: totals.failure,
    retrievalCount: totals.retrieval,
    usageCount: totals.usage
  }
  if (totals.lastUsed > 0) {
    updates.lastUsed = totals.lastUsed
  }

  await updateRecord(keeper.id, updates, config)

  const deprecatedIds: string[] = []
  const reasonPrefix = options.deprecationReasonPrefix ?? 'consolidation'
  for (const record of cluster) {
    if (record.id === keeper.id) continue
    await markDeprecated(record.id, config, {
      supersedingRecordId: keeper.id,
      reason: `${reasonPrefix}:merged-into:${keeper.id}`
    })
    deprecatedIds.push(record.id)
  }

  return {
    keptId: keeper.id,
    deprecatedIds,
    successCount: totals.success,
    failureCount: totals.failure,
    retrievalCount: totals.retrieval,
    usageCount: totals.usage,
    lastUsed: totals.lastUsed
  }
}

function getUsageRatio(record: MemoryRecord): number {
  const retrievalCount = record.retrievalCount ?? 0
  const usageCount = record.usageCount ?? 0
  if (retrievalCount <= 0) return 0
  return usageCount / retrievalCount
}

export function pickConsolidationFallback(cluster: MemoryRecord[]): ConsolidationVerificationResult {
  const sorted = [...cluster].sort((a, b) => {
    const typeDiff = (CROSS_TYPE_PRIORITY[b.type] ?? 0) - (CROSS_TYPE_PRIORITY[a.type] ?? 0)
    if (typeDiff !== 0) return typeDiff
    const usageRatioDiff = getUsageRatio(b) - getUsageRatio(a)
    if (usageRatioDiff !== 0) return usageRatioDiff
    const usageDiff = (b.usageCount ?? 0) - (a.usageCount ?? 0)
    if (usageDiff !== 0) return usageDiff
    const successDiff = (b.successCount ?? 0) - (a.successCount ?? 0)
    if (successDiff !== 0) return successDiff
    const lastUsedDiff = (b.lastUsed ?? 0) - (a.lastUsed ?? 0)
    if (lastUsedDiff !== 0) return lastUsedDiff
    return (b.timestamp ?? 0) - (a.timestamp ?? 0)
  })

  const keeper = sorted[0]
  return { shouldMerge: true, keptId: keeper.id, reason: 'fallback: best by type, usage, and recency' }
}

/** @deprecated Use pickConsolidationFallback instead */
export function pickCrossTypeFallback(cluster: MemoryRecord[]): ConsolidationVerificationResult {
  return pickConsolidationFallback(cluster)
}

function buildConsolidationVerificationInput(cluster: MemoryRecord[], crossType: boolean): Record<string, unknown> {
  const types = new Set(cluster.map(r => r.type))
  return {
    crossType,
    clusterTypes: Array.from(types),
    typePriority: crossType ? ['procedure', 'warning', 'error', 'discovery', 'command'] : undefined,
    records: cluster.map(record => ({
      id: record.id,
      type: record.type,
      snippet: buildRecordSnippet(record),
      usageCount: record.usageCount ?? 0,
      retrievalCount: record.retrievalCount ?? 0,
      usageRatio: getUsageRatio(record),
      successCount: record.successCount ?? 0,
      failureCount: record.failureCount ?? 0,
      lastUsed: record.lastUsed ?? 0,
      timestamp: record.timestamp ?? 0,
      record: buildGeneralizationInput(record)
    }))
  }
}

function coerceConsolidationVerification(value: unknown): ConsolidationVerificationResult | null {
  if (!isPlainObject(value)) return null
  const reason = typeof value.reason === 'string' ? value.reason.trim() : ''
  if (!reason) return null

  // New format: mergeGroups array
  if (Array.isArray(value.mergeGroups)) {
    const mergeGroups: ConsolidationMergeGroup[] = []
    for (const group of value.mergeGroups) {
      if (!isPlainObject(group)) continue
      const keptId = typeof group.keptId === 'string' ? group.keptId.trim() : ''
      const mergedIds = Array.isArray(group.mergedIds)
        ? (group.mergedIds as unknown[])
          .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
          .map(id => id.trim())
        : []
      const groupReason = typeof group.reason === 'string' ? group.reason.trim() : reason

      // Parse optional synthesized fields
      let synthesizedFields: Record<string, string> | undefined
      if (isPlainObject(group.synthesizedFields)) {
        const fields: Record<string, string> = {}
        for (const [key, val] of Object.entries(group.synthesizedFields as Record<string, unknown>)) {
          if (typeof val === 'string' && val.trim().length > 0) {
            fields[key] = val.trim()
          }
        }
        if (Object.keys(fields).length > 0) synthesizedFields = fields
      }

      // Remove self-merges and dedupe
      const cleanMergedIds = [...new Set(mergedIds.filter(id => id !== keptId))]
      if (keptId && cleanMergedIds.length > 0) {
        mergeGroups.push({ keptId, mergedIds: cleanMergedIds, reason: groupReason, synthesizedFields })
      }
    }

    // Enforce disjointness: a record can only appear in one group
    const claimed = new Set<string>()
    const validGroups = mergeGroups.filter(group => {
      const ids = [group.keptId, ...group.mergedIds]
      if (ids.some(id => claimed.has(id))) return false
      for (const id of ids) claimed.add(id)
      return true
    })

    const shouldMerge = validGroups.length > 0
    return {
      shouldMerge,
      keptId: validGroups[0]?.keptId,
      reason,
      mergeGroups: shouldMerge ? validGroups : undefined
    }
  }

  // Legacy format: shouldMerge + keptId
  const shouldMerge = typeof value.shouldMerge === 'boolean' ? value.shouldMerge : null
  const keptId = typeof value.keptId === 'string' ? value.keptId.trim() : ''
  if (shouldMerge === null) return null
  if (shouldMerge && !keptId) return null
  return { shouldMerge, keptId: keptId || undefined, reason }
}

/**
 * Normalize a verification result into merge groups.
 * Handles both new (mergeGroups) and legacy (keptId) formats.
 */
export function resolveMergeGroups(
  verification: ConsolidationVerificationResult,
  clusterRecords: MemoryRecord[]
): ConsolidationMergeGroup[] {
  if (verification.mergeGroups && verification.mergeGroups.length > 0) {
    return verification.mergeGroups
  }
  // Legacy: merge all into keptId
  if (verification.keptId) {
    return [{
      keptId: verification.keptId,
      mergedIds: clusterRecords.filter(r => r.id !== verification.keptId).map(r => r.id),
      reason: verification.reason
    }]
  }
  return []
}

/**
 * LLM-based verification for consolidation clusters.
 * Determines if records should be merged and selects the best representative.
 */
export async function llmVerifyConsolidation(
  cluster: MemoryRecord[],
  config: Config,
  options: { crossType?: boolean } = {}
): Promise<ConsolidationVerificationResult> {
  const client = await getAnthropicClient()
  if (!client) {
    throw new Error('No authentication available for consolidation verification.')
  }

  const crossType = options.crossType ?? false
  const payload = JSON.stringify(buildConsolidationVerificationInput(cluster, crossType), null, 2)

  const response = await client.messages.create({
    model: config.extraction.model,
    max_tokens: Math.min(CONSOLIDATION_VERIFICATION_MAX_TOKENS, config.extraction.maxTokens),
    temperature: 0,
    system: [
      { type: 'text', text: CLAUDE_CODE_SYSTEM_PROMPT },
      { type: 'text', text: CONSOLIDATION_VERIFICATION_PROMPT }
    ],
    messages: [{ role: 'user', content: `Records:\n${payload}` }],
    tools: [CONSOLIDATION_VERIFICATION_TOOL],
    tool_choice: { type: 'tool', name: CONSOLIDATION_VERIFICATION_TOOL_NAME }
  })

  const toolInput = response.content.find((block): block is ToolUseBlock =>
    isToolUseBlock(block) && block.name === CONSOLIDATION_VERIFICATION_TOOL_NAME
  )?.input

  if (!toolInput) {
    throw new Error('Consolidation verification tool call missing in response.')
  }

  const parsed = coerceConsolidationVerification(toolInput)
  if (!parsed) {
    throw new Error('Consolidation verification response invalid or incomplete.')
  }

  if (parsed.shouldMerge) {
    const validIds = new Set(cluster.map(record => record.id))
    const allReferencedIds = parsed.mergeGroups
      ? parsed.mergeGroups.flatMap(g => [g.keptId, ...g.mergedIds])
      : parsed.keptId ? [parsed.keptId] : []
    for (const id of allReferencedIds) {
      if (!validIds.has(id)) {
        throw new Error(`Consolidation verification response referenced an unknown record: ${id}`)
      }
    }
  }

  return parsed
}

/** @deprecated Use llmVerifyConsolidation instead */
export async function selectCrossTypeRepresentative(
  cluster: MemoryRecord[],
  config: Config
): Promise<ConsolidationVerificationResult> {
  return llmVerifyConsolidation(cluster, config, { crossType: true })
}

function wasRecentlyConsolidationChecked(record: MemoryRecord, cutoff: number): boolean {
  const lastCheck = record.lastConsolidationCheck ?? 0
  return lastCheck !== 0 && lastCheck >= cutoff
}

function buildConsolidationFilter(record: MemoryRecord): string {
  // Only filter by type - no project filter so we find cross-project duplicates
  return buildFilter({
    type: record.type,
    excludeId: record.id,
    excludeDeprecated: true
  }) ?? 'deprecated = false'
}

function buildCrossTypeConsolidationFilter(record: MemoryRecord): string {
  const baseFilter = buildFilter({
    excludeId: record.id,
    excludeDeprecated: true
  }) ?? 'deprecated = false'
  return `${baseFilter} AND type <> '${escapeFilterValue(record.type)}'`
}
