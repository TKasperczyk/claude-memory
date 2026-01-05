#!/usr/bin/env -S npx tsx

import { initMilvus } from './lib/milvus.js'
import {
  checkValidity,
  checkGeneralization,
  checkContradiction,
  checkGlobalPromotion,
  consolidateCluster,
  CONTRADICTION_BATCH_SIZE,
  findContradictionPairs,
  findGlobalCandidates,
  findLowUsageRecords,
  findSimilarClusters,
  GLOBAL_PROMOTION_BATCH_SIZE,
  GLOBAL_PROMOTION_MIN_CONFIDENCE,
  GLOBAL_PROMOTION_RECHECK_DAYS,
  generalizeRecord,
  findStaleRecords,
  isConfidenceSufficient,
  markDeprecated,
  promoteToGlobal,
  resolveContradictionWithLLM,
  type ContradictionPair,
  type ContradictionResult
} from './lib/maintenance.js'
import { findClaudeMdCandidates, findSkillCandidates, writeSuggestions } from './lib/promotions.js'
import { loadConfig } from './lib/config.js'
import { DEFAULT_CONFIG, type Config, type MemoryRecord } from './lib/types.js'
import { queryRecords, updateRecord } from './lib/milvus.js'

const SIMILARITY_THRESHOLD = 0.85
const GENERALIZATION_BATCH_SIZE = 20
const GENERALIZATION_SAMPLE_LIMIT = 200
const GENERALIZATION_RECHECK_DAYS = 30

export type MaintenanceActionType = 'deprecate' | 'update' | 'merge' | 'promote' | 'suggestion'

export interface MaintenanceAction {
  type: MaintenanceActionType
  recordId?: string
  snippet: string
  reason: string
  details?: Record<string, unknown>
}

export interface MaintenanceRunResult {
  actions: MaintenanceAction[]
  summary: Record<string, number>
  error?: string
}

async function main(): Promise<void> {
  const config = loadConfig(process.cwd())
  const dryRun = process.argv.slice(2).includes('--dry-run')
  await initMilvus(config)

  console.error('[claude-memory] Maintenance started.')

  logMaintenanceResult('Stale check', await runStaleCheck(dryRun, config), dryRun)
  logMaintenanceResult('Generalization', await runGeneralization(dryRun, config), dryRun)
  logMaintenanceResult('Low usage check', await runLowUsageCheck(dryRun, config), dryRun)
  logMaintenanceResult('Consolidation', await runConsolidation(dryRun, config), dryRun)
  logMaintenanceResult('Contradiction check', await runContradictionCheck(dryRun, config), dryRun)
  logMaintenanceResult('Global promotion', await runGlobalPromotion(dryRun, config), dryRun)
  await runPromotions(config, dryRun)

  if (dryRun) {
    console.error('[claude-memory] Maintenance complete (DRY RUN - no changes made)')
  } else {
    console.error('[claude-memory] Maintenance complete.')
  }
}

function logMaintenanceResult(label: string, result: MaintenanceRunResult, dryRun: boolean): void {
  const prefix = dryRun ? '[DRY RUN] ' : ''
  for (const action of result.actions) {
    const recordId = action.recordId ? ` ${action.recordId}` : ''
    console.error(`[claude-memory] ${prefix}${action.type}${recordId} ${action.snippet} (${action.reason})`)
  }

  if (result.error) {
    console.error(`[claude-memory] ${label} error: ${result.error}`)
  }
  if (Object.keys(result.summary).length > 0) {
    console.error(`[claude-memory] ${label} summary: ${formatSummary(result.summary)}`)
  }
}

function formatSummary(summary: Record<string, number>): string {
  return Object.entries(summary)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ')
}

export async function runStaleCheck(
  dryRun: boolean,
  config: Config = DEFAULT_CONFIG
): Promise<MaintenanceRunResult> {
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

export async function runLowUsageCheck(
  dryRun: boolean,
  config: Config = DEFAULT_CONFIG
): Promise<MaintenanceRunResult> {
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
        details: { retrievalCount, usageCount, ratio }
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

export async function runGeneralization(
  dryRun: boolean,
  config: Config = DEFAULT_CONFIG
): Promise<MaintenanceRunResult> {
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

export async function runConsolidation(
  dryRun: boolean,
  config: Config = DEFAULT_CONFIG
): Promise<MaintenanceRunResult> {
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
        if (dryRun) {
          const preview = summarizeCluster(cluster)
          if (!preview || preview.deprecatedIds.length === 0) continue
          const keeperRecord = cluster.find(record => record.id === preview.keptId)
          const snippet = keeperRecord ? truncateSnippet(buildRecordSnippet(keeperRecord)) : 'cluster'
          actions.push({
            type: 'merge',
            recordId: preview.keptId,
            snippet,
            reason: `merge ${preview.deprecatedIds.length} duplicates`,
            details: { keptId: preview.keptId, deprecatedIds: preview.deprecatedIds }
          })
          clustersMerged += 1
          deprecated += preview.deprecatedIds.length
          continue
        }

        const result = await consolidateCluster(cluster, config)
        if (!result || result.deprecatedIds.length === 0) continue
        const keeperRecord = cluster.find(record => record.id === result.keptId)
        const snippet = keeperRecord ? truncateSnippet(buildRecordSnippet(keeperRecord)) : 'cluster'
        actions.push({
          type: 'merge',
          recordId: result.keptId,
          snippet,
          reason: `merge ${result.deprecatedIds.length} duplicates`,
          details: { keptId: result.keptId, deprecatedIds: result.deprecatedIds }
        })
        clustersMerged += 1
        deprecated += result.deprecatedIds.length
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

export async function runContradictionCheck(
  dryRun: boolean,
  config: Config = DEFAULT_CONFIG
): Promise<MaintenanceRunResult> {
  const actions: MaintenanceAction[] = []
  let pairsFound = 0
  let checked = 0
  let deprecated = 0
  let keptBoth = 0
  let keptOlder = 0
  let keptNewer = 0
  let merged = 0
  let errors = 0

  const recordDecision = (
    decision: ContradictionResult['verdict'],
    pair: ContradictionPair,
    reason?: string
  ): void => {
    const similarity = pair.similarity
    const reasonText = reason ? `reason=${reason}` : 'contradiction'
    const summaryReason = `sim=${similarity.toFixed(2)} ${reasonText}`

    if (decision === 'keep_newer') {
      keptNewer += 1
      deprecated += 1
      actions.push({
        type: 'deprecate',
        recordId: pair.older.id,
        snippet: truncateSnippet(buildRecordSnippet(pair.older)),
        reason: summaryReason,
        details: { keptId: pair.newer.id, similarity }
      })
      return
    }

    if (decision === 'keep_older') {
      keptOlder += 1
      deprecated += 1
      actions.push({
        type: 'deprecate',
        recordId: pair.newer.id,
        snippet: truncateSnippet(buildRecordSnippet(pair.newer)),
        reason: summaryReason,
        details: { keptId: pair.older.id, similarity }
      })
      return
    }

    if (decision === 'merge') {
      merged += 1
      deprecated += 1
      actions.push({
        type: 'merge',
        recordId: pair.newer.id,
        snippet: truncateSnippet(buildRecordSnippet(pair.newer)),
        reason: summaryReason,
        details: { keptId: pair.newer.id, deprecatedIds: [pair.older.id], similarity }
      })
      return
    }

    keptBoth += 1
  }

  try {
    const pairs = await findContradictionPairs(config)
    pairsFound = pairs.length
    const batch = pairs.slice(0, CONTRADICTION_BATCH_SIZE)

    for (const pair of batch) {
      checked += 1
      try {
        const result = await checkContradiction(pair, config)
        if (dryRun) {
          recordDecision(result.verdict, pair, result.reason)
          continue
        }

        const outcome = await resolveContradictionWithLLM(pair, result, config)
        recordDecision(outcome.action, pair, result.reason)
      } catch {
        errors += 1
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      actions,
      summary: { pairs: pairsFound, checked, deprecated, keptBoth, keptNewer, keptOlder, merged, errors },
      error: message
    }
  }

  return {
    actions,
    summary: { pairs: pairsFound, checked, deprecated, keptBoth, keptNewer, keptOlder, merged, errors }
  }
}

export async function runGlobalPromotion(
  dryRun: boolean,
  config: Config = DEFAULT_CONFIG
): Promise<MaintenanceRunResult> {
  const actions: MaintenanceAction[] = []
  let candidates = 0
  let checked = 0
  let promoted = 0
  let skippedRecent = 0
  let errors = 0

  try {
    const records = await findGlobalCandidates(config)
    candidates = records.length
    const cutoff = Date.now() - GLOBAL_PROMOTION_RECHECK_DAYS * 24 * 60 * 60 * 1000
    const eligible = records.filter(record => (record.lastGlobalCheck ?? 0) < cutoff)
    skippedRecent = candidates - eligible.length

    const batch = eligible.slice(0, GLOBAL_PROMOTION_BATCH_SIZE)

    for (const record of batch) {
      checked += 1
      const checkedAt = Date.now()

      try {
        const result = await checkGlobalPromotion(record, config)
        const confidenceOk = isConfidenceSufficient(result.confidence, GLOBAL_PROMOTION_MIN_CONFIDENCE)
        const detail = result.reason
          ? `confidence=${result.confidence} reason=${result.reason}`
          : `confidence=${result.confidence}`

        if (result.shouldPromote && confidenceOk) {
          const action: MaintenanceAction = {
            type: 'promote',
            recordId: record.id,
            snippet: truncateSnippet(buildRecordSnippet(record)),
            reason: detail,
            details: { scope: record.scope ?? 'project' }
          }

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
        }

        if (!dryRun) {
          await updateRecord(record.id, { lastGlobalCheck: checkedAt }, config)
        }
      } catch {
        errors += 1
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      actions,
      summary: { candidates, checked, promoted, skippedRecent, errors },
      error: message
    }
  }

  return { actions, summary: { candidates, checked, promoted, skippedRecent, errors } }
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
  return cleaned.slice(0, maxLength - 3) + '...'
}

async function runPromotions(config: Config, dryRun: boolean): Promise<void> {
  try {
    if (dryRun) {
      const [skillCandidates, claudeCandidates] = await Promise.all([
        findSkillCandidates(config),
        findClaudeMdCandidates(config)
      ])
      const skills = skillCandidates.length
      const claudeMd = claudeCandidates.global.length
        + Object.values(claudeCandidates.byProject).reduce((total, group) => total + group.length, 0)
      console.error(`[claude-memory] [DRY RUN] Would generate promotion suggestions: skills=${skills} claude-md=${claudeMd}`)
      return
    }

    const result = await writeSuggestions(config, process.cwd())
    const skills = result.skillFiles.length
    const claudeMd = result.claudeMdFiles.length
    console.error(`[claude-memory] Promotion suggestions: skills=${skills} claude-md=${claudeMd}`)

    for (const file of result.skillFiles) {
      console.error(`[claude-memory] Skill suggestion: ${file}`)
    }
    for (const file of result.claudeMdFiles) {
      console.error(`[claude-memory] CLAUDE.md suggestion: ${file}`)
    }
  } catch (error) {
    console.error('[claude-memory] Failed to generate promotion suggestions:', error)
  }
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

const isMainModule = import.meta.url === `file://${process.argv[1]}`
if (isMainModule) {
  main()
    .then(() => {
      process.exitCode = 0
    })
    .catch(error => {
      console.error('[claude-memory] maintenance failed:', error)
      process.exitCode = 2
    })
}
