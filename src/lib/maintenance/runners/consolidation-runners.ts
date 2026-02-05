import { createLogger } from '../../logger.js'
import { batchUpdateRecords, queryRecords } from '../../milvus.js'
import { resolveMaintenanceSettings, type MaintenanceSettings } from '../../settings.js'
import { buildCandidateRecord, buildRecordSnippet, truncateSnippet } from '../../shared.js'
import { DEFAULT_CONFIG, type Config, type MemoryRecord } from '../../types.js'
import { consolidateCluster, findCrossTypeClusters, findSimilarClusters, llmVerifyConsolidation, pickConsolidationFallback } from '../consolidation.js'
import type { MaintenanceAction, MaintenanceCandidateGroup } from '../../../../shared/types.js'
import { buildAction, buildDeprecatedRecordsById, buildErrorResult, buildResult, toErrorMessage } from './shared.js'
import type { MaintenanceRunResult, ProgressCallback } from './types.js'

const logger = createLogger('maintenance')

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
    logger.warn(`Batch update failed: ${toErrorMessage(error)}`)
    return records.length
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

function buildKeeperSnippet(clusterRecords: MemoryRecord[], keptId: string): string {
  const keeperRecord = clusterRecords.find(record => record.id === keptId)
  return keeperRecord ? truncateSnippet(buildRecordSnippet(keeperRecord)) : 'cluster'
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
      const buildDeprecatedRecords = buildDeprecatedRecordsById(clusterRecords)
      let checkedAt: number | null = null
      const types = [...new Set(clusterRecords.map(r => r.type))].join(', ')
      logger.info(`Processing cluster ${i + 1}/${clusters.length} (${clusterRecords.length} records, types: ${types})`)

      if (onProgress) {
        onProgress({
          current: i + 1,
          total: clusters.length,
          message: `Processing cluster ${i + 1}/${clusters.length} (${types})`
        })
      }

      try {
        let verification: { shouldMerge: boolean; keptId?: string; reason: string } | null = null
        let verificationError: string | undefined

        if (maintenance.enableConsolidationLlmVerification) {
          try {
            verification = await llmVerifyConsolidation(clusterRecords, config, { crossType: false })
          } catch (error) {
            const message = toErrorMessage(error)
            if (message.includes('No authentication available')) {
              throw error
            }
            verificationError = message
            logger.warn(`LLM verification failed, using fallback: ${message}`)
            verification = pickConsolidationFallback(clusterRecords)
            errors += 1
          }

          if (verification && !verification.shouldMerge) {
            clustersRejected += 1
            checkedAt = Date.now()
            logger.info(`  -> Rejected: ${verification.reason}`)
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

          actions.push(buildAction({
            type: 'merge',
            recordId: preview.keptId,
            snippet: buildKeeperSnippet(clusterRecords, preview.keptId),
            reason: `merge ${preview.deprecatedIds.length} duplicates`,
            details: {
              keptId: preview.keptId,
              deprecatedIds: preview.deprecatedIds,
              deprecatedRecords: buildDeprecatedRecords(preview.deprecatedIds),
              ...(decisionReason ? { decisionReason } : {}),
              ...(verificationError ? { verificationError } : {})
            }
          }))

          clustersMerged += 1
          deprecated += preview.deprecatedIds.length
          logger.info(`  -> Would merge: keep ${preview.keptId.slice(0, 8)}..., deprecate ${preview.deprecatedIds.length}`)
          continue
        }

        const result = await consolidateCluster(clusterRecords, config, keeperId ? { keeperId } : {})
        checkedAt = Date.now()
        if (!result || result.deprecatedIds.length === 0) continue

        actions.push(buildAction({
          type: 'merge',
          recordId: result.keptId,
          snippet: buildKeeperSnippet(clusterRecords, result.keptId),
          reason: `merge ${result.deprecatedIds.length} duplicates`,
          details: {
            keptId: result.keptId,
            deprecatedIds: result.deprecatedIds,
            deprecatedRecords: buildDeprecatedRecords(result.deprecatedIds),
            ...(decisionReason ? { decisionReason } : {}),
            ...(verificationError ? { verificationError } : {})
          }
        }))

        clustersMerged += 1
        deprecated += result.deprecatedIds.length
        logger.info(`  -> Merged: keep ${result.keptId.slice(0, 8)}..., deprecated ${result.deprecatedIds.length}`)
      } catch (error) {
        errors += 1
        logger.warn(`  -> Error processing cluster: ${toErrorMessage(error)}`)
      } finally {
        if (!dryRun && checkedAt) {
          const failed = await markConsolidationChecked(clusterRecords, checkedAt, config)
          if (failed > 0) {
            errors += failed
            logger.warn(`  -> Failed to mark ${failed}/${clusterRecords.length} records as consolidation-checked`)
          }
        }
      }
    }
  } catch (error) {
    logger.error(`Consolidation failed: ${toErrorMessage(error)}`)
    return buildErrorResult(
      actions,
      { clusters: clustersFound, merged: clustersMerged, rejected: clustersRejected, deprecated, errors },
      candidateGroups,
      error
    )
  }

  logger.info(`Consolidation complete: ${clustersMerged} merged, ${clustersRejected} rejected, ${deprecated} deprecated, ${errors} errors`)
  return buildResult(
    actions,
    { clusters: clustersFound, merged: clustersMerged, rejected: clustersRejected, deprecated, errors },
    candidateGroups
  )
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
      const buildDeprecatedRecords = buildDeprecatedRecordsById(clusterRecords)
      let checkedAt: number | null = null
      const types = [...new Set(clusterRecords.map(r => r.type))].join(', ')
      logger.info(`Processing cross-type cluster ${i + 1}/${clusters.length} (${clusterRecords.length} records, types: ${types})`)

      if (onProgress) {
        onProgress({
          current: i + 1,
          total: clusters.length,
          message: `Processing cluster ${i + 1}/${clusters.length} (${types})`
        })
      }

      try {
        let verification: { shouldMerge: boolean; keptId?: string; reason: string } | null = null
        let verificationError: string | undefined

        if (maintenance.enableConsolidationLlmVerification) {
          try {
            verification = await llmVerifyConsolidation(clusterRecords, config, { crossType: true })
          } catch (error) {
            const message = toErrorMessage(error)
            if (message.includes('No authentication available')) {
              throw error
            }
            verificationError = message
            logger.warn(`LLM verification failed, using fallback: ${message}`)
            verification = pickConsolidationFallback(clusterRecords)
            errors += 1
          }

          if (verification && !verification.shouldMerge) {
            clustersRejected += 1
            checkedAt = Date.now()
            logger.info(`  -> Rejected: ${verification.reason}`)
            continue
          }
        } else {
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

        const deprecatedIds = clusterRecords
          .filter(record => record.id !== verification!.keptId)
          .map(record => record.id)

        if (deprecatedIds.length === 0) {
          checkedAt = Date.now()
          continue
        }

        if (dryRun) {
          checkedAt = Date.now()
          actions.push(buildAction({
            type: 'merge',
            recordId: verification.keptId,
            snippet: buildKeeperSnippet(clusterRecords, verification.keptId),
            reason: `merge ${deprecatedIds.length} cross-type duplicates`,
            details: {
              keptId: verification.keptId,
              deprecatedIds,
              deprecatedRecords: buildDeprecatedRecords(deprecatedIds),
              decisionReason: verification.reason,
              ...(verificationError ? { verificationError } : {})
            }
          }))

          clustersMerged += 1
          deprecated += deprecatedIds.length
          logger.info(`  -> Would merge: keep ${verification.keptId.slice(0, 8)}..., deprecate ${deprecatedIds.length}`)
          continue
        }

        const result = await consolidateCluster(clusterRecords, config, { keeperId: verification.keptId })
        checkedAt = Date.now()
        if (!result || result.deprecatedIds.length === 0) continue

        actions.push(buildAction({
          type: 'merge',
          recordId: result.keptId,
          snippet: buildKeeperSnippet(clusterRecords, result.keptId),
          reason: `merge ${result.deprecatedIds.length} cross-type duplicates`,
          details: {
            keptId: result.keptId,
            deprecatedIds: result.deprecatedIds,
            deprecatedRecords: buildDeprecatedRecords(result.deprecatedIds),
            decisionReason: verification.reason,
            ...(verificationError ? { verificationError } : {})
          }
        }))

        clustersMerged += 1
        deprecated += result.deprecatedIds.length
        logger.info(`  -> Merged: keep ${result.keptId.slice(0, 8)}..., deprecated ${result.deprecatedIds.length}`)
      } catch (error) {
        errors += 1
        logger.warn(`  -> Error processing cluster: ${toErrorMessage(error)}`)
      } finally {
        if (!dryRun && checkedAt) {
          const failed = await markConsolidationChecked(clusterRecords, checkedAt, config)
          if (failed > 0) {
            errors += failed
            logger.warn(`  -> Failed to mark ${failed}/${clusterRecords.length} records as consolidation-checked`)
          }
        }
      }
    }
  } catch (error) {
    logger.error(`Cross-type consolidation failed: ${toErrorMessage(error)}`)
    return buildErrorResult(
      actions,
      { clusters: clustersFound, merged: clustersMerged, rejected: clustersRejected, deprecated, errors },
      candidateGroups,
      error
    )
  }

  logger.info(`Cross-type consolidation complete: ${clustersMerged} merged, ${clustersRejected} rejected, ${deprecated} deprecated, ${errors} errors`)
  return buildResult(
    actions,
    { clusters: clustersFound, merged: clustersMerged, rejected: clustersRejected, deprecated, errors },
    candidateGroups
  )
}
