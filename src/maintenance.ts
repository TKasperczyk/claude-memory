#!/usr/bin/env -S npx tsx

import fs from 'fs'
import path from 'path'
import { initMilvus } from './lib/milvus.js'
import {
  checkValidity,
  consolidateCluster,
  findSimilarClusters,
  findStaleRecords,
  markDeprecated
} from './lib/maintenance.js'
import { DEFAULT_CONFIG, type Config } from './lib/types.js'

const SIMILARITY_THRESHOLD = 0.85

async function main(): Promise<void> {
  const config = loadConfig(process.cwd())
  await initMilvus(config)

  console.error('[claude-memory] Maintenance started.')

  await runStaleCheck(config)
  await runConsolidation(config)

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
