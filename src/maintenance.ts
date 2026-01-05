#!/usr/bin/env -S npx tsx

import { initMilvus } from './lib/milvus.js'
import {
  checkValidity,
  checkGeneralization,
  consolidateCluster,
  findContradictionPairs,
  findGlobalCandidates,
  findLowUsageRecords,
  findSimilarClusters,
  generalizeRecord,
  findStaleRecords,
  markDeprecated,
  promoteToGlobal,
  resolveContradiction
} from './lib/maintenance.js'
import { findClaudeMdCandidates, findSkillCandidates, writeSuggestions } from './lib/promotions.js'
import { loadConfig } from './lib/config.js'
import { type Config, type MemoryRecord } from './lib/types.js'
import { queryRecords, updateRecord } from './lib/milvus.js'

const SIMILARITY_THRESHOLD = 0.85
const GENERALIZATION_BATCH_SIZE = 20
const GENERALIZATION_SAMPLE_LIMIT = 200
const GENERALIZATION_RECHECK_DAYS = 30

async function main(): Promise<void> {
  const config = loadConfig(process.cwd())
  const dryRun = process.argv.slice(2).includes('--dry-run')
  await initMilvus(config)

  console.error('[claude-memory] Maintenance started.')

  await runStaleCheck(config, dryRun)
  await runGeneralization(config, dryRun)
  await runLowUsageCheck(config, dryRun)
  await runConsolidation(config, dryRun)
  await runContradictionCheck(config, dryRun)
  await runGlobalPromotion(config, dryRun)
  await runPromotions(config, dryRun)

  if (dryRun) {
    console.error('[claude-memory] Maintenance complete (DRY RUN - no changes made)')
  } else {
    console.error('[claude-memory] Maintenance complete.')
  }
}

async function runStaleCheck(config: Config, dryRun: boolean): Promise<void> {
  let staleRecords = 0
  let deprecated = 0

  try {
    const records = await findStaleRecords(config)
    staleRecords = records.length
    console.error(`[claude-memory] Stale candidates: ${staleRecords}`)

    for (const record of records) {
      try {
        const validity = await checkValidity(record)
        if (!validity.valid) {
          if (dryRun) {
            deprecated += 1
            console.error(`[claude-memory] [DRY RUN] Would deprecate record ${record.id} (${validity.reason ?? 'invalid'})`)
          } else {
            const updated = await markDeprecated(record.id, config)
            if (updated) {
              deprecated += 1
              console.error(`[claude-memory] Deprecated ${record.id} (${validity.reason ?? 'invalid'})`)
            }
          }
        }
      } catch (error) {
        console.error(`[claude-memory] Validity check failed for ${record.id}:`, error)
      }
    }
  } catch (error) {
    console.error('[claude-memory] Failed to load stale candidates:', error)
  }

  console.error(`[claude-memory] Stale check summary: checked=${staleRecords} deprecated=${deprecated}`)
}

async function runLowUsageCheck(config: Config, dryRun: boolean): Promise<void> {
  let candidates = 0
  let deprecated = 0
  let skippedRecentGeneralization = 0

  const generalizationCutoff = Date.now() - GENERALIZATION_RECHECK_DAYS * 24 * 60 * 60 * 1000

  try {
    const records = await findLowUsageRecords(config)
    candidates = records.length
    console.error(`[claude-memory] Low usage candidates: ${candidates}`)

    for (const record of records) {
      const lastCheck = record.lastGeneralizationCheck ?? 0
      if (lastCheck >= generalizationCutoff) {
        skippedRecentGeneralization += 1
        continue
      }

      const ratio = (record.usageCount ?? 0) / (record.retrievalCount ?? 1)
      if (dryRun) {
        deprecated += 1
        console.error(`[claude-memory] [DRY RUN] Would deprecate record ${record.id} (low-usage:${(ratio * 100).toFixed(0)}% over ${record.retrievalCount} retrievals)`)
      } else {
        const updated = await markDeprecated(record.id, config)
        if (updated) {
          deprecated += 1
          console.error(`[claude-memory] Deprecated ${record.id} (low-usage:${(ratio * 100).toFixed(0)}% over ${record.retrievalCount} retrievals)`)
        }
      }
    }
  } catch (error) {
    console.error('[claude-memory] Failed to check low usage records:', error)
  }

  console.error(`[claude-memory] Low usage check summary: candidates=${candidates} deprecated=${deprecated} skipped_recent_generalization=${skippedRecentGeneralization}`)
}

async function runGeneralization(config: Config, dryRun: boolean): Promise<void> {
  let eligible = 0
  let checked = 0
  let generalized = 0
  let skippedRecent = 0
  let skippedGeneralized = 0

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

    console.error(`[claude-memory] Generalization candidates: ${eligible} (sampled=${candidates.length})`)

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

          const before = truncateForLog(buildRecordSnippet(record))
          const afterRecord = { ...record, ...updates } as MemoryRecord
          const after = truncateForLog(buildRecordSnippet(afterRecord))
          const reason = result.reason ? ` reason=${result.reason}` : ''

          if (dryRun) {
            generalized += 1
            applied = true
            console.error(`[claude-memory] [DRY RUN] Would generalize ${record.id}${reason} before="${before}" after="${after}"`)
          } else {
            const updated = await generalizeRecord(record.id, updates, config)
            if (updated) {
              applied = true
              generalized += 1
              console.error(`[claude-memory] Generalized ${record.id}${reason} before="${before}" after="${after}"`)
            }
          }
        }

        if (!dryRun && !applied) {
          await updateRecord(record.id, { lastGeneralizationCheck: checkedAt }, config)
        }
      } catch (error) {
        console.error(`[claude-memory] Generalization check failed for ${record.id}:`, error)
      }
    }
  } catch (error) {
    console.error('[claude-memory] Failed to run generalization check:', error)
  }

  console.error(
    `[claude-memory] Generalization summary: checked=${checked} generalized=${generalized} skipped_recent=${skippedRecent} skipped_generalized=${skippedGeneralized}`
  )
}

async function runConsolidation(config: Config, dryRun: boolean): Promise<void> {
  let clustersFound = 0
  let clustersMerged = 0
  let deprecated = 0

  try {
    const clusters = await findSimilarClusters(SIMILARITY_THRESHOLD, config)
    clustersFound = clusters.length
    console.error(`[claude-memory] Similarity clusters: ${clustersFound}`)

    for (const cluster of clusters) {
      try {
        if (dryRun) {
          const preview = summarizeCluster(cluster)
          if (!preview || preview.deprecatedIds.length === 0) continue
          clustersMerged += 1
          deprecated += preview.deprecatedIds.length
          console.error(`[claude-memory] [DRY RUN] Would consolidate keep=${preview.keptId} deprecated=${preview.deprecatedIds.join(',')}`)
        } else {
          const result = await consolidateCluster(cluster, config)
          if (!result || result.deprecatedIds.length === 0) continue
          clustersMerged += 1
          deprecated += result.deprecatedIds.length
          console.error(`[claude-memory] Consolidated keep=${result.keptId} deprecated=${result.deprecatedIds.join(',')}`)
        }
      } catch (error) {
        console.error('[claude-memory] consolidateCluster failed:', error)
      }
    }
  } catch (error) {
    console.error('[claude-memory] Failed to build similarity clusters:', error)
  }

  console.error(`[claude-memory] Consolidation summary: clusters=${clustersFound} merged=${clustersMerged} deprecated=${deprecated}`)
}

async function runContradictionCheck(config: Config, dryRun: boolean): Promise<void> {
  let pairsFound = 0
  let deprecated = 0

  try {
    const pairs = await findContradictionPairs(config)
    pairsFound = pairs.length
    console.error(`[claude-memory] Contradiction pairs: ${pairsFound}`)

    for (const pair of pairs) {
      try {
        if (dryRun) {
          deprecated += 1
          console.error(`[claude-memory] [DRY RUN] Would deprecate record ${pair.older.id} (contradiction sim=${pair.similarity.toFixed(2)})`)
        } else {
          const updated = await resolveContradiction(pair, config)
          if (updated) {
            deprecated += 1
            const newerSnippet = truncateForLog(buildRecordSnippet(pair.newer))
            const olderSnippet = truncateForLog(buildRecordSnippet(pair.older))
            console.error(`[claude-memory] Contradiction resolved: kept="${newerSnippet}" deprecated="${olderSnippet}" (sim=${pair.similarity.toFixed(2)})`)
          }
        }
      } catch (error) {
        console.error(`[claude-memory] Failed to resolve contradiction:`, error)
      }
    }
  } catch (error) {
    console.error('[claude-memory] Failed to find contradiction pairs:', error)
  }

  console.error(`[claude-memory] Contradiction check summary: pairs=${pairsFound} deprecated=${deprecated}`)
}

async function runGlobalPromotion(config: Config, dryRun: boolean): Promise<void> {
  let candidates = 0
  let promoted = 0

  try {
    const records = await findGlobalCandidates(config)
    candidates = records.length
    console.error(`[claude-memory] Global promotion candidates: ${candidates}`)

    for (const record of records) {
      if (dryRun) {
        promoted += 1
        console.error(`[claude-memory] [DRY RUN] Would promote record ${record.id} to global scope`)
      } else {
        const updated = await promoteToGlobal(record.id, config)
        if (updated) {
          promoted += 1
          console.error(`[claude-memory] Promoted ${record.id} to global scope`)
        }
      }
    }
  } catch (error) {
    console.error('[claude-memory] Failed to promote global candidates:', error)
  }

  console.error(`[claude-memory] Global promotion summary: candidates=${candidates} promoted=${promoted}`)
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

function truncateForLog(value: string, maxLength: number = 60): string {
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

main()
  .then(() => {
    process.exitCode = 0
  })
  .catch(error => {
    console.error('[claude-memory] maintenance failed:', error)
    process.exitCode = 2
  })
