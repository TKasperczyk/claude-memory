import { DEFAULT_CONFIG, type Config, type MemoryRecord } from './types.js'
import {
  checkValidity,
  checkGeneralization,
  consolidateCluster,
  findContradictionPairs,
  findGlobalCandidates,
  findLowUsageRecords,
  findSimilarClusters,
  findStaleRecords,
  generalizeRecord,
  markDeprecated,
  promoteToGlobal,
  resolveContradiction
} from './maintenance.js'
import { findClaudeMdCandidates, findSkillCandidates } from './promotions.js'
import { queryRecords, updateRecord } from './milvus.js'

const SIMILARITY_THRESHOLD = 0.85
const GENERALIZATION_BATCH_SIZE = 20
const GENERALIZATION_SAMPLE_LIMIT = 200
const GENERALIZATION_RECHECK_DAYS = 30

export interface MaintenanceAction {
  type: 'deprecate' | 'update' | 'merge' | 'promote' | 'suggestion'
  recordId?: string
  snippet: string
  reason: string
  details?: Record<string, unknown>
}

export interface OperationResult {
  operation: string
  dryRun: boolean
  actions: MaintenanceAction[]
  summary: Record<string, number>
  duration: number
  error?: string
}

export type MaintenanceOperation =
  | 'stale-check'
  | 'low-usage'
  | 'generalization'
  | 'consolidation'
  | 'contradictions'
  | 'global-promotion'
  | 'promotion-suggestions'

export const MAINTENANCE_OPERATIONS: MaintenanceOperation[] = [
  'stale-check',
  'generalization',
  'low-usage',
  'consolidation',
  'contradictions',
  'global-promotion',
  'promotion-suggestions'
]

type OperationPayload = {
  actions: MaintenanceAction[]
  summary: Record<string, number>
  error?: string
}

export async function runMaintenanceOperation(
  operation: MaintenanceOperation,
  dryRun: boolean,
  config: Config = DEFAULT_CONFIG
): Promise<OperationResult> {
  const started = Date.now()

  try {
    const payload = await runOperation(operation, dryRun, config)
    return {
      operation,
      dryRun,
      actions: payload.actions,
      summary: payload.summary,
      duration: Date.now() - started,
      ...(payload.error ? { error: payload.error } : {})
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      operation,
      dryRun,
      actions: [],
      summary: {},
      duration: Date.now() - started,
      error: message
    }
  }
}

export async function runAllMaintenance(
  dryRun: boolean,
  config: Config = DEFAULT_CONFIG
): Promise<OperationResult[]> {
  const results: OperationResult[] = []
  for (const operation of MAINTENANCE_OPERATIONS) {
    const effectiveDryRun = operation === 'promotion-suggestions' ? true : dryRun
    results.push(await runMaintenanceOperation(operation, effectiveDryRun, config))
  }
  return results
}

async function runOperation(
  operation: MaintenanceOperation,
  dryRun: boolean,
  config: Config
): Promise<OperationPayload> {
  switch (operation) {
    case 'stale-check':
      return runStaleCheck(dryRun, config)
    case 'low-usage':
      return runLowUsageCheck(dryRun, config)
    case 'generalization':
      return runGeneralization(dryRun, config)
    case 'consolidation':
      return runConsolidation(dryRun, config)
    case 'contradictions':
      return runContradictionCheck(dryRun, config)
    case 'global-promotion':
      return runGlobalPromotion(dryRun, config)
    case 'promotion-suggestions':
      return runPromotionSuggestions(config)
  }
}

async function runStaleCheck(
  dryRun: boolean,
  config: Config
): Promise<OperationPayload> {
  const actions: MaintenanceAction[] = []
  let checked = 0
  let deprecated = 0
  let errors = 0

  try {
    const records = await findStaleRecords(config)
    checked = records.length

    for (const record of records) {
      try {
        const validity = await checkValidity(record)
        if (validity.valid) continue

        const reason = validity.reason ?? 'invalid'
        const action: MaintenanceAction = {
          type: 'deprecate',
          recordId: record.id,
          snippet: truncateSnippet(buildRecordSnippet(record)),
          reason,
          details: { validityReason: reason }
        }

        if (dryRun) {
          actions.push(action)
          deprecated += 1
        } else {
          const updated = await markDeprecated(record.id, config)
          if (updated) {
            actions.push(action)
            deprecated += 1
          }
        }
      } catch {
        errors += 1
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { actions, summary: { checked, deprecated, errors }, error: message }
  }

  return { actions, summary: { checked, deprecated, errors } }
}

async function runLowUsageCheck(
  dryRun: boolean,
  config: Config
): Promise<OperationPayload> {
  const actions: MaintenanceAction[] = []
  let candidates = 0
  let deprecated = 0
  let skippedRecentGeneralization = 0
  let errors = 0

  const generalizationCutoff = Date.now() - GENERALIZATION_RECHECK_DAYS * 24 * 60 * 60 * 1000

  try {
    const records = await findLowUsageRecords(config)
    candidates = records.length

    for (const record of records) {
      const lastCheck = record.lastGeneralizationCheck ?? 0
      if (lastCheck >= generalizationCutoff) {
        skippedRecentGeneralization += 1
        continue
      }

      const retrievalCount = record.retrievalCount ?? 1
      const usageCount = record.usageCount ?? 0
      const ratio = usageCount / Math.max(retrievalCount, 1)
      const reason = `low-usage:${Math.round(ratio * 100)}% over ${retrievalCount} retrievals`
      const action: MaintenanceAction = {
        type: 'deprecate',
        recordId: record.id,
        snippet: truncateSnippet(buildRecordSnippet(record)),
        reason,
        details: {
          retrievalCount,
          usageCount,
          ratio
        }
      }

      try {
        if (dryRun) {
          actions.push(action)
          deprecated += 1
        } else {
          const updated = await markDeprecated(record.id, config)
          if (updated) {
            actions.push(action)
            deprecated += 1
          }
        }
      } catch {
        errors += 1
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      actions,
      summary: { candidates, deprecated, skippedRecentGeneralization, errors },
      error: message
    }
  }

  return { actions, summary: { candidates, deprecated, skippedRecentGeneralization, errors } }
}

async function runGeneralization(
  dryRun: boolean,
  config: Config
): Promise<OperationPayload> {
  const actions: MaintenanceAction[] = []
  let eligible = 0
  let checked = 0
  let generalized = 0
  let skippedRecent = 0
  let skippedGeneralized = 0
  let errors = 0

  const cutoff = Date.now() - GENERALIZATION_RECHECK_DAYS * 24 * 60 * 60 * 1000

  try {
    const [lowUsage, sampled] = await Promise.all([
      findLowUsageRecords(config),
      queryRecords({ filter: 'deprecated == false', limit: GENERALIZATION_SAMPLE_LIMIT }, config)
    ])

    const combined = new Map<string, MemoryRecord>()
    for (const record of [...lowUsage, ...sampled]) {
      combined.set(record.id, record)
    }

    const candidates = Array.from(combined.values())
    const filtered = candidates.filter(record => {
      if (record.deprecated) return false
      if (record.generalized) {
        skippedGeneralized += 1
        return false
      }
      const lastCheck = record.lastGeneralizationCheck ?? 0
      if (lastCheck >= cutoff) {
        skippedRecent += 1
        return false
      }
      return true
    })

    filtered.sort((a, b) => {
      const scoreDiff = computeGeneralizationPriority(b) - computeGeneralizationPriority(a)
      if (scoreDiff !== 0) return scoreDiff
      return (b.retrievalCount ?? 0) - (a.retrievalCount ?? 0)
    })

    const batch = filtered.slice(0, GENERALIZATION_BATCH_SIZE)
    eligible = batch.length

    for (const record of batch) {
      checked += 1
      const checkedAt = Date.now()

      try {
        const result = await checkGeneralization(record, config)
        let applied = false

        if (result.shouldGeneralize && result.generalizedRecord) {
          const updates: Partial<MemoryRecord> = { ...result.generalizedRecord }
          if (record.timestamp) {
            updates.timestamp = record.timestamp
          }

          const before = truncateSnippet(buildRecordSnippet(record), 140)
          const afterRecord = { ...record, ...updates } as MemoryRecord
          const after = truncateSnippet(buildRecordSnippet(afterRecord), 140)
          const reason = result.reason ?? 'generalized'

          const action: MaintenanceAction = {
            type: 'update',
            recordId: record.id,
            snippet: after,
            reason,
            details: { before, after }
          }

          if (dryRun) {
            actions.push(action)
            generalized += 1
            applied = true
          } else {
            const updated = await generalizeRecord(record.id, updates, config)
            if (updated) {
              actions.push(action)
              generalized += 1
              applied = true
            }
          }
        }

        if (!dryRun && !applied) {
          await updateRecord(record.id, { lastGeneralizationCheck: checkedAt }, config)
        }
      } catch {
        errors += 1
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      actions,
      summary: { eligible, checked, generalized, skippedRecent, skippedGeneralized, errors },
      error: message
    }
  }

  return { actions, summary: { eligible, checked, generalized, skippedRecent, skippedGeneralized, errors } }
}

async function runConsolidation(
  dryRun: boolean,
  config: Config
): Promise<OperationPayload> {
  const actions: MaintenanceAction[] = []
  let clustersFound = 0
  let clustersMerged = 0
  let deprecated = 0
  let errors = 0

  try {
    const clusters = await findSimilarClusters(SIMILARITY_THRESHOLD, config)
    clustersFound = clusters.length

    for (const cluster of clusters) {
      try {
        const preview = summarizeCluster(cluster)
        if (!preview || preview.deprecatedIds.length === 0) continue
        const keeperRecord = cluster.find(record => record.id === preview.keptId)
        const snippet = keeperRecord ? truncateSnippet(buildRecordSnippet(keeperRecord)) : 'cluster'
        const action: MaintenanceAction = {
          type: 'merge',
          recordId: preview.keptId,
          snippet,
          reason: `merge ${preview.deprecatedIds.length} duplicates`,
          details: { keptId: preview.keptId, deprecatedIds: preview.deprecatedIds }
        }

        if (dryRun) {
          actions.push(action)
          clustersMerged += 1
          deprecated += preview.deprecatedIds.length
        } else {
          const result = await consolidateCluster(cluster, config)
          if (!result || result.deprecatedIds.length === 0) continue
          actions.push(action)
          clustersMerged += 1
          deprecated += result.deprecatedIds.length
        }
      } catch {
        errors += 1
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      actions,
      summary: { clusters: clustersFound, merged: clustersMerged, deprecated, errors },
      error: message
    }
  }

  return { actions, summary: { clusters: clustersFound, merged: clustersMerged, deprecated, errors } }
}

async function runContradictionCheck(
  dryRun: boolean,
  config: Config
): Promise<OperationPayload> {
  const actions: MaintenanceAction[] = []
  let pairsFound = 0
  let deprecated = 0
  let errors = 0

  try {
    const pairs = await findContradictionPairs(config)
    pairsFound = pairs.length

    for (const pair of pairs) {
      const olderSnippet = truncateSnippet(buildRecordSnippet(pair.older))
      const newerSnippet = truncateSnippet(buildRecordSnippet(pair.newer))
      const reason = `contradiction sim=${pair.similarity.toFixed(2)}`
      const action: MaintenanceAction = {
        type: 'deprecate',
        recordId: pair.older.id,
        snippet: olderSnippet,
        reason,
        details: {
          newerId: pair.newer.id,
          newerSnippet,
          similarity: pair.similarity
        }
      }

      try {
        if (dryRun) {
          actions.push(action)
          deprecated += 1
        } else {
          const updated = await resolveContradiction(pair, config)
          if (updated) {
            actions.push(action)
            deprecated += 1
          }
        }
      } catch {
        errors += 1
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { actions, summary: { pairs: pairsFound, deprecated, errors }, error: message }
  }

  return { actions, summary: { pairs: pairsFound, deprecated, errors } }
}

async function runGlobalPromotion(
  dryRun: boolean,
  config: Config
): Promise<OperationPayload> {
  const actions: MaintenanceAction[] = []
  let candidates = 0
  let promoted = 0
  let errors = 0

  try {
    const records = await findGlobalCandidates(config)
    candidates = records.length

    for (const record of records) {
      const action: MaintenanceAction = {
        type: 'promote',
        recordId: record.id,
        snippet: truncateSnippet(buildRecordSnippet(record)),
        reason: 'global candidate',
        details: { scope: record.scope ?? 'project' }
      }

      try {
        if (dryRun) {
          actions.push(action)
          promoted += 1
        } else {
          const updated = await promoteToGlobal(record.id, config)
          if (updated) {
            actions.push(action)
            promoted += 1
          }
        }
      } catch {
        errors += 1
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { actions, summary: { candidates, promoted, errors }, error: message }
  }

  return { actions, summary: { candidates, promoted, errors } }
}

async function runPromotionSuggestions(config: Config): Promise<OperationPayload> {
  const actions: MaintenanceAction[] = []
  let skillCandidates = 0
  let claudeMdCandidates = 0
  let errors = 0

  try {
    const [skillCandidatesList, claudeCandidates] = await Promise.all([
      findSkillCandidates(config),
      findClaudeMdCandidates(config)
    ])

    skillCandidates = skillCandidatesList.length
    claudeMdCandidates = claudeCandidates.global.length
      + Object.values(claudeCandidates.byProject).reduce((total, group) => total + group.length, 0)

    for (const record of skillCandidatesList) {
      actions.push({
        type: 'suggestion',
        recordId: record.id,
        snippet: truncateSnippet(record.name || buildRecordSnippet(record)),
        reason: 'skill suggestion',
        details: {
          kind: 'skill',
          successCount: record.successCount ?? 0
        }
      })
    }

    for (const record of claudeCandidates.global) {
      actions.push({
        type: 'suggestion',
        recordId: record.id,
        snippet: truncateSnippet(record.what || buildRecordSnippet(record)),
        reason: 'CLAUDE.md suggestion (global)',
        details: { kind: 'claude-md', scope: 'global' }
      })
    }

    for (const [project, records] of Object.entries(claudeCandidates.byProject)) {
      for (const record of records) {
        actions.push({
          type: 'suggestion',
          recordId: record.id,
          snippet: truncateSnippet(record.what || buildRecordSnippet(record)),
          reason: `CLAUDE.md suggestion (${project})`,
          details: { kind: 'claude-md', scope: project }
        })
      }
    }
  } catch (error) {
    errors += 1
    const message = error instanceof Error ? error.message : String(error)
    return { actions, summary: { skillCandidates, claudeMdCandidates, errors }, error: message }
  }

  return { actions, summary: { skillCandidates, claudeMdCandidates, errors } }
}

function buildRecordSnippet(record: { type: string; command?: string; errorText?: string; what?: string; name?: string }): string {
  switch (record.type) {
    case 'command':
      return record.command ?? 'unknown command'
    case 'error':
      return record.errorText ?? 'unknown error'
    case 'discovery':
      return record.what ?? 'unknown discovery'
    case 'procedure':
      return record.name ?? 'unknown procedure'
    default:
      return `${record.type} record`
  }
}

function truncateSnippet(value: string, maxLength: number = 120): string {
  const cleaned = value.replace(/\s+/g, ' ').trim()
  if (cleaned.length <= maxLength) return cleaned
  return `${cleaned.slice(0, maxLength - 3)}...`
}

function summarizeCluster(cluster: { id: string; successCount?: number; lastUsed?: number; timestamp?: number }[]): {
  keptId: string
  deprecatedIds: string[]
} | null {
  if (cluster.length < 2) return null

  const sorted = [...cluster].sort((a, b) => {
    const successDiff = (b.successCount ?? 0) - (a.successCount ?? 0)
    if (successDiff !== 0) return successDiff
    const lastUsedDiff = (b.lastUsed ?? 0) - (a.lastUsed ?? 0)
    if (lastUsedDiff !== 0) return lastUsedDiff
    return (b.timestamp ?? 0) - (a.timestamp ?? 0)
  })

  const keeper = sorted[0]
  const deprecatedIds = sorted.slice(1).map(record => record.id)

  return { keptId: keeper.id, deprecatedIds }
}

function computeGeneralizationPriority(record: MemoryRecord): number {
  const retrievalCount = record.retrievalCount ?? 0
  if (retrievalCount <= 0) return 0
  const usageCount = record.usageCount ?? 0
  const ratio = usageCount / Math.max(retrievalCount, 1)
  return retrievalCount * (1 - ratio)
}
