#!/usr/bin/env -S npx tsx

import path from 'path'
import { fileURLToPath } from 'url'
import { initMilvus } from './lib/milvus.js'
import {
  checkValidity,
  checkGlobalPromotion,
  consolidateCluster,
  findCrossTypeClusters,
  findGlobalCandidates,
  findLowUsageHighRetrieval,
  findLowUsageRecords,
  findSimilarClusters,
  findStaleUnusedRecords,
  GLOBAL_PROMOTION_MIN_CONFIDENCE,
  llmVerifyConsolidation,
  pickConsolidationFallback,
  runConflictResolution,
  runWarningSynthesis as runWarningSynthesisInternal,
  findStaleRecords,
  isConfidenceSufficient,
  markDeprecated,
  promoteToGlobal,
  type MaintenanceCandidateGroup,
  type MaintenanceCandidateRecord,
} from './lib/maintenance.js'
import { findClaudeMdCandidates, findSkillCandidates, writeSuggestions } from './lib/promotions.js'
import { loadConfig } from './lib/config.js'
import { createLogger } from './lib/logger.js'

type ProgressCallback = (progress: MaintenanceProgress) => void

const logger = createLogger('maintenance')
import { DEFAULT_CONFIG, type Config, type MemoryRecord } from './lib/types.js'
import { resolveMaintenanceSettings, type MaintenanceSettings } from './lib/settings.js'
import { batchUpdateRecords, queryRecords, updateRecord } from './lib/milvus.js'
import { buildCandidateRecord, buildRecordSnippet, truncateSnippet } from './lib/shared.js'
import type { MaintenanceAction, MaintenanceActionDetails, MaintenanceActionType, MaintenanceMergeRecord, MaintenanceProgress } from '../shared/types.js'

export { runConflictResolution }

export type { MaintenanceAction, MaintenanceActionDetails, MaintenanceActionType, MaintenanceMergeRecord } from '../shared/types.js'

export interface MaintenanceRunResult {
  actions: MaintenanceAction[]
  summary: Record<string, number>
  candidates: MaintenanceCandidateGroup[]
  error?: string
}

async function main(): Promise<void> {
  const config = loadConfig(process.cwd())
  const dryRun = process.argv.slice(2).includes('--dry-run')
  const maintenanceSettings = resolveMaintenanceSettings()
  await initMilvus(config)

  console.error('[claude-memory] Maintenance started.')

  logMaintenanceResult('Stale check', await runStaleCheck(dryRun, config, maintenanceSettings), dryRun)
  logMaintenanceResult('Stale unused deprecation', await runStaleUnusedDeprecation(dryRun, config, maintenanceSettings), dryRun)
  logMaintenanceResult('Low usage deprecation', await runLowUsageDeprecation(dryRun, config, maintenanceSettings), dryRun)
  logMaintenanceResult('Low usage check', await runLowUsageCheck(dryRun, config, maintenanceSettings), dryRun)
  logMaintenanceResult('Consolidation', await runConsolidation(dryRun, config, maintenanceSettings), dryRun)
  logMaintenanceResult('Cross-type consolidation', await runCrossTypeConsolidation(dryRun, config, maintenanceSettings), dryRun)
  logMaintenanceResult('Conflict resolution', await runConflictResolution(dryRun, config, maintenanceSettings), dryRun)
  logMaintenanceResult('Global promotion', await runGlobalPromotion(dryRun, config, maintenanceSettings), dryRun)
  logMaintenanceResult('Warning synthesis', await runWarningSynthesis(dryRun, config, maintenanceSettings), dryRun)
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

const DAY_MS = 24 * 60 * 60 * 1000

async function markConsolidationChecked(
  records: MemoryRecord[],
  checkedAt: number,
  config: Config
): Promise<number> {
  if (records.length === 0) return 0

  try {
    // Fetch records with embeddings (needed for batchUpdateRecords)
    const ids = records.map(r => r.id)
    const idList = ids.map(id => `"${id}"`).join(', ')
    const recordsWithEmbeddings = await queryRecords(
      { filter: `id in [${idList}]`, includeEmbeddings: true },
      config
    )

    if (recordsWithEmbeddings.length === 0) return records.length

    const result = await batchUpdateRecords(
      recordsWithEmbeddings,
      { lastConsolidationCheck: checkedAt },
      config
    )
    return result.failed
  } catch (error) {
    logger.warn(`Batch update failed: ${error instanceof Error ? error.message : String(error)}`)
    return records.length
  }
}

export async function runStaleCheck(
  dryRun: boolean,
  config: Config = DEFAULT_CONFIG,
  settings?: MaintenanceSettings
): Promise<MaintenanceRunResult> {
  const maintenance = resolveMaintenanceSettings(settings)
  const actions: MaintenanceAction[] = []
  const candidates: MaintenanceCandidateGroup[] = []
  let checked = 0
  let deprecated = 0
  let errors = 0

  try {
    const records = await findStaleRecords(config, maintenance)
    checked = records.length
    if (records.length > 0) {
      const candidateRecords = records.map(record => {
        const lastUsed = record.lastUsed ?? record.timestamp ?? 0
        const ageDays = lastUsed ? Math.floor((Date.now() - lastUsed) / DAY_MS) : 0
        const reason = ageDays > 0 ? `last used ${ageDays}d ago` : 'stale record'
        return buildCandidateRecord(record, reason, { ageDays })
      })
      candidates.push({
        id: 'stale-candidates',
        label: 'Stale records',
        records: candidateRecords
      })
    }

    for (const record of records) {
      try {
        const validity = await checkValidity(record, maintenance)
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
    return { actions, summary: { checked, deprecated, errors }, candidates, error: message }
  }

  return { actions, summary: { checked, deprecated, errors }, candidates }
}

export async function runLowUsageDeprecation(
  dryRun: boolean,
  config: Config = DEFAULT_CONFIG,
  settings?: MaintenanceSettings
): Promise<MaintenanceRunResult> {
  const maintenance = resolveMaintenanceSettings(settings)
  const actions: MaintenanceAction[] = []
  const candidateGroups: MaintenanceCandidateGroup[] = []
  let candidates = 0
  let deprecated = 0
  let errors = 0

  try {
    const records = await findLowUsageHighRetrieval(config, maintenance)
    candidates = records.length
    if (records.length > 0) {
      const candidateRecords = records.map(record => {
        const retrievalCount = record.retrievalCount ?? 0
        const usageCount = record.usageCount ?? 0
        const reason = `zero-usage:${retrievalCount} retrievals`
        return buildCandidateRecord(record, reason, { retrievalCount, usageCount })
      })
      candidateGroups.push({
        id: 'low-usage-zero',
        label: 'Zero usage candidates',
        records: candidateRecords
      })
    }

    for (const record of records) {
      const retrievalCount = record.retrievalCount ?? 0
      const usageCount = record.usageCount ?? 0
      const reason = `zero-usage:${retrievalCount} retrievals`
      const action: MaintenanceAction = {
        type: 'deprecate',
        recordId: record.id,
        snippet: truncateSnippet(buildRecordSnippet(record)),
        reason,
        details: { retrievalCount, usageCount }
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
    return { actions, summary: { candidates, deprecated, errors }, candidates: candidateGroups, error: message }
  }

  return { actions, summary: { candidates, deprecated, errors }, candidates: candidateGroups }
}

/**
 * Deprecate old memories that have never been used.
 * These are memories that were extracted but never proved useful.
 */
export async function runStaleUnusedDeprecation(
  dryRun: boolean,
  config: Config = DEFAULT_CONFIG,
  settings?: MaintenanceSettings
): Promise<MaintenanceRunResult> {
  const maintenance = resolveMaintenanceSettings(settings)
  const actions: MaintenanceAction[] = []
  const candidateGroups: MaintenanceCandidateGroup[] = []
  let candidates = 0
  let deprecated = 0
  let errors = 0

  try {
    const records = await findStaleUnusedRecords(config, maintenance)
    candidates = records.length
    if (records.length > 0) {
      const candidateRecords = records.map(record => {
        const ageInDays = Math.floor((Date.now() - (record.timestamp ?? 0)) / DAY_MS)
        const reason = `stale-unused:${ageInDays} days old, never used`
        return buildCandidateRecord(record, reason, { ageInDays, usageCount: 0 })
      })
      candidateGroups.push({
        id: 'stale-unused',
        label: 'Stale unused candidates',
        records: candidateRecords
      })
    }

    for (const record of records) {
      const ageInDays = Math.floor((Date.now() - (record.timestamp ?? 0)) / DAY_MS)
      const reason = `stale-unused:${ageInDays} days old, never used`
      const action: MaintenanceAction = {
        type: 'deprecate',
        recordId: record.id,
        snippet: truncateSnippet(buildRecordSnippet(record)),
        reason,
        details: { ageInDays, usageCount: 0 }
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
    return { actions, summary: { candidates, deprecated, errors }, candidates: candidateGroups, error: message }
  }

  return { actions, summary: { candidates, deprecated, errors }, candidates: candidateGroups }
}

export async function runLowUsageCheck(
  dryRun: boolean,
  config: Config = DEFAULT_CONFIG,
  settings?: MaintenanceSettings
): Promise<MaintenanceRunResult> {
  const maintenance = resolveMaintenanceSettings(settings)
  const actions: MaintenanceAction[] = []
  const candidateGroups: MaintenanceCandidateGroup[] = []
  let candidates = 0
  let deprecated = 0
  let errors = 0

  try {
    const records = await findLowUsageRecords(config, maintenance)
    candidates = records.length
    if (records.length > 0) {
      const candidateRecords = records.map(record => {
        const retrievalCount = record.retrievalCount ?? 1
        const usageCount = record.usageCount ?? 0
        const ratio = usageCount / Math.max(retrievalCount, 1)
        const reason = `low-usage:${Math.round(ratio * 100)}% over ${retrievalCount} retrievals`
        return buildCandidateRecord(record, reason, { retrievalCount, usageCount, ratio })
      })
      candidateGroups.push({
        id: 'low-usage-ratio',
        label: 'Low usage candidates',
        records: candidateRecords
      })
    }

    for (const record of records) {
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
      summary: { candidates, deprecated, errors },
      candidates: candidateGroups,
      error: message
    }
  }

  return { actions, summary: { candidates, deprecated, errors }, candidates: candidateGroups }
}

export async function runConsolidation(
  dryRun: boolean,
  config: Config = DEFAULT_CONFIG,
  settings?: MaintenanceSettings,
  onProgress?: ProgressCallback
): Promise<MaintenanceRunResult> {
  const maintenance = resolveMaintenanceSettings(settings)
  const actions: MaintenanceAction[] = []
  const candidateGroups: MaintenanceCandidateGroup[] = []
  let clustersFound = 0
  let clustersMerged = 0
  let clustersRejected = 0
  let deprecated = 0
  let errors = 0

  try {
    const clusters = await findSimilarClusters(maintenance.consolidationThreshold, config, maintenance)
    clustersFound = clusters.length
    const thresholdPercent = Math.round(maintenance.consolidationThreshold * 100)
    logger.info(`Found ${clusters.length} consolidation clusters (threshold: ${thresholdPercent}%)`)
    if (clusters.length > 0) {
      candidateGroups.push(...clusters.map((cluster, index) => ({
        id: `consolidation-cluster-${index + 1}`,
        label: `Cluster ${index + 1}`,
        reason: `similarity >= ${thresholdPercent}%`,
        records: cluster.members.map(member =>
          buildCandidateRecord(member.record, 'similar record', { similarity: member.similarity })
        )
      })))
    }

    for (let i = 0; i < clusters.length; i++) {
      const cluster = clusters[i]
      const clusterRecords = cluster.members.map(member => member.record)
      let checkedAt: number | null = null
      const types = [...new Set(clusterRecords.map(r => r.type))].join(', ')
      logger.info(`Processing cluster ${i + 1}/${clusters.length} (${clusterRecords.length} records, types: ${types})`)

      // Report progress if callback provided
      if (onProgress) {
        onProgress({
          current: i + 1,
          total: clusters.length,
          message: `Processing cluster ${i + 1}/${clusters.length} (${types})`
        })
      }

      try {
        const recordById = new Map(clusterRecords.map(record => [record.id, record]))
        const buildDeprecatedRecords = (deprecatedIds: string[]) =>
          deprecatedIds.map(id => {
            const record = recordById.get(id)
            return {
              id,
              snippet: record ? truncateSnippet(buildRecordSnippet(record)) : null
            }
          })

        // LLM verification if enabled
        let verification: { shouldMerge: boolean; keptId?: string; reason: string } | null = null
        let verificationError: string | undefined
        if (maintenance.enableConsolidationLlmVerification) {
          try {
            verification = await llmVerifyConsolidation(clusterRecords, config, { crossType: false })
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (message.includes('No authentication available')) {
              throw error
            }
            verificationError = message
            logger.warn(`LLM verification failed, using fallback: ${message}`)
            verification = pickConsolidationFallback(clusterRecords)
            errors += 1
          }

          // Skip if LLM says not to merge
          if (verification && !verification.shouldMerge) {
            clustersRejected += 1
            checkedAt = Date.now()
            logger.info(`  → Rejected: ${verification.reason}`)
            continue
          }
        }

        const keeperId = verification?.keptId
        const decisionReason = verification?.reason

        if (dryRun) {
          checkedAt = Date.now()
          const preview = keeperId
            ? { keptId: keeperId, deprecatedIds: clusterRecords.filter(r => r.id !== keeperId).map(r => r.id) }
            : summarizeCluster(clusterRecords)
          if (!preview || preview.deprecatedIds.length === 0) continue
          const keeperRecord = clusterRecords.find(record => record.id === preview.keptId)
          const snippet = keeperRecord ? truncateSnippet(buildRecordSnippet(keeperRecord)) : 'cluster'
          actions.push({
            type: 'merge',
            recordId: preview.keptId,
            snippet,
            reason: `merge ${preview.deprecatedIds.length} duplicates`,
            details: {
              keptId: preview.keptId,
              deprecatedIds: preview.deprecatedIds,
              deprecatedRecords: buildDeprecatedRecords(preview.deprecatedIds),
              ...(decisionReason ? { decisionReason } : {}),
              ...(verificationError ? { verificationError } : {})
            }
          })
          clustersMerged += 1
          deprecated += preview.deprecatedIds.length
          logger.info(`  → Would merge: keep ${preview.keptId.slice(0, 8)}..., deprecate ${preview.deprecatedIds.length}`)
          continue
        }

        const result = await consolidateCluster(clusterRecords, config, keeperId ? { keeperId } : {})
        checkedAt = Date.now()
        if (!result || result.deprecatedIds.length === 0) continue
        const keeperRecord = clusterRecords.find(record => record.id === result.keptId)
        const snippet = keeperRecord ? truncateSnippet(buildRecordSnippet(keeperRecord)) : 'cluster'
        actions.push({
          type: 'merge',
          recordId: result.keptId,
          snippet,
          reason: `merge ${result.deprecatedIds.length} duplicates`,
          details: {
            keptId: result.keptId,
            deprecatedIds: result.deprecatedIds,
            deprecatedRecords: buildDeprecatedRecords(result.deprecatedIds),
            ...(decisionReason ? { decisionReason } : {}),
            ...(verificationError ? { verificationError } : {})
          }
        })
        clustersMerged += 1
        deprecated += result.deprecatedIds.length
        logger.info(`  → Merged: keep ${result.keptId.slice(0, 8)}..., deprecated ${result.deprecatedIds.length}`)
      } catch (err) {
        errors += 1
        logger.warn(`  → Error processing cluster: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        if (!dryRun && checkedAt) {
          const failed = await markConsolidationChecked(clusterRecords, checkedAt, config)
          if (failed > 0) {
            errors += failed
            logger.warn(`  → Failed to mark ${failed}/${clusterRecords.length} records as consolidation-checked`)
          }
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error(`Consolidation failed: ${message}`)
    return {
      actions,
      summary: { clusters: clustersFound, merged: clustersMerged, rejected: clustersRejected, deprecated, errors },
      candidates: candidateGroups,
      error: message
    }
  }

  logger.info(`Consolidation complete: ${clustersMerged} merged, ${clustersRejected} rejected, ${deprecated} deprecated, ${errors} errors`)
  return { actions, summary: { clusters: clustersFound, merged: clustersMerged, rejected: clustersRejected, deprecated, errors }, candidates: candidateGroups }
}

export async function runCrossTypeConsolidation(
  dryRun: boolean,
  config: Config = DEFAULT_CONFIG,
  settings?: MaintenanceSettings,
  onProgress?: ProgressCallback
): Promise<MaintenanceRunResult> {
  const maintenance = resolveMaintenanceSettings(settings)
  const actions: MaintenanceAction[] = []
  const candidateGroups: MaintenanceCandidateGroup[] = []
  let clustersFound = 0
  let clustersMerged = 0
  let clustersRejected = 0
  let deprecated = 0
  let errors = 0

  try {
    const clusters = await findCrossTypeClusters(maintenance.crossTypeConsolidationThreshold, config, maintenance)
    clustersFound = clusters.length
    const thresholdPercent = Math.round(maintenance.crossTypeConsolidationThreshold * 100)
    logger.info(`Found ${clusters.length} cross-type clusters (threshold: ${thresholdPercent}%)`)
    if (clusters.length > 0) {
      candidateGroups.push(...clusters.map((cluster, index) => ({
        id: `cross-type-cluster-${index + 1}`,
        label: `Cross-type cluster ${index + 1}`,
        reason: `similarity >= ${thresholdPercent}%`,
        records: cluster.members.map(member =>
          buildCandidateRecord(member.record, 'similar record', { similarity: member.similarity })
        )
      })))
    }

    for (let i = 0; i < clusters.length; i++) {
      const cluster = clusters[i]
      const clusterRecords = cluster.members.map(member => member.record)
      let checkedAt: number | null = null
      const types = [...new Set(clusterRecords.map(r => r.type))].join(', ')
      logger.info(`Processing cross-type cluster ${i + 1}/${clusters.length} (${clusterRecords.length} records, types: ${types})`)

      // Report progress if callback provided
      if (onProgress) {
        onProgress({
          current: i + 1,
          total: clusters.length,
          message: `Processing cluster ${i + 1}/${clusters.length} (${types})`
        })
      }
      try {
        const recordById = new Map(clusterRecords.map(record => [record.id, record]))
        const buildDeprecatedRecords = (deprecatedIds: string[]) =>
          deprecatedIds.map(id => {
            const record = recordById.get(id)
            return {
              id,
              snippet: record ? truncateSnippet(buildRecordSnippet(record)) : null
            }
          })

        // LLM verification if enabled
        let verification: { shouldMerge: boolean; keptId?: string; reason: string } | null = null
        let verificationError: string | undefined
        if (maintenance.enableConsolidationLlmVerification) {
          try {
            verification = await llmVerifyConsolidation(clusterRecords, config, { crossType: true })
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (message.includes('No authentication available')) {
              throw error
            }
            verificationError = message
            logger.warn(`LLM verification failed, using fallback: ${message}`)
            verification = pickConsolidationFallback(clusterRecords)
            errors += 1
          }

          // Skip if LLM says not to merge
          if (verification && !verification.shouldMerge) {
            clustersRejected += 1
            checkedAt = Date.now()
            logger.info(`  → Rejected: ${verification.reason}`)
            continue
          }
        } else {
          // Without LLM verification, use fallback (picks by usage metrics)
          verification = pickConsolidationFallback(clusterRecords)
        }

        if (!verification) {
          checkedAt = Date.now()
          continue
        }

        if (!verification.keptId) {
          checkedAt = Date.now()
          continue
        }
        const deprecatedIds = clusterRecords.filter(record => record.id !== verification!.keptId).map(record => record.id)
        if (deprecatedIds.length === 0) {
          checkedAt = Date.now()
          continue
        }
        const keeperRecord = clusterRecords.find(record => record.id === verification!.keptId)
        const snippet = keeperRecord ? truncateSnippet(buildRecordSnippet(keeperRecord)) : 'cluster'

        if (dryRun) {
          checkedAt = Date.now()
          actions.push({
            type: 'merge',
            recordId: verification.keptId,
            snippet,
            reason: `merge ${deprecatedIds.length} cross-type duplicates`,
            details: {
              keptId: verification.keptId,
              deprecatedIds,
              deprecatedRecords: buildDeprecatedRecords(deprecatedIds),
              decisionReason: verification.reason,
              ...(verificationError ? { verificationError } : {})
            }
          })
          clustersMerged += 1
          deprecated += deprecatedIds.length
          logger.info(`  → Would merge: keep ${verification.keptId.slice(0, 8)}..., deprecate ${deprecatedIds.length}`)
          continue
        }

        const result = await consolidateCluster(clusterRecords, config, { keeperId: verification.keptId })
        checkedAt = Date.now()
        if (!result || result.deprecatedIds.length === 0) continue
        actions.push({
          type: 'merge',
          recordId: result.keptId,
          snippet,
          reason: `merge ${result.deprecatedIds.length} cross-type duplicates`,
          details: {
            keptId: result.keptId,
            deprecatedIds: result.deprecatedIds,
            deprecatedRecords: buildDeprecatedRecords(result.deprecatedIds),
            decisionReason: verification.reason,
            ...(verificationError ? { verificationError } : {})
          }
        })
        clustersMerged += 1
        deprecated += result.deprecatedIds.length
        logger.info(`  → Merged: keep ${result.keptId.slice(0, 8)}..., deprecated ${result.deprecatedIds.length}`)
      } catch (err) {
        errors += 1
        logger.warn(`  → Error processing cluster: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        if (!dryRun && checkedAt) {
          const failed = await markConsolidationChecked(clusterRecords, checkedAt, config)
          if (failed > 0) {
            errors += failed
            logger.warn(`  → Failed to mark ${failed}/${clusterRecords.length} records as consolidation-checked`)
          }
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error(`Cross-type consolidation failed: ${message}`)
    return {
      actions,
      summary: { clusters: clustersFound, merged: clustersMerged, rejected: clustersRejected, deprecated, errors },
      candidates: candidateGroups,
      error: message
    }
  }

  logger.info(`Cross-type consolidation complete: ${clustersMerged} merged, ${clustersRejected} rejected, ${deprecated} deprecated, ${errors} errors`)
  return { actions, summary: { clusters: clustersFound, merged: clustersMerged, rejected: clustersRejected, deprecated, errors }, candidates: candidateGroups }
}

export async function runGlobalPromotion(
  dryRun: boolean,
  config: Config = DEFAULT_CONFIG,
  settings?: MaintenanceSettings
): Promise<MaintenanceRunResult> {
  const maintenance = resolveMaintenanceSettings(settings)
  const actions: MaintenanceAction[] = []
  const candidateGroups: MaintenanceCandidateGroup[] = []
  let candidates = 0
  let checked = 0
  let promoted = 0
  let skippedRecent = 0
  let errors = 0

  try {
    const records = await findGlobalCandidates(config, maintenance)
    candidates = records.length
    if (records.length > 0) {
      const candidateRecords = records.map(record =>
        buildCandidateRecord(record, 'eligible for global promotion', { scope: record.scope ?? 'project' })
      )
      candidateGroups.push({
        id: 'global-promotion',
        label: 'Promotion candidates',
        records: candidateRecords
      })
    }
    const cutoff = Date.now() - maintenance.globalPromotionRecheckDays * 24 * 60 * 60 * 1000
    const eligible = records.filter(record => (record.lastGlobalCheck ?? 0) < cutoff)
    skippedRecent = candidates - eligible.length

    const batch = selectPromotionBatch(eligible, maintenance.globalPromotionBatchSize)

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
      candidates: candidateGroups,
      error: message
    }
  }

  return { actions, summary: { candidates, checked, promoted, skippedRecent, errors }, candidates: candidateGroups }
}

function selectPromotionBatch<T>(records: T[], batchSize: number): T[] {
  if (records.length <= batchSize) return records
  const shuffled = [...records]
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled.slice(0, batchSize)
}

async function runPromotions(config: Config, dryRun: boolean): Promise<void> {
  try {
    if (dryRun) {
      const [skillCandidates, claudeCandidates] = await Promise.all([
        findSkillCandidates(config),
        findClaudeMdCandidates(config)
      ])
      const skills = skillCandidates.length
      const claudeMd = claudeCandidates.length
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

export async function runWarningSynthesis(
  dryRun: boolean,
  config: Config = DEFAULT_CONFIG,
  settings?: MaintenanceSettings
): Promise<MaintenanceRunResult> {
  const maintenance = resolveMaintenanceSettings(settings)
  try {
    const result = await runWarningSynthesisInternal(dryRun, config, maintenance)
    // Actions are already in MaintenanceAction format from the library
    return { actions: result.actions, summary: result.summary, candidates: result.candidates }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { actions: [], summary: {}, candidates: [], error: message }
  }
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
const isMainModule = fileURLToPath(import.meta.url) === entryPath
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
