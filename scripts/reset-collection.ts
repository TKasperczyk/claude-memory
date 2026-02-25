#!/usr/bin/env npx tsx
/**
 * Reset the LanceDB table - drops and recreates with empty schema.
 *
 * Usage:
 *   npx tsx scripts/reset-collection.ts
 *   npx tsx scripts/reset-collection.ts --force  # Skip confirmation
 */

import { createInterface } from 'readline'
import { DEFAULT_CONFIG, EMBEDDING_DIM } from '../src/lib/types.js'
import { countRecords, initLanceDB, resetCollection } from '../src/lib/lancedb.js'

async function confirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => {
    rl.question(`${message} (y/N): `, answer => {
      rl.close()
      resolve(answer.toLowerCase() === 'y')
    })
  })
}

async function reset() {
  const force = process.argv.includes('--force')
  const config = DEFAULT_CONFIG

  console.log(`[reset] LanceDB directory: ${config.lancedb.directory}`)
  console.log(`[reset] Table: ${config.lancedb.table}`)
  console.log(`[reset] Embedding dim: ${EMBEDDING_DIM}`)

  await initLanceDB(config)
  const count = await countRecords({}, config)
  console.log(`[reset] Current record count: ${count}`)

  if (count > 0 && !force) {
    const proceed = await confirm(`This will DELETE all ${count} records. Continue?`)
    if (!proceed) {
      console.log('[reset] Aborted.')
      return
    }
  }

  console.log('[reset] Resetting table...')
  await resetCollection(config)

  console.log('[reset] Done. Table is now empty.')
}

reset().catch(e => {
  console.error('[reset] Fatal error:', e)
  process.exit(1)
})
