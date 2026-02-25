#!/usr/bin/env npx tsx
/**
 * Refresh embeddings in-place using the latest buildEmbeddingInput.
 *
 * Usage:
 *   npx tsx scripts/refresh-embeddings.ts
 *   npx tsx scripts/refresh-embeddings.ts --dry-run
 */

import { embed, embedBatch } from '../src/lib/embed.js'
import { loadConfig } from '../src/lib/config.js'
import { findGitRoot } from '../src/lib/context.js'
import { buildEmbeddingInput, buildLanceRow, countRecords, initLanceDB, iterateRecords } from '../src/lib/lancedb.js'
import { ensureClient } from '../src/lib/lancedb-client.js'
import type { Config, MemoryRecord, RecordType } from '../src/lib/types.js'

const BATCH_SIZE = 100
const SAMPLE_LIMIT = 3
const VALID_TYPES = new Set<RecordType>(['command', 'error', 'discovery', 'procedure', 'warning'])

type Candidate = {
  record: MemoryRecord
  input: string
}

type Sample = {
  id: string
  type: RecordType
  preview: string
}

async function computeEmbeddings(
  candidates: Candidate[],
  config: Config
): Promise<Array<number[] | null>> {
  if (candidates.length === 0) return []
  const inputs = candidates.map(candidate => candidate.input)

  try {
    const embeddings = await embedBatch(inputs, config)
    if (embeddings.length !== candidates.length) {
      throw new Error(`Embedding count mismatch: expected ${candidates.length}, got ${embeddings.length}`)
    }
    return embeddings
  } catch (error) {
    console.error(`[refresh] Batch embedding failed (${candidates.length} items):`, error)
  }

  const results: Array<number[] | null> = []
  for (const candidate of candidates) {
    try {
      const embedding = await embed(candidate.input, config)
      results.push(embedding)
    } catch (error) {
      console.error(`[refresh] Embedding failed for ${candidate.record.id}:`, error)
      results.push(null)
    }
  }

  return results
}

async function refresh() {
  const dryRun = process.argv.includes('--dry-run')
  const configRoot = findGitRoot(process.cwd()) ?? process.cwd()
  const config = loadConfig(configRoot)

  console.log('[refresh] Starting embedding refresh...')
  console.log(`[refresh] LanceDB directory: ${config.lancedb.directory}`)
  console.log(`[refresh] Table: ${config.lancedb.table}`)
  console.log(`[refresh] Embedding model: ${config.embeddings.model}`)
  console.log(`[refresh] Batch size: ${BATCH_SIZE}`)
  if (dryRun) console.log('[refresh] DRY RUN - no changes will be made')

  await initLanceDB(config)
  const totalCount = await countRecords({}, config)
  console.log(`[refresh] Found ${totalCount} records to process`)

  if (totalCount === 0) {
    console.log('[refresh] No records to refresh.')
    return
  }

  const { table } = await ensureClient(config)

  let processed = 0
  let updated = 0
  let failed = 0
  const samples: Sample[] = []

  let candidates: Candidate[] = []

  const flushBatch = async (): Promise<void> => {
    if (candidates.length === 0) return

    if (dryRun) {
      updated += candidates.length
      candidates = []
      return
    }

    const embeddings = await computeEmbeddings(candidates, config)
    const rowsToUpsert: Array<Record<string, unknown>> = []

    for (let i = 0; i < candidates.length; i += 1) {
      const embedding = embeddings[i]
      if (!embedding) {
        failed += 1
        continue
      }

      const record = { ...candidates[i].record, embedding }
      try {
        const row = await buildLanceRow(record, config)
        rowsToUpsert.push(row)
      } catch (error) {
        failed += 1
        console.error(`[refresh] Failed to build row for id=${record.id}:`, error)
      }
    }

    if (rowsToUpsert.length > 0) {
      try {
        await table
          .mergeInsert('id')
          .whenMatchedUpdateAll()
          .whenNotMatchedInsertAll()
          .execute(rowsToUpsert)
        updated += rowsToUpsert.length
      } catch (error) {
        failed += rowsToUpsert.length
        console.error('[refresh] Failed to upsert batch:', error)
      }
    }

    candidates = []
  }

  for await (const record of iterateRecords({}, config)) {
    processed += 1

    if (!record.id || !record.type || !VALID_TYPES.has(record.type as RecordType)) {
      failed += 1
      continue
    }

    try {
      const input = buildEmbeddingInput(record)
      if (!input || input.trim().length === 0) {
        failed += 1
        continue
      }

      candidates.push({ record, input })

      if (dryRun && samples.length < SAMPLE_LIMIT) {
        const preview = input.replace(/\\s+/g, ' ').slice(0, 120)
        samples.push({ id: record.id, type: record.type as RecordType, preview })
      }
    } catch (error) {
      failed += 1
      console.error(`[refresh] Failed to build embedding input for id=${record.id}:`, error)
    }

    if (candidates.length >= BATCH_SIZE) {
      await flushBatch()
      process.stdout.write(
        `\\r[refresh] Processed ${processed}/${totalCount} | ${dryRun ? 'would update' : 'updated'} ${updated} | failed ${failed}`
      )
    }
  }

  await flushBatch()
  console.log()

  if (dryRun) {
    console.log('[refresh] DRY RUN complete.')
    console.log(`[refresh] Processed: ${processed}, Would update: ${updated}, Failed: ${failed}`)
    if (samples.length > 0) {
      console.log('[refresh] Sample updates:')
      for (const sample of samples) {
        console.log(`  - [${sample.type}] ${sample.id.slice(0, 8)}... ${sample.preview}...`)
      }
    }
    return
  }

  console.log('[refresh] Refresh complete!')
  console.log(`[refresh] Processed: ${processed}, Updated: ${updated}, Failed: ${failed}`)
}

refresh().catch(error => {
  console.error('[refresh] Fatal error:', error)
  process.exit(1)
})
