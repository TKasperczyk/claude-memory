import { createLogger } from '../../logger.js'
import { batchUpdateRecords, queryRecords, updateRecord } from '../../lancedb.js'
import { resolveMaintenanceSettings, type MaintenanceSettings } from '../../settings.js'
import { buildCandidateRecord, buildRecordSnippet, escapeFilterValue, truncateSnippet } from '../../shared.js'
import { DEFAULT_CONFIG, type Config, type MemoryRecord } from '../../types.js'
import { consolidateCluster, findCrossTypeClusters, findSimilarClusters, llmVerifyConsolidation, pickConsolidationFallback, resolveMergeGroups } from '../consolidation.js'
import { cleanupConsolidationNoMergeVerdicts, loadConsolidationNoMergeVerdict, saveConsolidationNoMergeVerdict, type ConsolidationVerdictMode } from '../consolidation-verdicts.js'
import type { MaintenanceAction, MaintenanceCandidateGroup } from '../../../../shared/types.js'
import { buildAction, buildDeprecatedRecordsById, buildErrorResult, buildResult, toErrorMessage } from './shared.js'
import type { MaintenanceRunResult, ProgressCallback } from './types.js'

const logger = createLogger('maintenance')

const PROTECTED_SYNTHESIS_FIELDS = new Set([
  'id',
  'type',
  'scope',
  'deprecated',
  'deprecatedAt',
  'deprecatedReason',
  'supersedingRecordId',
  'extractionRunId',
  'insertedAt',
  'lastRetrievedAt',
  'retrievalCount',
  'usefulCount',
  'successCount',
  'failureCount',
  'usageCount',
  'lastUsed',
  'timestamp',
  'sourceSessionId',
  'sourceExcerpt',
  'project',
  'subdomain',
  'embedding',
  'generalized',
  'lastGeneralizationCheck',
  'lastGlobalCheck',
  'lastConsolidationCheck',
  'lastConflictCheck',
  'lastCurrentnessCheck',
  'lastWarningSynthesisCheck',
  'supersedes'
])

function parseIntField(value: string): number | undefined {
  const parsed = Number(value.trim())
  if (!Number.isFinite(parsed)) return undefined
  return Math.trunc(parsed)
}

function parseStringList(value: string): string[] {
  const trimmed = value.trim()
  if (!trimmed) return []
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (Array.isArray(parsed)) {
        return parsed
          .filter((entry): entry is string => typeof entry === 'string')
          .map(entry => entry.trim())
          .filter(Boolean)
      }
    } catch {
      // Fall through to line-based parsing.
    }
  }

  return trimmed
    .split('\n')
    .map(entry => entry.trim())
    .filter(Boolean)
}

function parseObjectField(value: string): Record<string, unknown> | undefined {
  const trimmed = value.trim()
  if (!trimmed.startsWith('{')) return undefined

  try {
    const parsed = JSON.parse(trimmed)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Caller handles undefined as invalid.
  }

  return undefined
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function buildContextUpdate(
  existing: Record<string, unknown>,
  candidate: Record<string, unknown>,
  allowedKeys: readonly string[]
): Record<string, unknown> | undefined {
  const next: Record<string, unknown> = { ...existing }
  let changed = false

  for (const key of allowedKeys) {
    const parsed = asNonEmptyString(candidate[key])
    if (parsed === undefined) continue
    if (next[key] !== parsed) changed = true
    next[key] = parsed
  }

  return changed ? next : undefined
}

function normalizeSynthesizedFields(
  keeperRecord: MemoryRecord,
  synthesizedFields: Record<string, string>
): Partial<MemoryRecord> {
  const updates: Record<string, unknown> = {}

  for (const [rawKey, rawValue] of Object.entries(synthesizedFields)) {
    const key = rawKey.trim()
    const value = rawValue.trim()
    if (!key || !value) continue
    if (PROTECTED_SYNTHESIS_FIELDS.has(key)) continue

    switch (keeperRecord.type) {
      case 'command': {
        if (key === 'command' || key === 'truncatedOutput' || key === 'resolution') {
          updates[key] = value
          continue
        }
        if (key === 'exitCode') {
          const parsed = parseIntField(value)
          if (parsed !== undefined) updates.exitCode = parsed
          continue
        }
        if (key === 'outcome' && (value === 'success' || value === 'failure' || value === 'partial')) {
          updates.outcome = value
          continue
        }
        if (key === 'context') {
          const parsed = parseObjectField(value)
          if (!parsed) continue
          const context = buildContextUpdate(
            keeperRecord.context as unknown as Record<string, unknown>,
            parsed,
            ['project', 'cwd', 'intent']
          )
          if (context) {
            updates.context = context
          }
        }
        continue
      }
      case 'error': {
        if (key === 'errorText' || key === 'errorType' || key === 'cause' || key === 'resolution') {
          updates[key] = value
          continue
        }
        if (key === 'context') {
          const parsed = parseObjectField(value)
          if (!parsed) continue
          const context = buildContextUpdate(
            keeperRecord.context as unknown as Record<string, unknown>,
            parsed,
            ['project', 'file', 'tool']
          )
          if (context) {
            updates.context = context
          }
        }
        continue
      }
      case 'discovery': {
        if (key === 'what' || key === 'where' || key === 'evidence') {
          updates[key] = value
          continue
        }
        if (key === 'confidence' && (value === 'verified' || value === 'inferred' || value === 'tentative')) {
          updates.confidence = value
        }
        continue
      }
      case 'procedure': {
        if (key === 'name' || key === 'verification') {
          updates[key] = value
          continue
        }
        if (key === 'steps') {
          const steps = parseStringList(value)
          if (steps.length > 0) updates.steps = steps
          continue
        }
        if (key === 'prerequisites') {
          updates.prerequisites = parseStringList(value)
          continue
        }
        if (key === 'context') {
          const parsed = parseObjectField(value)
          if (!parsed) continue
          const context = buildContextUpdate(
            keeperRecord.context as unknown as Record<string, unknown>,
            parsed,
            ['project']
          )
          if (context) {
            updates.context = context
          }
        }
        continue
      }
      case 'warning': {
        if (key === 'avoid' || key === 'useInstead' || key === 'reason') {
          updates[key] = value
          continue
        }
        if (key === 'severity' && (value === 'caution' || value === 'warning' || value === 'critical')) {
          updates.severity = value
          continue
        }
        if (key === 'sourceRecordIds') {
          updates.sourceRecordIds = parseStringList(value)
        }
        continue
      }
    }
  }

  return updates as Partial<MemoryRecord>
}

async function markConsolidationChecked(
  records: MemoryRecord[],
  checkedAt: number,
  config: Config
): Promise<number> {
  if (records.length === 0) return 0

  try {
    // Fetch records with embeddings (needed for batchUpdateRecords)
    const ids = records.map(r => r.id)
    const idList = ids.map(id => `'${escapeFilterValue(id)}'`).join(', ')
    const recordsWithEmbeddings = await queryRecords(
      { filter: `id IN (${idList})`, includeEmbeddings: true },
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

async function applySynthesizedFields(
  keeperId: string,
  synthesizedFields: Record<string, string>,
  clusterRecords: MemoryRecord[],
  config: Config
): Promise<boolean> {
  try {
    const keeperRecord = clusterRecords.find(r => r.id === keeperId)
    if (!keeperRecord) return false

    const typedFields = normalizeSynthesizedFields(keeperRecord, synthesizedFields)
    if (Object.keys(typedFields).length === 0) {
      logger.warn('  -> Synthesis skipped: no valid content fields to apply')
      return false
    }

    return await updateRecord(keeperId, typedFields, config)
  } catch (error) {
    logger.warn(`  -> Synthesis failed, keeping original content: ${toErrorMessage(error)}`)
    return false
  }
}

function buildKeeperSnippet(clusterRecords: MemoryRecord[], keptId: string): string {
  const keeperRecord = clusterRecords.find(record => record.id === keptId)
  return keeperRecord ? truncateSnippet(buildRecordSnippet(keeperRecord)) : 'cluster'
}

type ConsolidationVerification = Awaited<ReturnType<typeof llmVerifyConsolidation>>

type ConsolidationVerificationOutcome = {
  verification: ConsolidationVerification | null
  verificationError?: string
  rejected: boolean
  checkedAt: number | null
}

type ConsolidationRunCounters = {
  rejected: number
  rejectedFromCache: number
  errors: number
}

async function verifyConsolidationWithCache(args: {
  mode: ConsolidationVerdictMode
  records: MemoryRecord[]
  dryRun: boolean
  config: Config
  maintenance: MaintenanceSettings
  counters: ConsolidationRunCounters
}): Promise<ConsolidationVerificationOutcome> {
  const { mode, records, dryRun, config, maintenance, counters } = args
  const cachedVerdict = loadConsolidationNoMergeVerdict(mode, records, {
    collection: config.lancedb.table,
    backoffDays: maintenance.consolidationNoMergeBackoffDays,
    deleteInvalid: !dryRun
  })
  if (cachedVerdict) {
    counters.rejected += 1
    counters.rejectedFromCache += 1
    logger.info(`  -> Rejected from cache: ${cachedVerdict.reason}`)
    return {
      verification: null,
      rejected: true,
      checkedAt: Date.now()
    }
  }

  let verification: ConsolidationVerification
  let verificationError: string | undefined
  let explicitLlmVerdict = false
  try {
    verification = await llmVerifyConsolidation(records, config, { crossType: mode === 'cross-type' })
    explicitLlmVerdict = true
  } catch (error) {
    const message = toErrorMessage(error)
    if (message.includes('No authentication available')) throw error
    verificationError = message
    logger.warn(`LLM verification failed, using fallback: ${message}`)
    verification = pickConsolidationFallback(records)
    counters.errors += 1
  }

  if (verification.shouldMerge) {
    return {
      verification,
      verificationError,
      rejected: false,
      checkedAt: null
    }
  }

  const checkedAt = Date.now()
  counters.rejected += 1
  if (!dryRun && explicitLlmVerdict) {
    const saved = saveConsolidationNoMergeVerdict(
      mode,
      records,
      verification.reason,
      config.extraction.model,
      { collection: config.lancedb.table, now: checkedAt }
    )
    if (!saved) {
      counters.errors += 1
      logger.warn(`  -> Failed to persist ${mode === 'cross-type' ? 'cross-type ' : ''}consolidation no-merge verdict`)
    }
  }
  logger.info(`  -> Rejected: ${verification.reason}`)
  return {
    verification: null,
    verificationError,
    rejected: true,
    checkedAt
  }
}

function cleanupVerdictsForRun(
  dryRun: boolean,
  config: Config,
  maintenance: MaintenanceSettings
): number {
  if (dryRun || !maintenance.enableConsolidationLlmVerification) return 0
  try {
    cleanupConsolidationNoMergeVerdicts({
      collection: config.lancedb.table,
      backoffDays: maintenance.consolidationNoMergeBackoffDays
    })
    return 0
  } catch (error) {
    logger.warn(`Failed to clean up consolidation verdicts: ${toErrorMessage(error)}`)
    return 1
  }
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
  const counters: ConsolidationRunCounters = { rejected: 0, rejectedFromCache: 0, errors: 0 }
  let deprecated = 0

  try {
    counters.errors += cleanupVerdictsForRun(dryRun, config, maintenance)
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
        let verification: Awaited<ReturnType<typeof llmVerifyConsolidation>> | null = null
        let verificationError: string | undefined

        if (maintenance.enableConsolidationLlmVerification) {
          const outcome = await verifyConsolidationWithCache({
            mode: 'same-type',
            records: clusterRecords,
            dryRun,
            config,
            maintenance,
            counters
          })
          verification = outcome.verification
          verificationError = outcome.verificationError
          if (outcome.rejected) {
            checkedAt = outcome.checkedAt
            continue
          }
        }

        const groups = verification
          ? resolveMergeGroups(verification, clusterRecords)
          : [summarizeCluster(clusterRecords)].filter(Boolean) as { keptId: string; deprecatedIds: string[]; reason?: string }[]

        if (groups.length === 0) continue

        const mergedIds = new Set<string>()
        for (const group of groups) {
          const groupDeprecatedIds = 'mergedIds' in group ? group.mergedIds : (group as any).deprecatedIds as string[]
          if (!groupDeprecatedIds || groupDeprecatedIds.length === 0) continue

          if (dryRun) {
            checkedAt = Date.now()
            actions.push(buildAction({
              type: 'merge',
              recordId: group.keptId,
              snippet: buildKeeperSnippet(clusterRecords, group.keptId),
              reason: `merge ${groupDeprecatedIds.length} duplicates`,
              details: {
                keptId: group.keptId,
                deprecatedIds: groupDeprecatedIds,
                deprecatedRecords: buildDeprecatedRecords(groupDeprecatedIds),
                ...(group.reason ? { decisionReason: group.reason } : {}),
                ...(verificationError ? { verificationError } : {})
              }
            }))
            deprecated += groupDeprecatedIds.length
            logger.info(`  -> Would merge: keep ${group.keptId.slice(0, 8)}..., deprecate ${groupDeprecatedIds.length}`)
          } else {
            const mergeRecords = [group.keptId, ...groupDeprecatedIds]
              .map(id => clusterRecords.find(r => r.id === id))
              .filter(Boolean) as MemoryRecord[]
            const result = await consolidateCluster(mergeRecords, config, {
              keeperId: group.keptId,
              deprecationReasonPrefix: 'consolidation'
            })
            checkedAt = Date.now()
            if (!result || result.deprecatedIds.length === 0) continue

            // Apply synthesized content if provided
            const synth = 'synthesizedFields' in group ? (group as { synthesizedFields?: Record<string, string> }).synthesizedFields : undefined
            let synthesized = false
            if (synth && Object.keys(synth).length > 0) {
              synthesized = await applySynthesizedFields(result.keptId, synth, clusterRecords, config)
              if (synthesized) logger.info(`  -> Synthesized ${Object.keys(synth).length} fields into keeper`)
            }

            actions.push(buildAction({
              type: 'merge',
              recordId: result.keptId,
              snippet: buildKeeperSnippet(clusterRecords, result.keptId),
              reason: `merge ${result.deprecatedIds.length} duplicates`,
              details: {
                keptId: result.keptId,
                deprecatedIds: result.deprecatedIds,
                deprecatedRecords: buildDeprecatedRecords(result.deprecatedIds),
                ...(group.reason ? { decisionReason: group.reason } : {}),
                ...(verificationError ? { verificationError } : {}),
                ...(synthesized ? { synthesized: true } : {})
              }
            }))
            deprecated += result.deprecatedIds.length
            logger.info(`  -> Merged: keep ${result.keptId.slice(0, 8)}..., deprecated ${result.deprecatedIds.length}`)
          }
          mergedIds.add(group.keptId)
          for (const id of groupDeprecatedIds) mergedIds.add(id)
        }

        if (mergedIds.size > 0) clustersMerged += 1
      } catch (error) {
        counters.errors += 1
        logger.warn(`  -> Error processing cluster: ${toErrorMessage(error)}`)
      } finally {
        if (!dryRun && checkedAt) {
          const failed = await markConsolidationChecked(clusterRecords, checkedAt, config)
          if (failed > 0) {
            counters.errors += failed
            logger.warn(`  -> Failed to mark ${failed}/${clusterRecords.length} records as consolidation-checked`)
          }
        }
      }
    }
  } catch (error) {
    logger.error(`Consolidation failed: ${toErrorMessage(error)}`)
    return buildErrorResult(
      actions,
      { clusters: clustersFound, merged: clustersMerged, rejected: counters.rejected, clustersRejectedFromCache: counters.rejectedFromCache, deprecated, errors: counters.errors },
      candidateGroups,
      error
    )
  }

  logger.info(`Consolidation complete: ${clustersMerged} merged, ${counters.rejected} rejected, ${deprecated} deprecated, ${counters.errors} errors`)
  return buildResult(
    actions,
    { clusters: clustersFound, merged: clustersMerged, rejected: counters.rejected, clustersRejectedFromCache: counters.rejectedFromCache, deprecated, errors: counters.errors },
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
  const counters: ConsolidationRunCounters = { rejected: 0, rejectedFromCache: 0, errors: 0 }
  let deprecated = 0

  try {
    counters.errors += cleanupVerdictsForRun(dryRun, config, maintenance)
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
        let verification: Awaited<ReturnType<typeof llmVerifyConsolidation>> | null = null
        let verificationError: string | undefined

        if (maintenance.enableConsolidationLlmVerification) {
          const outcome = await verifyConsolidationWithCache({
            mode: 'cross-type',
            records: clusterRecords,
            dryRun,
            config,
            maintenance,
            counters
          })
          verification = outcome.verification
          verificationError = outcome.verificationError
          if (outcome.rejected) {
            checkedAt = outcome.checkedAt
            continue
          }
        } else {
          verification = pickConsolidationFallback(clusterRecords)
        }

        if (!verification) {
          checkedAt = Date.now()
          continue
        }

        const groups = resolveMergeGroups(verification, clusterRecords)
        if (groups.length === 0) {
          checkedAt = Date.now()
          continue
        }

        const mergedIds = new Set<string>()
        for (const group of groups) {
          if (group.mergedIds.length === 0) continue

          if (dryRun) {
            checkedAt = Date.now()
            actions.push(buildAction({
              type: 'merge',
              recordId: group.keptId,
              snippet: buildKeeperSnippet(clusterRecords, group.keptId),
              reason: `merge ${group.mergedIds.length} cross-type duplicates`,
              details: {
                keptId: group.keptId,
                deprecatedIds: group.mergedIds,
                deprecatedRecords: buildDeprecatedRecords(group.mergedIds),
                decisionReason: group.reason,
                ...(verificationError ? { verificationError } : {})
              }
            }))
            deprecated += group.mergedIds.length
            logger.info(`  -> Would merge: keep ${group.keptId.slice(0, 8)}..., deprecate ${group.mergedIds.length}`)
          } else {
            const mergeRecords = [group.keptId, ...group.mergedIds]
              .map(id => clusterRecords.find(r => r.id === id))
              .filter(Boolean) as MemoryRecord[]
            const result = await consolidateCluster(mergeRecords, config, {
              keeperId: group.keptId,
              deprecationReasonPrefix: 'cross-type-consolidation'
            })
            checkedAt = Date.now()
            if (!result || result.deprecatedIds.length === 0) continue

            // Apply synthesized content if provided
            let synthesized = false
            if (group.synthesizedFields && Object.keys(group.synthesizedFields).length > 0) {
              synthesized = await applySynthesizedFields(result.keptId, group.synthesizedFields, clusterRecords, config)
              if (synthesized) logger.info(`  -> Synthesized ${Object.keys(group.synthesizedFields).length} fields into keeper`)
            }

            actions.push(buildAction({
              type: 'merge',
              recordId: result.keptId,
              snippet: buildKeeperSnippet(clusterRecords, result.keptId),
              reason: `merge ${result.deprecatedIds.length} cross-type duplicates`,
              details: {
                keptId: result.keptId,
                deprecatedIds: result.deprecatedIds,
                deprecatedRecords: buildDeprecatedRecords(result.deprecatedIds),
                decisionReason: group.reason,
                ...(verificationError ? { verificationError } : {}),
                ...(synthesized ? { synthesized: true } : {})
              }
            }))
            deprecated += result.deprecatedIds.length
            logger.info(`  -> Merged: keep ${result.keptId.slice(0, 8)}..., deprecated ${result.deprecatedIds.length}`)
          }
          mergedIds.add(group.keptId)
          for (const id of group.mergedIds) mergedIds.add(id)
        }

        if (mergedIds.size > 0) clustersMerged += 1
      } catch (error) {
        counters.errors += 1
        logger.warn(`  -> Error processing cluster: ${toErrorMessage(error)}`)
      } finally {
        if (!dryRun && checkedAt) {
          const failed = await markConsolidationChecked(clusterRecords, checkedAt, config)
          if (failed > 0) {
            counters.errors += failed
            logger.warn(`  -> Failed to mark ${failed}/${clusterRecords.length} records as consolidation-checked`)
          }
        }
      }
    }
  } catch (error) {
    logger.error(`Cross-type consolidation failed: ${toErrorMessage(error)}`)
    return buildErrorResult(
      actions,
      { clusters: clustersFound, merged: clustersMerged, rejected: counters.rejected, clustersRejectedFromCache: counters.rejectedFromCache, deprecated, errors: counters.errors },
      candidateGroups,
      error
    )
  }

  logger.info(`Cross-type consolidation complete: ${clustersMerged} merged, ${counters.rejected} rejected, ${deprecated} deprecated, ${counters.errors} errors`)
  return buildResult(
    actions,
    { clusters: clustersFound, merged: clustersMerged, rejected: counters.rejected, clustersRejectedFromCache: counters.rejectedFromCache, deprecated, errors: counters.errors },
    candidateGroups
  )
}
