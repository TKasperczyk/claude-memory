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

import { connect } from '@lancedb/lancedb'
import { EMBEDDING_DIM, type MemoryRecord } from '../src/lib/types.js'
import { loadConfig } from '../src/lib/config.js'
import { findGitRoot } from '../src/lib/context.js'
import { closeLanceDB, initLanceDB, insertRecord, iterateRecords } from '../src/lib/lancedb.js'
import { resolveDirectory } from '../src/lib/lancedb-client.js'

async function migrate() {
  const dryRun = process.argv.includes('--dry-run')
  const configRoot = findGitRoot(process.cwd()) ?? process.cwd()
  const config = loadConfig(configRoot)

  console.log(`[migrate] Starting migration...`)
  console.log(`[migrate] LanceDB directory: ${config.lancedb.directory}`)
  console.log(`[migrate] Table: ${config.lancedb.table}`)
  console.log(`[migrate] New embedding dim: ${EMBEDDING_DIM}`)
  console.log(`[migrate] Embedding model: ${config.embeddings.model}`)
  if (dryRun) console.log(`[migrate] DRY RUN - no changes will be made`)

  console.log(`[migrate] Exporting records...`)
  const records: MemoryRecord[] = []
  let exported = 0
  for await (const record of iterateRecords({}, config)) {
    const copy = { ...record } as MemoryRecord
    delete copy.embedding
    records.push(copy)
    exported += 1
    if (exported % 250 === 0) {
      process.stdout.write(`\r[migrate] Exported ${exported}`)
    }
  }
  if (exported >= 250) console.log()
  console.log(`[migrate] Exported ${records.length} records`)

  if (dryRun) {
    console.log(`[migrate] DRY RUN: Would drop table and re-insert ${records.length} records`)
    console.log(`[migrate] Sample records:`)
    for (const r of records.slice(0, 3)) {
      console.log(`  - [${r.type}] ${r.id.slice(0, 8)}...`)
    }
    return
  }

  // Drop old table (close any cached handles first)
  console.log(`[migrate] Dropping old table...`)
  await closeLanceDB()
  const directory = resolveDirectory(config.lancedb.directory)
  const tableName = config.lancedb.table
  const conn = await connect(directory)
  const names = await conn.tableNames()
  if (names.includes(tableName)) {
    await conn.dropTable(tableName)
  }
  try {
    conn.close()
  } catch {
    // ignore
  }

  // Initialize new table with schema
  console.log(`[migrate] Creating new table with ${EMBEDDING_DIM}-dim vectors...`)
  await initLanceDB(config)

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
