/**
 * Restore deprecated records based on a manually-curated decision file.
 *
 * Reads a JSON file with entries `{id, decision, reason}` where decision is
 * "RESTORE" or "KEEP_DEPRECATED". For each RESTORE entry, sets `deprecated`
 * to false on the live record. Preserves all metadata fields
 * (deprecatedAt, deprecatedReason, supersedingRecordId) as audit history.
 *
 * Usage: pnpm tsx scripts/restore-deprecated-records.ts <decisions.json> [--apply]
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { batchUpdateRecords, closeLanceDB, fetchRecordsByIds, initLanceDB } from '../src/lib/lancedb.js'
import { loadConfig } from '../src/lib/config.js'
import { DEFAULT_CONFIG } from '../src/lib/types.js'

interface Decision {
  id: string
  decision: 'RESTORE' | 'KEEP_DEPRECATED'
  reason?: string
}

async function main() {
  const args = process.argv.slice(2)
  const apply = args.includes('--apply')
  const decisionsPath = args.find(a => !a.startsWith('--'))
  if (!decisionsPath) {
    console.error('Usage: pnpm tsx scripts/restore-deprecated-records.ts <decisions.json> [--apply]')
    process.exit(1)
  }

  const config = (await loadConfig()) ?? DEFAULT_CONFIG

  const raw = await readFile(resolve(decisionsPath), 'utf-8')
  const decisions = JSON.parse(raw) as Decision[]

  const restoreIds = decisions.filter(d => d.decision === 'RESTORE').map(d => d.id)
  const keepIds = decisions.filter(d => d.decision === 'KEEP_DEPRECATED').map(d => d.id)
  console.error(`Mode: ${apply ? 'apply' : 'dry-run'}`)
  console.error(`Total decisions: ${decisions.length}`)
  console.error(`To restore: ${restoreIds.length}`)
  console.error(`To keep deprecated: ${keepIds.length}`)

  await initLanceDB(config)
  try {
    const records = await fetchRecordsByIds(restoreIds, config, { includeEmbeddings: true })
    console.error(`Fetched ${records.length} records (missing: ${restoreIds.length - records.length})`)

    const eligible = records.filter(r => r.deprecated === true)
    const alreadyActive = records.length - eligible.length
    if (alreadyActive > 0) {
      console.error(`Already active (skipped): ${alreadyActive}`)
    }

    const withEmbedding = eligible.filter(r => Array.isArray(r.embedding) && r.embedding.length > 0)
    const noEmbedding = eligible.length - withEmbedding.length
    if (noEmbedding > 0) {
      console.error(`Missing embeddings (skipped): ${noEmbedding}`)
    }

    for (const record of withEmbedding) {
      record.deprecated = false
    }

    if (!apply) {
      console.error(`\nDry-run: would restore ${withEmbedding.length} records`)
      console.error(`First 5:`)
      for (const r of withEmbedding.slice(0, 5)) {
        const text = (r as Record<string, unknown>).what
          ?? (r as Record<string, unknown>).name
          ?? '(no summary)'
        const summary = String(text).slice(0, 80)
        console.error(`  - ${r.id} [${r.type}] ${summary}`)
      }
      return
    }

    console.error(`\nApplying restoration to ${withEmbedding.length} records...`)
    const result = await batchUpdateRecords(withEmbedding, {}, config)
    console.error(`Updated: ${result.updated}, failed: ${result.failed}`)
  } finally {
    await closeLanceDB()
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
