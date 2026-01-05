#!/usr/bin/env -S npx tsx

import fs from 'fs'
import path from 'path'
import { initMilvus } from './lib/milvus.js'
import {
  checkValidity,
  consolidateCluster,
  findContradictionPairs,
  findLowUsageRecords,
  findSimilarClusters,
  findStaleRecords,
  markDeprecated,
  resolveContradiction
} from './lib/maintenance.js'
import { writeSuggestions } from './lib/promotions.js'
import { DEFAULT_CONFIG, type Config } from './lib/types.js'

const SIMILARITY_THRESHOLD = 0.85

async function main(): Promise<void> {
  const config = loadConfig(process.cwd())
  await initMilvus(config)

  console.error('[claude-memory] Maintenance started.')

  await runStaleCheck(config)
  await runLowUsageCheck(config)
  await runConsolidation(config)
  await runContradictionCheck(config)
  await runPromotions(config)

  console.error('[claude-memory] Maintenance complete.')
}

async function runStaleCheck(config: Config): Promise<void> {
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
          const updated = await markDeprecated(record.id, config)
          if (updated) {
            deprecated += 1
            console.error(`[claude-memory] Deprecated ${record.id} (${validity.reason ?? 'invalid'})`)
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

async function runLowUsageCheck(config: Config): Promise<void> {
  let candidates = 0
  let deprecated = 0

  try {
    const records = await findLowUsageRecords(config)
    candidates = records.length
    console.error(`[claude-memory] Low usage candidates: ${candidates}`)

    for (const record of records) {
      const ratio = (record.usageCount ?? 0) / (record.retrievalCount ?? 1)
      const updated = await markDeprecated(record.id, config)
      if (updated) {
        deprecated += 1
        console.error(`[claude-memory] Deprecated ${record.id} (low-usage:${(ratio * 100).toFixed(0)}% over ${record.retrievalCount} retrievals)`)
      }
    }
  } catch (error) {
    console.error('[claude-memory] Failed to check low usage records:', error)
  }

  console.error(`[claude-memory] Low usage check summary: candidates=${candidates} deprecated=${deprecated}`)
}

async function runConsolidation(config: Config): Promise<void> {
  let clustersFound = 0
  let clustersMerged = 0
  let deprecated = 0

  try {
    const clusters = await findSimilarClusters(SIMILARITY_THRESHOLD, config)
    clustersFound = clusters.length
    console.error(`[claude-memory] Similarity clusters: ${clustersFound}`)

    for (const cluster of clusters) {
      try {
        const result = await consolidateCluster(cluster, config)
        if (!result || result.deprecatedIds.length === 0) continue
        clustersMerged += 1
        deprecated += result.deprecatedIds.length
        console.error(`[claude-memory] Consolidated keep=${result.keptId} deprecated=${result.deprecatedIds.join(',')}`)
      } catch (error) {
        console.error('[claude-memory] consolidateCluster failed:', error)
      }
    }
  } catch (error) {
    console.error('[claude-memory] Failed to build similarity clusters:', error)
  }

  console.error(`[claude-memory] Consolidation summary: clusters=${clustersFound} merged=${clustersMerged} deprecated=${deprecated}`)
}

async function runContradictionCheck(config: Config): Promise<void> {
  let pairsFound = 0
  let deprecated = 0

  try {
    const pairs = await findContradictionPairs(config)
    pairsFound = pairs.length
    console.error(`[claude-memory] Contradiction pairs: ${pairsFound}`)

    for (const pair of pairs) {
      try {
        const updated = await resolveContradiction(pair, config)
        if (updated) {
          deprecated += 1
          const newerSnippet = truncateForLog(buildRecordSnippet(pair.newer))
          const olderSnippet = truncateForLog(buildRecordSnippet(pair.older))
          console.error(`[claude-memory] Contradiction resolved: kept="${newerSnippet}" deprecated="${olderSnippet}" (sim=${pair.similarity.toFixed(2)})`)
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

async function runPromotions(config: Config): Promise<void> {
  try {
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

function loadConfig(root: string): Config {
  const configPath = path.join(root, 'config.json')
  if (!fs.existsSync(configPath)) return DEFAULT_CONFIG

  try {
    const raw = fs.readFileSync(configPath, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<Config>
    return {
      ...DEFAULT_CONFIG,
      milvus: { ...DEFAULT_CONFIG.milvus, ...parsed.milvus },
      embeddings: { ...DEFAULT_CONFIG.embeddings, ...parsed.embeddings },
      extraction: { ...DEFAULT_CONFIG.extraction, ...parsed.extraction },
      injection: { ...DEFAULT_CONFIG.injection, ...parsed.injection }
    }
  } catch (error) {
    console.error('[claude-memory] Failed to load config.json:', error)
    return DEFAULT_CONFIG
  }
}

main()
  .then(() => {
    process.exitCode = 0
  })
  .catch(error => {
    console.error('[claude-memory] maintenance failed:', error)
    process.exitCode = 2
  })
