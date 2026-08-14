#!/usr/bin/env npx tsx
/**
 * Clone the production LanceDB table into an eval table for the entity A/B eval.
 * Embeddings are carried over verbatim — nothing is re-embedded.
 *
 * Usage:
 *   npx tsx scripts/eval-clone-table.ts                  # full clone into cc_memories_eval
 *   npx tsx scripts/eval-clone-table.ts --limit 50       # smoke clone
 *   npx tsx scripts/eval-clone-table.ts --reset          # drop + recreate eval table first
 *   npx tsx scripts/eval-clone-table.ts --table my_eval  # custom eval table name
 */

import { buildLanceRow, countRecords, initLanceDB, iterateRecords, resetCollection } from '../src/lib/lancedb.js'
import { ensureClient } from '../src/lib/lancedb-client.js'
import { argNumber, buildEvalConfig, hasFlag, loadProdConfig } from './eval-shared.js'

const BATCH_SIZE = 200

async function clone() {
  const limit = argNumber('--limit') ?? Number.POSITIVE_INFINITY
  const prodConfig = loadProdConfig()
  const evalConfig = buildEvalConfig(prodConfig)

  console.log(`[eval-clone] Source table: ${prodConfig.lancedb.table}`)
  console.log(`[eval-clone] Target table: ${evalConfig.lancedb.table}`)

  await initLanceDB(prodConfig)
  const prodCount = await countRecords({}, prodConfig)
  if (prodCount === 0) {
    // A typo'd table name is silently created empty — never clone from nothing.
    throw new Error(`Source table '${prodConfig.lancedb.table}' is empty; refusing to clone.`)
  }
  console.log(`[eval-clone] Source records: ${prodCount}`)

  if (hasFlag('--reset')) {
    console.log('[eval-clone] Resetting eval table...')
    await resetCollection(evalConfig)
  }
  await initLanceDB(evalConfig)
  const preexisting = await countRecords({}, evalConfig)
  if (preexisting > 0) {
    console.log(`[eval-clone] Eval table already has ${preexisting} records; merging by id.`)
  }

  const { table } = await ensureClient(evalConfig)
  let copied = 0
  let rows: Array<Record<string, unknown>> = []

  const flush = async (): Promise<void> => {
    if (rows.length === 0) return
    await table
      .mergeInsert('id')
      .whenMatchedUpdateAll()
      .whenNotMatchedInsertAll()
      .execute(rows)
    copied += rows.length
    rows = []
    process.stdout.write(`\r[eval-clone] Copied ${copied}/${Math.min(prodCount, limit)}`)
  }

  // includeEmbeddings is load-bearing: without it buildLanceRow re-embeds
  // every record through the embedding API.
  for await (const record of iterateRecords({ includeEmbeddings: true }, prodConfig)) {
    if (copied + rows.length >= limit) break
    if (!record.embedding || record.embedding.length === 0) {
      throw new Error(`Record ${record.id} came back without an embedding; aborting clone.`)
    }
    rows.push(await buildLanceRow(record, evalConfig))
    if (rows.length >= BATCH_SIZE) await flush()
  }
  await flush()
  console.log()

  const evalCount = await countRecords({}, evalConfig)
  const expected = Math.min(prodCount, limit)
  console.log(`[eval-clone] Done. Eval table now has ${evalCount} records (copied ${copied}).`)
  if (preexisting === 0 && evalCount !== expected) {
    throw new Error(`Count mismatch: expected ${expected}, found ${evalCount}.`)
  }
}

clone().catch(error => {
  console.error('[eval-clone] Fatal error:', error)
  process.exit(1)
})
