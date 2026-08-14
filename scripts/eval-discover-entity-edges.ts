#!/usr/bin/env npx tsx
/**
 * Run entity-overlap edge discovery against the eval table.
 *
 * Usage:
 *   npx tsx scripts/eval-discover-entity-edges.ts             # discover + persist edges
 *   npx tsx scripts/eval-discover-entity-edges.ts --dry-run   # print top pairs, no writes
 *   npx tsx scripts/eval-discover-entity-edges.ts --table my_eval
 */

import { countRecords, initLanceDB } from '../src/lib/lancedb.js'
import { runEntityOverlapDiscovery } from '../src/lib/maintenance/runners/index.js'
import { buildEvalConfig, hasFlag, loadProdConfig } from './eval-shared.js'

const TOP_PAIRS_SHOWN = 20

async function discover() {
  const dryRun = hasFlag('--dry-run')
  const prodConfig = loadProdConfig()
  const evalConfig = buildEvalConfig(prodConfig)

  console.log(`[eval-edges] Table: ${evalConfig.lancedb.table}`)
  if (dryRun) console.log('[eval-edges] DRY RUN - no writes')

  await initLanceDB(evalConfig)
  const total = await countRecords({}, evalConfig)
  if (total === 0) {
    throw new Error(`Eval table '${evalConfig.lancedb.table}' is empty; run eval-clone-table first.`)
  }

  const result = await runEntityOverlapDiscovery(dryRun, evalConfig)

  console.log('[eval-edges] Summary:', JSON.stringify(result.summary))
  if (result.error) throw new Error(result.error)

  const shown = result.actions.slice(0, TOP_PAIRS_SHOWN)
  if (shown.length > 0) {
    console.log(`[eval-edges] Top ${shown.length} pairs (of ${result.actions.length}):`)
    for (const action of shown) {
      const weight = action.details?.weight
      console.log(`  - w=${typeof weight === 'number' ? weight.toFixed(2) : '?'} ${action.snippet}`)
      console.log(`    ${action.reason}`)
    }
  }
}

discover().catch(error => {
  console.error('[eval-edges] Fatal error:', error)
  process.exit(1)
})
