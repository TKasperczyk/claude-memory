#!/usr/bin/env npx tsx
/**
 * Refresh embeddings in-place using the latest buildEmbeddingInput.
 *
 * Usage:
 *   npx tsx scripts/refresh-embeddings.ts
 *   npx tsx scripts/refresh-embeddings.ts --dry-run
 */

import { MilvusClient, type RowData } from '@zilliz/milvus2-sdk-node'
import { embed, embedBatch } from '../src/lib/embed.js'
import { loadConfig } from '../src/lib/config.js'
import { findGitRoot } from '../src/lib/context.js'
import { buildEmbeddingInput, buildMilvusRow } from '../src/lib/milvus.js'
import type { Config, MemoryRecord, RecordType } from '../src/lib/types.js'

const BATCH_SIZE = 100
const SAMPLE_LIMIT = 3
const POST_FLUSH_DELAY_MS = 500
const VALID_TYPES = new Set<RecordType>([
  'command',
  'error',
  'discovery',
  'procedure',
  'warning'
])

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
  console.log(`[refresh] Collection: ${config.milvus.collection}`)
  console.log(`[refresh] Address: ${config.milvus.address}`)
  console.log(`[refresh] Embedding model: ${config.embeddings.model}`)
  console.log(`[refresh] Batch size: ${BATCH_SIZE}`)
  if (dryRun) console.log('[refresh] DRY RUN - no changes will be made')

  const client = new MilvusClient({ address: config.milvus.address })
  await client.connect({})
  console.log(`[refresh] Connected to Milvus at ${config.milvus.address}`)

  const exists = await client.hasCollection({ collection_name: config.milvus.collection })
  if (!exists.value) {
    console.log('[refresh] Collection does not exist. Nothing to refresh.')
    return
  }

  await client.loadCollection({ collection_name: config.milvus.collection })

  const stats = await client.getCollectionStatistics({ collection_name: config.milvus.collection })
  const totalCount = parseInt(stats.data.row_count ?? '0', 10)
  console.log(`[refresh] Found ${totalCount} records to process`)

  if (totalCount === 0) {
    console.log('[refresh] No records to refresh.')
    return
  }

  let processed = 0
  let updated = 0
  let failed = 0
  let offset = 0
  const samples: Sample[] = []

  while (offset < totalCount) {
    const result = await client.query({
      collection_name: config.milvus.collection,
      filter: 'id != ""',
      output_fields: ['id', 'type', 'content'],
      limit: BATCH_SIZE,
      offset
    })

    const rows = result.data ?? []
    if (rows.length === 0) break

    const candidates: Candidate[] = []

    for (const row of rows) {
      processed += 1
      const rowId = typeof row.id === 'string' ? row.id : 'unknown'

      if (typeof row.content !== 'string') {
        failed += 1
        console.error(`[refresh] Missing content for id=${rowId}`)
        continue
      }

      let parsed: Partial<MemoryRecord>
      try {
        parsed = JSON.parse(row.content) as Partial<MemoryRecord>
      } catch (error) {
        failed += 1
        console.error(`[refresh] Failed to parse record ${rowId}:`, error)
        continue
      }

      const recordId = typeof row.id === 'string' ? row.id : parsed.id
      const recordType = typeof row.type === 'string' ? row.type : parsed.type

      if (!recordId || !recordType || !VALID_TYPES.has(recordType as RecordType)) {
        failed += 1
        console.error(`[refresh] Invalid record type for id=${rowId}: ${String(recordType)}`)
        continue
      }

      const record = { ...parsed, id: recordId, type: recordType } as MemoryRecord

      try {
        const input = buildEmbeddingInput(record)
        if (!input || input.trim().length === 0) {
          failed += 1
          console.error(`[refresh] Empty embedding input for id=${recordId}`)
          continue
        }
        candidates.push({ record, input })

        if (dryRun && samples.length < SAMPLE_LIMIT) {
          const preview = input.replace(/\s+/g, ' ').slice(0, 120)
          samples.push({ id: recordId, type: recordType as RecordType, preview })
        }
      } catch (error) {
        failed += 1
        console.error(`[refresh] Failed to build embedding input for id=${recordId}:`, error)
      }
    }

    if (dryRun) {
      updated += candidates.length
      offset += BATCH_SIZE
      process.stdout.write(`\r[refresh] Processed ${processed}/${totalCount} | would update ${updated} | failed ${failed}`)
      continue
    }

    const embeddings = await computeEmbeddings(candidates, config)
    const rowsToUpsert: RowData[] = []

    for (let i = 0; i < candidates.length; i += 1) {
      const embedding = embeddings[i]
      if (!embedding) {
        failed += 1
        continue
      }

      const record = { ...candidates[i].record, embedding }
      try {
        const row = await buildMilvusRow(record, config)
        rowsToUpsert.push(row)
      } catch (error) {
        failed += 1
        console.error(`[refresh] Failed to build row for id=${record.id}:`, error)
      }
    }

    if (rowsToUpsert.length > 0) {
      try {
        await client.upsert({
          collection_name: config.milvus.collection,
          data: rowsToUpsert
        })
        updated += rowsToUpsert.length
      } catch (error) {
        failed += rowsToUpsert.length
        console.error(`[refresh] Failed to upsert batch at offset ${offset}:`, error)
      }
    }

    offset += BATCH_SIZE
    process.stdout.write(`\r[refresh] Processed ${processed}/${totalCount} | updated ${updated} | failed ${failed}`)
  }

  console.log()

  if (dryRun) {
    console.log(`[refresh] DRY RUN complete.`)
    console.log(`[refresh] Processed: ${processed}, Would update: ${updated}, Failed: ${failed}`)
    if (samples.length > 0) {
      console.log('[refresh] Sample updates:')
      for (const sample of samples) {
        console.log(`  - [${sample.type}] ${sample.id.slice(0, 8)}... ${sample.preview}...`)
      }
    }
    return
  }

  if (updated > 0) {
    try {
      await client.flush({ collection_names: [config.milvus.collection] })
      await new Promise(resolve => setTimeout(resolve, POST_FLUSH_DELAY_MS))
    } catch (error) {
      console.error('[refresh] Flush failed:', error)
    }
  }

  console.log('[refresh] Refresh complete!')
  console.log(`[refresh] Processed: ${processed}, Updated: ${updated}, Failed: ${failed}`)
}

refresh().catch(error => {
  console.error('[refresh] Fatal error:', error)
  process.exit(1)
})
