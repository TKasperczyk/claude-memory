#!/usr/bin/env npx tsx
/**
 * Migration script: Re-embed all records with a new embedding model.
 *
 * Use when changing embedding models or dimensions.
 *
 * Usage:
 *   npx tsx scripts/migrate-embeddings.ts
 *   npx tsx scripts/migrate-embeddings.ts --dry-run
 */

import { MilvusClient } from '@zilliz/milvus2-sdk-node'
import { DEFAULT_CONFIG, EMBEDDING_DIM, type MemoryRecord } from '../src/lib/types.js'
import { initMilvus, insertRecord } from '../src/lib/milvus.js'

const BATCH_SIZE = 100

async function migrate() {
  const dryRun = process.argv.includes('--dry-run')
  const config = DEFAULT_CONFIG

  console.log(`[migrate] Starting migration...`)
  console.log(`[migrate] Collection: ${config.milvus.collection}`)
  console.log(`[migrate] New embedding dim: ${EMBEDDING_DIM}`)
  console.log(`[migrate] Embedding model: ${config.embeddings.model}`)
  if (dryRun) console.log(`[migrate] DRY RUN - no changes will be made`)

  // Connect to Milvus
  const client = new MilvusClient({ address: config.milvus.address })
  await client.connect({})
  console.log(`[migrate] Connected to Milvus at ${config.milvus.address}`)

  // Check if collection exists
  const exists = await client.hasCollection({ collection_name: config.milvus.collection })
  if (!exists.value) {
    console.log(`[migrate] Collection does not exist. Nothing to migrate.`)
    return
  }

  // Load collection for querying
  await client.loadCollection({ collection_name: config.milvus.collection })

  // Get total count
  const stats = await client.getCollectionStatistics({ collection_name: config.milvus.collection })
  const totalCount = parseInt(stats.data.row_count ?? '0', 10)
  console.log(`[migrate] Found ${totalCount} records to migrate`)

  if (totalCount === 0) {
    console.log(`[migrate] No records to migrate.`)
    return
  }

  // Export all records (content JSON only, no embeddings)
  console.log(`[migrate] Exporting records...`)
  const records: MemoryRecord[] = []
  let offset = 0

  while (offset < totalCount) {
    const result = await client.query({
      collection_name: config.milvus.collection,
      filter: 'id != ""',
      output_fields: ['id', 'type', 'content'],
      limit: BATCH_SIZE,
      offset
    })

    for (const row of result.data) {
      try {
        const parsed = JSON.parse(row.content as string) as MemoryRecord
        // Ensure id matches stored id
        parsed.id = row.id as string
        // Remove old embedding if present
        delete parsed.embedding
        records.push(parsed)
      } catch (e) {
        console.error(`[migrate] Failed to parse record ${row.id}:`, e)
      }
    }

    offset += BATCH_SIZE
    process.stdout.write(`\r[migrate] Exported ${Math.min(offset, totalCount)}/${totalCount}`)
  }
  console.log()

  if (dryRun) {
    console.log(`[migrate] DRY RUN: Would drop collection and re-insert ${records.length} records`)
    console.log(`[migrate] Sample records:`)
    for (const r of records.slice(0, 3)) {
      console.log(`  - [${r.type}] ${r.id.slice(0, 8)}...`)
    }
    return
  }

  // Drop old collection
  console.log(`[migrate] Dropping old collection...`)
  await client.dropCollection({ collection_name: config.milvus.collection })

  // Initialize new collection with new schema
  console.log(`[migrate] Creating new collection with ${EMBEDDING_DIM}-dim vectors...`)
  await initMilvus(config)

  // Re-insert all records (this will generate new embeddings)
  console.log(`[migrate] Re-inserting records with new embeddings...`)
  let inserted = 0
  let failed = 0

  for (const record of records) {
    try {
      await insertRecord(record, config)
      inserted++
      process.stdout.write(`\r[migrate] Inserted ${inserted}/${records.length} (${failed} failed)`)
    } catch (e) {
      failed++
      console.error(`\n[migrate] Failed to insert ${record.id}:`, e)
    }
  }
  console.log()

  console.log(`[migrate] Migration complete!`)
  console.log(`[migrate] Inserted: ${inserted}, Failed: ${failed}`)
}

migrate().catch(e => {
  console.error('[migrate] Fatal error:', e)
  process.exit(1)
})
