#!/usr/bin/env tsx
/**
 * One-time migration: read all records from a running Milvus instance via REST API
 * and insert them into LanceDB. No Milvus SDK needed — uses HTTP only.
 *
 * Usage:
 *   pnpm tsx scripts/migrate-from-milvus.ts [--milvus-url http://localhost:19530] [--collection cc_memories] [--dry-run]
 */

import { initLanceDB, closeLanceDB } from '../src/lib/lancedb-client.js'
import { ensureClient } from '../src/lib/lancedb-client.js'
import { buildLanceRow, parseRecordFromRow } from '../src/lib/lancedb-records.js'
import { DEFAULT_CONFIG, type Config, type MemoryRecord } from '../src/lib/types.js'

const MILVUS_REST_URL = process.argv.includes('--milvus-url')
  ? process.argv[process.argv.indexOf('--milvus-url') + 1]
  : 'http://localhost:19530'

const COLLECTION = process.argv.includes('--collection')
  ? process.argv[process.argv.indexOf('--collection') + 1]
  : 'cc_memories'

const DRY_RUN = process.argv.includes('--dry-run')
const BATCH_SIZE = 100

// All scalar fields we need from Milvus rows
const OUTPUT_FIELDS = [
  'id', 'type', 'content', 'exact_text', 'project', 'scope',
  'timestamp', 'success_count', 'failure_count', 'retrieval_count',
  'usage_count', 'last_used', 'deprecated', 'generalized',
  'last_generalization_check', 'last_global_check', 'last_consolidation_check',
  'last_conflict_check', 'last_warning_synthesis_check',
  'source_session_id', 'source_excerpt', 'embedding'
]

interface MilvusQueryResponse {
  code: number
  message?: string
  data: Array<Record<string, unknown>>
}

async function milvusQuery(filter: string, limit: number, offset: number): Promise<MilvusQueryResponse> {
  const response = await fetch(`${MILVUS_REST_URL}/v2/vectordb/entities/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      collectionName: COLLECTION,
      filter,
      limit,
      offset,
      outputFields: OUTPUT_FIELDS
    })
  })
  return response.json() as Promise<MilvusQueryResponse>
}

async function milvusCount(): Promise<number> {
  const response = await fetch(`${MILVUS_REST_URL}/v2/vectordb/entities/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      collectionName: COLLECTION,
      filter: 'timestamp > 0',
      limit: 0,
      outputFields: ['count(*)']
    })
  })
  const data = await response.json() as MilvusQueryResponse
  if (data.code !== 0) throw new Error(`Milvus count failed: ${data.message}`)
  return (data.data[0] as Record<string, number>)['count(*)']
}

function milvusRowToRecord(row: Record<string, unknown>): MemoryRecord | null {
  // parseRecordFromRow handles the conversion from snake_case DB columns to camelCase record fields
  return parseRecordFromRow(row)
}

async function main() {
  console.log(`Migration: Milvus (${MILVUS_REST_URL}) → LanceDB`)
  console.log(`Collection: ${COLLECTION}`)
  console.log(`LanceDB dir: ${DEFAULT_CONFIG.lancedb.directory}`)
  console.log(`LanceDB table: ${DEFAULT_CONFIG.lancedb.table}`)
  if (DRY_RUN) console.log('DRY RUN — no data will be written')
  console.log()

  // Check Milvus is reachable
  let totalRecords: number
  try {
    totalRecords = await milvusCount()
  } catch (error) {
    console.error('Failed to connect to Milvus. Is it running?', error)
    process.exit(1)
  }
  console.log(`Found ${totalRecords} records in Milvus collection "${COLLECTION}"`)

  if (totalRecords === 0) {
    console.log('Nothing to migrate.')
    return
  }

  // Initialize LanceDB
  if (!DRY_RUN) {
    await initLanceDB(DEFAULT_CONFIG)
    console.log('LanceDB initialized')
  }

  let migrated = 0
  let skipped = 0
  let failed = 0
  let offset = 0

  while (offset < totalRecords) {
    const batchLimit = Math.min(BATCH_SIZE, totalRecords - offset)
    process.stdout.write(`\rFetching batch ${Math.floor(offset / BATCH_SIZE) + 1} (offset ${offset})...`)

    const result = await milvusQuery('timestamp > 0', batchLimit, offset)
    if (result.code !== 0) {
      console.error(`\nMilvus query failed at offset ${offset}: ${result.message}`)
      break
    }

    if (result.data.length === 0) {
      console.log('\nNo more records returned.')
      break
    }

    const rows: Array<Record<string, unknown>> = []
    for (const milvusRow of result.data) {
      const record = milvusRowToRecord(milvusRow)
      if (!record) {
        skipped++
        continue
      }

      // Record already has its embedding from Milvus — no need to re-embed
      if (!record.embedding || !Array.isArray(record.embedding) || record.embedding.length === 0) {
        console.warn(`\n  Warning: record ${record.id} has no embedding, skipping`)
        skipped++
        continue
      }

      try {
        const lanceRow = await buildLanceRow(record, DEFAULT_CONFIG)
        rows.push(lanceRow)
      } catch (error) {
        console.error(`\n  Failed to build LanceDB row for ${record.id}:`, error)
        failed++
      }
    }

    if (!DRY_RUN && rows.length > 0) {
      try {
        const { table } = await ensureClient(DEFAULT_CONFIG)
        await table.add(rows)
        migrated += rows.length
      } catch (error) {
        console.error(`\n  Failed to insert batch at offset ${offset}:`, error)
        failed += rows.length
      }
    } else {
      migrated += rows.length
    }

    offset += result.data.length
  }

  process.stdout.write('\r' + ' '.repeat(60) + '\r')
  console.log(`\nMigration complete:`)
  console.log(`  Migrated: ${migrated}`)
  console.log(`  Skipped:  ${skipped}`)
  console.log(`  Failed:   ${failed}`)
  console.log(`  Total:    ${migrated + skipped + failed}`)

  if (!DRY_RUN) {
    await closeLanceDB()
  }
}

main().catch(error => {
  console.error('Migration failed:', error)
  process.exit(1)
})
