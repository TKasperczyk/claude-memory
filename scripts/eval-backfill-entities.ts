#!/usr/bin/env npx tsx
/**
 * Backfill the `entities` field on eval-table records via LLM extraction.
 * Uses the extraction model in batches; results are cached to a JSONL so
 * reruns only process records that are still missing entities.
 *
 * Usage:
 *   npx tsx scripts/eval-backfill-entities.ts                # full backfill on cc_memories_eval
 *   npx tsx scripts/eval-backfill-entities.ts --limit 10     # smoke run
 *   npx tsx scripts/eval-backfill-entities.ts --dry-run      # extract one batch, print, no writes
 *   npx tsx scripts/eval-backfill-entities.ts --table my_eval
 *   npx tsx scripts/eval-backfill-entities.ts --model claude-sonnet-4-6
 */

import { normalizeEntities } from '../src/lib/entities.js'
import { batchUpdateRecords, countRecords, fetchRecordsByIds, initLanceDB, iterateRecords } from '../src/lib/lancedb.js'
import { serializeRecord } from '../src/lib/lancedb-records.js'
import { executeReview } from '../src/lib/review-framework.js'
import { loadSettings } from '../src/lib/settings.js'
import { buildExactText } from '../src/lib/shared.js'
import type { Config, MemoryRecord } from '../src/lib/types.js'
import {
  appendJsonLines,
  argNumber,
  argValue,
  buildEvalConfig,
  evalDataPath,
  hasFlag,
  loadProdConfig,
  readJsonLines
} from './eval-shared.js'

const LLM_BATCH_SIZE = 20
const SNIPPET_MAX_CHARS = 800
// buildLanceRow throws above CONTENT_MAX_LENGTH (16384); leave headroom.
const CONTENT_SIZE_MARGIN = 16_000
const CACHE_FILE = evalDataPath('entity-backfill.jsonl')

type CacheEntry = { id: string; entities: string[] }
type ExtractionPayload = { items: CacheEntry[] }

function buildBatchPrompt(records: MemoryRecord[]): string {
  const lines = records.map(record => {
    const text = buildExactText(record).replace(/\s+/g, ' ').slice(0, SNIPPET_MAX_CHARS)
    return `id: ${record.id}\ntype: ${record.type}\ntext: ${text}`
  })
  return `Extract entity anchors from each memory record below.

Entities are specific named things the knowledge is anchored to: file paths, hostnames/servers, service names, CLI tools, project/repo names. Lowercase, verbatim from the text where possible, max 8 per record. Never generic terms like "git", "server", "config", "error". Records with no specific entities get an empty array.

Records:

${lines.join('\n---\n')}`
}

function coerceExtractionPayload(raw: unknown): ExtractionPayload | null {
  if (!raw || typeof raw !== 'object') return null
  const items = (raw as Record<string, unknown>).items
  if (!Array.isArray(items)) return null
  const coerced: CacheEntry[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const id = (item as Record<string, unknown>).id
    if (typeof id !== 'string' || !id.trim()) continue
    coerced.push({ id: id.trim(), entities: normalizeEntities((item as Record<string, unknown>).entities) })
  }
  return { items: coerced }
}

async function extractBatch(records: MemoryRecord[], model: string, config: Config): Promise<Map<string, string[]>> {
  const result = await executeReview(records, {
    toolName: 'emit_entities',
    toolDescription: 'Submit extracted entity anchors for each memory record.',
    toolSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['items'],
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'entities'],
            properties: {
              id: { type: 'string' },
              entities: { type: 'array', items: { type: 'string' }, maxItems: 8 }
            }
          }
        }
      }
    },
    maxTokens: 4000,
    systemPrompt: 'You extract entity anchors from technical knowledge records. Respond only via the emit_entities tool.',
    buildPrompt: buildBatchPrompt,
    coercePayload: coerceExtractionPayload,
    model,
    authErrorMessage: 'Anthropic auth unavailable for entity backfill.'
  }, config)

  const byId = new Map<string, string[]>()
  for (const item of result.payload.items) {
    byId.set(item.id, item.entities)
  }
  return byId
}

async function backfill() {
  const dryRun = hasFlag('--dry-run')
  const limit = argNumber('--limit') ?? Number.POSITIVE_INFINITY
  const prodConfig = loadProdConfig()
  const evalConfig = buildEvalConfig(prodConfig)
  const model = argValue('--model') ?? loadSettings().extractionModel

  console.log(`[eval-backfill] Table: ${evalConfig.lancedb.table}`)
  console.log(`[eval-backfill] Model: ${model}`)
  if (dryRun) console.log('[eval-backfill] DRY RUN - one batch, no writes')

  await initLanceDB(evalConfig)
  const total = await countRecords({}, evalConfig)
  if (total === 0) {
    throw new Error(`Eval table '${evalConfig.lancedb.table}' is empty; run eval-clone-table first.`)
  }

  const cache = new Map<string, string[]>(
    readJsonLines<CacheEntry>(CACHE_FILE).map(entry => [entry.id, entry.entities])
  )
  console.log(`[eval-backfill] ${total} records in table, ${cache.size} cached extractions`)

  // Two-phase: collect candidate ids with a read-only scan FIRST, then fetch
  // and mutate by id. Writing during an offset-paged iteration shifts row
  // order under the scan — records get re-visited or skipped entirely.
  const candidateIds: string[] = []
  let scanned = 0
  let skipped = 0
  for await (const record of iterateRecords({ filter: 'deprecated = false' }, evalConfig)) {
    if (scanned >= limit) break
    scanned += 1
    if (Array.isArray(record.entities) && record.entities.length > 0) {
      skipped += 1
      continue
    }
    candidateIds.push(record.id)
  }
  console.log(`[eval-backfill] Candidates without entities: ${candidateIds.length}`)

  let updated = 0
  let oversize = 0
  let failedBatches = 0
  let pending: MemoryRecord[] = []

  const applyEntities = async (records: MemoryRecord[], entitiesById: Map<string, string[]>): Promise<void> => {
    const toWrite: MemoryRecord[] = []
    for (const record of records) {
      const entities = entitiesById.get(record.id) ?? []
      if (entities.length === 0) continue
      record.entities = entities
      if (serializeRecord(record).length > CONTENT_SIZE_MARGIN) {
        // Trim longest-first until the record fits, drop entities entirely if it never does.
        while (record.entities.length > 0 && serializeRecord(record).length > CONTENT_SIZE_MARGIN) {
          record.entities = [...record.entities].sort((a, b) => a.length - b.length).slice(0, record.entities.length - 1)
        }
        if (record.entities.length === 0) {
          delete record.entities
          oversize += 1
          continue
        }
      }
      toWrite.push(record)
    }
    if (toWrite.length === 0) return
    await batchUpdateRecords(toWrite, {}, evalConfig)
    updated += toWrite.length
  }

  const flush = async (): Promise<boolean> => {
    if (pending.length === 0) return true
    const batch = pending
    pending = []

    // Serve from cache where possible; only uncached records hit the LLM.
    const uncached = batch.filter(record => !cache.has(record.id))
    if (uncached.length > 0) {
      try {
        const extracted = await extractBatch(uncached, model, evalConfig)
        const newEntries: CacheEntry[] = uncached.map(record => ({
          id: record.id,
          entities: extracted.get(record.id) ?? []
        }))
        appendJsonLines(CACHE_FILE, newEntries)
        for (const entry of newEntries) cache.set(entry.id, entry.entities)
      } catch (error) {
        failedBatches += 1
        console.error(`\n[eval-backfill] Batch extraction failed (${uncached.length} records):`, error)
        return true
      }
    }

    const entitiesById = new Map(batch.map(record => [record.id, cache.get(record.id) ?? []]))
    if (dryRun) {
      console.log('\n[eval-backfill] Sample extractions:')
      for (const record of batch.slice(0, 10)) {
        const text = buildExactText(record).replace(/\s+/g, ' ').slice(0, 80)
        console.log(`  - [${record.type}] ${text}`)
        console.log(`    entities: ${JSON.stringify(entitiesById.get(record.id) ?? [])}`)
      }
      return false // dry run: stop after the first batch
    }

    await applyEntities(batch, entitiesById)
    process.stdout.write(`\r[eval-backfill] Updated ${updated}/${candidateIds.length} candidates | cached ${cache.size}`)
    return true
  }

  for (let offset = 0; offset < candidateIds.length; offset += LLM_BATCH_SIZE) {
    const ids = candidateIds.slice(offset, offset + LLM_BATCH_SIZE)
    // Fetch by id (order-independent) with embeddings so writes never re-embed.
    pending = await fetchRecordsByIds(ids, evalConfig, { includeEmbeddings: true })
    const shouldContinue = await flush()
    if (!shouldContinue) return
  }
  console.log()
  console.log(`[eval-backfill] Done. Scanned ${scanned}, updated ${updated}, already-had-entities ${skipped}, oversize-trimmed-away ${oversize}, failed batches ${failedBatches}`)
  if (failedBatches > 0) {
    console.log('[eval-backfill] Rerun to retry failed batches (successful extractions are cached).')
  }
}

backfill().catch(error => {
  console.error('[eval-backfill] Fatal error:', error)
  process.exit(1)
})
