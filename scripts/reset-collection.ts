#!/usr/bin/env npx tsx
/**
 * Reset the Milvus collection - drops and recreates with empty schema.
 *
 * Usage:
 *   npx tsx scripts/reset-collection.ts
 *   npx tsx scripts/reset-collection.ts --force  # Skip confirmation
 */

import { MilvusClient } from '@zilliz/milvus2-sdk-node'
import { createInterface } from 'readline'
import { DEFAULT_CONFIG, EMBEDDING_DIM } from '../src/lib/types.js'
import { initMilvus } from '../src/lib/milvus.js'

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

  console.log(`[reset] Collection: ${config.milvus.collection}`)
  console.log(`[reset] Address: ${config.milvus.address}`)
  console.log(`[reset] Embedding dim: ${EMBEDDING_DIM}`)

  const client = new MilvusClient({ address: config.milvus.address })
  await client.connect({})

  // Check if collection exists and get stats
  const exists = await client.hasCollection({ collection_name: config.milvus.collection })
  if (exists.value) {
    await client.loadCollection({ collection_name: config.milvus.collection })
    const stats = await client.getCollectionStatistics({ collection_name: config.milvus.collection })
    const count = parseInt(stats.data.row_count ?? '0', 10)
    console.log(`[reset] Current record count: ${count}`)

    if (!force) {
      const proceed = await confirm(`This will DELETE all ${count} records. Continue?`)
      if (!proceed) {
        console.log('[reset] Aborted.')
        return
      }
    }

    console.log('[reset] Dropping collection...')
    await client.dropCollection({ collection_name: config.milvus.collection })
  } else {
    console.log('[reset] Collection does not exist.')
  }

  console.log('[reset] Creating fresh collection...')
  await initMilvus(config)

  console.log('[reset] Done. Collection is now empty.')
}

reset().catch(e => {
  console.error('[reset] Fatal error:', e)
  process.exit(1)
})
