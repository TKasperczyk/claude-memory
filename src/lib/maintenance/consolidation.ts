import { CLAUDE_CODE_SYSTEM_PROMPT } from '../anthropic.js'
import {
  DEFAULT_CONFIG,
  type Config,
  type MemoryRecord,
  type RecordType
} from '../types.js'
import { buildFilter, queryRecords, updateRecord, vectorSearchSimilar } from '../milvus.js'
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

interface ConsolidationVerificationResult {
  shouldMerge: boolean
  keptId?: string
  reason: string
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
  const clusters: ConsolidationCluster[] = []
  const clusteredIds = new Set<string>()
  let offset = 0

  while (true) {
    const batch = await queryRecords(
      {
        filter: 'deprecated == false',
        limit: QUERY_PAGE_SIZE,
        offset,
        includeEmbeddings: true
      },
      config
    )

    if (batch.length === 0) break

    for (const record of batch) {
      if (clusteredIds.has(record.id)) continue
      if (wasRecentlyConsolidationChecked(record, recheckCutoffValue)) continue
      if (!isValidEmbedding(record.embedding)) continue

      const matches = await vectorSearchSimilar(
        record.embedding,
        {
          filter: buildConsolidationFilter(record),
          limit: maintenance.consolidationSearchLimit,
          similarityThreshold: resolvedThreshold
        },
        config
      )

      const members: ConsolidationClusterMember[] = [{ record, similarity: 1 }]
      // Keep clusters array-like for older callers while exposing metadata for new consumers.
      const cluster = [record] as ConsolidationCluster
      cluster.seedId = record.id
      cluster.members = members
      for (const match of matches) {
        const candidate = match.record
        if (clusteredIds.has(candidate.id)) continue
        if (candidate.deprecated) continue
        if (wasRecentlyConsolidationChecked(candidate, recheckCutoffValue)) continue

        // Rely purely on vector similarity - text similarity check was too strict
        // and missed semantic duplicates with different wording
        cluster.push(candidate)
        members.push({ record: candidate, similarity: match.similarity })
        if (cluster.length >= maintenance.consolidationMaxClusterSize) break
      }

      if (cluster.length > 1) {
        clusters.push(cluster)
        for (const member of cluster) {
          clusteredIds.add(member.id)
        }
      }
    }

    if (batch.length < QUERY_PAGE_SIZE) break
    offset += batch.length
  }

  return clusters
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
  const clusters: ConsolidationCluster[] = []
  const clusteredIds = new Set<string>()
  let offset = 0

  while (true) {
    const batch = await queryRecords(
      {
        filter: 'deprecated == false',
        limit: QUERY_PAGE_SIZE,
        offset,
        includeEmbeddings: true
      },
      config
    )

    if (batch.length === 0) break

    for (const record of batch) {
      if (clusteredIds.has(record.id)) continue
      if (wasRecentlyConsolidationChecked(record, recheckCutoffValue)) continue
      if (!isValidEmbedding(record.embedding)) continue

      const matches = await vectorSearchSimilar(
        record.embedding,
        {
          filter: buildCrossTypeConsolidationFilter(record),
          limit: maintenance.consolidationSearchLimit,
          similarityThreshold: resolvedThreshold
        },
        config
      )

      if (matches.length === 0) continue

      const members: ConsolidationClusterMember[] = [{ record, similarity: 1 }]
      const cluster = [record] as ConsolidationCluster
      cluster.seedId = record.id
      cluster.members = members
      const types = new Set<RecordType>([record.type])

      for (const match of matches) {
        const candidate = match.record
        if (clusteredIds.has(candidate.id)) continue
        if (candidate.deprecated) continue
        if (candidate.type === record.type) continue
        if (wasRecentlyConsolidationChecked(candidate, recheckCutoffValue)) continue

        cluster.push(candidate)
        members.push({ record: candidate, similarity: match.similarity })
        types.add(candidate.type)
        if (cluster.length >= maintenance.consolidationMaxClusterSize) break
      }

      if (cluster.length > 1 && types.size > 1) {
        clusters.push(cluster)
        for (const member of cluster) {
          clusteredIds.add(member.id)
        }
      }
    }

    if (batch.length < QUERY_PAGE_SIZE) break
    offset += batch.length
  }

  return clusters
}

export async function consolidateCluster(
  cluster: MemoryRecord[],
  config: Config = DEFAULT_CONFIG,
  options: { keeperId?: string } = {}
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
  for (const record of cluster) {
    if (record.id === keeper.id) continue
    await markDeprecated(record.id, config)
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
  const shouldMerge = typeof value.shouldMerge === 'boolean' ? value.shouldMerge : null
  const keptId = typeof value.keptId === 'string' ? value.keptId.trim() : ''
  const reason = typeof value.reason === 'string' ? value.reason.trim() : ''

  if (shouldMerge === null || !reason) return null

  // If shouldMerge is true, keptId is required
  if (shouldMerge && !keptId) return null

  return { shouldMerge, keptId: keptId || undefined, reason }
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

  if (parsed.shouldMerge && parsed.keptId) {
    const validIds = new Set(cluster.map(record => record.id))
    if (!validIds.has(parsed.keptId)) {
      throw new Error('Consolidation verification response referenced an unknown record.')
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
  // Only filter by type - no project/domain so we find cross-project duplicates
  return buildFilter({
    type: record.type,
    excludeId: record.id,
    excludeDeprecated: true
  }) ?? 'deprecated == false'
}

function buildCrossTypeConsolidationFilter(record: MemoryRecord): string {
  const baseFilter = buildFilter({
    excludeId: record.id,
    excludeDeprecated: true
  }) ?? 'deprecated == false'
  return `${baseFilter} && type != "${escapeFilterValue(record.type)}"`
}
