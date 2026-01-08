#!/usr/bin/env -S npx tsx

import path from 'path'
import { fileURLToPath } from 'url'
import { initMilvus } from './lib/milvus.js'
import {
  checkValidity,
  checkGlobalPromotion,
  consolidateCluster,
  findGlobalCandidates,
  findLowUsageHighRetrieval,
  findLowUsageRecords,
  findSimilarClusters,
  GLOBAL_PROMOTION_BATCH_SIZE,
  GLOBAL_PROMOTION_MIN_CONFIDENCE,
  GLOBAL_PROMOTION_RECHECK_DAYS,
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
import { DEFAULT_CONFIG, SIMILARITY_THRESHOLDS, type Config } from './lib/types.js'
import { updateRecord } from './lib/milvus.js'
import { buildCandidateRecord, buildRecordSnippet, truncateSnippet } from './lib/shared.js'

export { runConflictResolution }

export type MaintenanceActionType = 'deprecate' | 'update' | 'merge' | 'promote' | 'suggestion'

export interface MaintenanceMergeRecord {
  id: string
  snippet: string | null
}

export interface MaintenanceActionDetails {
  keptId?: string
  deprecatedIds?: string[]
  deprecatedRecords?: MaintenanceMergeRecord[]
  before?: string
  after?: string
  newerId?: string
  similarity?: number
  [key: string]: unknown
}

export interface MaintenanceAction {
  type: MaintenanceActionType
  recordId?: string
  snippet: string
  reason: string
  details?: MaintenanceActionDetails
}

export interface MaintenanceRunResult {
  actions: MaintenanceAction[]
  summary: Record<string, number>
  candidates: MaintenanceCandidateGroup[]
  error?: string
}

async function main(): Promise<void> {
  const config = loadConfig(process.cwd())
  const dryRun = process.argv.slice(2).includes('--dry-run')
  await initMilvus(config)

  console.error('[claude-memory] Maintenance started.')

  logMaintenanceResult('Stale check', await runStaleCheck(dryRun, config), dryRun)
  logMaintenanceResult('Low usage deprecation', await runLowUsageDeprecation(dryRun, config), dryRun)
  logMaintenanceResult('Low usage check', await runLowUsageCheck(dryRun, config), dryRun)
  logMaintenanceResult('Consolidation', await runConsolidation(dryRun, config), dryRun)
  logMaintenanceResult('Conflict resolution', await runConflictResolution(dryRun, config), dryRun)
  logMaintenanceResult('Global promotion', await runGlobalPromotion(dryRun, config), dryRun)
  logMaintenanceResult('Warning synthesis', await runWarningSynthesis(dryRun, config), dryRun)
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

export async function runStaleCheck(
  dryRun: boolean,
  config: Config = DEFAULT_CONFIG
): Promise<MaintenanceRunResult> {
  const actions: MaintenanceAction[] = []
  const candidates: MaintenanceCandidateGroup[] = []
  let checked = 0
  let deprecated = 0
  let errors = 0

  try {
    const records = await findStaleRecords(config)
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
    return { actions, summary: { checked, deprecated, errors }, candidates, error: message }
  }

  return { actions, summary: { checked, deprecated, errors }, candidates }
}

export async function runLowUsageDeprecation(
  dryRun: boolean,
  config: Config = DEFAULT_CONFIG
): Promise<MaintenanceRunResult> {
  const actions: MaintenanceAction[] = []
  const candidateGroups: MaintenanceCandidateGroup[] = []
  let candidates = 0
  let deprecated = 0
  let errors = 0

  try {
    const records = await findLowUsageHighRetrieval(config)
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

export async function runLowUsageCheck(
  dryRun: boolean,
  config: Config = DEFAULT_CONFIG
): Promise<MaintenanceRunResult> {
  const actions: MaintenanceAction[] = []
  const candidateGroups: MaintenanceCandidateGroup[] = []
  let candidates = 0
  let deprecated = 0
  let errors = 0

  try {
    const records = await findLowUsageRecords(config)
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
  config: Config = DEFAULT_CONFIG
): Promise<MaintenanceRunResult> {
  const actions: MaintenanceAction[] = []
  const candidateGroups: MaintenanceCandidateGroup[] = []
  let clustersFound = 0
  let clustersMerged = 0
  let deprecated = 0
  let errors = 0

  try {
    const clusters = await findSimilarClusters(SIMILARITY_THRESHOLDS.CONSOLIDATION, config)
    clustersFound = clusters.length
    if (clusters.length > 0) {
      const thresholdPercent = Math.round(SIMILARITY_THRESHOLDS.CONSOLIDATION * 100)
      candidateGroups.push(...clusters.map((cluster, index) => ({
        id: `consolidation-cluster-${index + 1}`,
        label: `Cluster ${index + 1}`,
        reason: `similarity >= ${thresholdPercent}%`,
        records: cluster.members.map(member =>
          buildCandidateRecord(member.record, 'similar record', { similarity: member.similarity })
        )
      })))
    }

    for (const cluster of clusters) {
      const clusterRecords = cluster.members.map(member => member.record)
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

        if (dryRun) {
          const preview = summarizeCluster(clusterRecords)
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
              deprecatedRecords: buildDeprecatedRecords(preview.deprecatedIds)
            }
          })
          clustersMerged += 1
          deprecated += preview.deprecatedIds.length
          continue
        }

        const result = await consolidateCluster(clusterRecords, config)
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
            deprecatedRecords: buildDeprecatedRecords(result.deprecatedIds)
          }
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
      candidates: candidateGroups,
      error: message
    }
  }

  return { actions, summary: { clusters: clustersFound, merged: clustersMerged, deprecated, errors }, candidates: candidateGroups }
}

export async function runGlobalPromotion(
  dryRun: boolean,
  config: Config = DEFAULT_CONFIG
): Promise<MaintenanceRunResult> {
  const actions: MaintenanceAction[] = []
  const candidateGroups: MaintenanceCandidateGroup[] = []
  let candidates = 0
  let checked = 0
  let promoted = 0
  let skippedRecent = 0
  let errors = 0

  try {
    const records = await findGlobalCandidates(config)
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
    const cutoff = Date.now() - GLOBAL_PROMOTION_RECHECK_DAYS * 24 * 60 * 60 * 1000
    const eligible = records.filter(record => (record.lastGlobalCheck ?? 0) < cutoff)
    skippedRecent = candidates - eligible.length

    const batch = selectPromotionBatch(eligible, GLOBAL_PROMOTION_BATCH_SIZE)

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
  config: Config = DEFAULT_CONFIG
): Promise<MaintenanceRunResult> {
  try {
    const result = await runWarningSynthesisInternal(dryRun, config)
    const actions: MaintenanceAction[] = result.actions
      .filter(action => action.type === 'created')
      .map(action => ({
        type: 'update' as MaintenanceActionType,
        recordId: action.warningId,
        snippet: action.avoid ? `warning: ${truncateSnippet(action.avoid)}` : 'warning',
        reason: `synthesized from ${action.sourceRecordIds.length} failures`,
        details: { sourceRecordIds: action.sourceRecordIds }
      }))
    return { actions, summary: result.summary, candidates: result.candidates }
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
