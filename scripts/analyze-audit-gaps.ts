/**
 * Analyze why audit-identified duplicates weren't caught by maintenance
 */

import { initLanceDB, closeLanceDB, getRecord, vectorSearchSimilar } from '../src/lib/lancedb.js'
import { DEFAULT_CONFIG } from '../src/lib/types.js'

const duplicateGroups = [
  // Same-type warnings that should have been caught
  { name: "Delegating tasks warnings", ids: ["31a2013c-2161-4c5d-be06-66c5b2b9d40b", "b0f6a4f9-c6c9-40db-83da-98ca27238ef0"] },
  { name: "WAYLAND_DISPLAY warnings", ids: ["f40f93f7-a71e-40ee-9e63-f8cd7615523c", "8442fc32-861f-4854-8406-4a23667392b0"] },
  // Cross-type duplicates
  { name: "MongoDB replica (proc+warn+err)", ids: ["0ab9b027-d11e-4f86-beb0-2a381ff7c611", "5d1733b7-d8ab-4768-803f-dc88f29b745d", "f4a736d2-b81a-4d38-836b-35b6f35f43bd"] },
  { name: "ComfyUI Docker discoveries", ids: ["cd2ea65b-dbf0-4754-9761-f865c83dd02e", "456805b9-f8f8-4363-bca5-0bf3d7044e2a"] },
]

async function main() {
  await initLanceDB(DEFAULT_CONFIG)

  for (const group of duplicateGroups) {
    console.log(`\n=== ${group.name} ===`)
    const records = await Promise.all(group.ids.map(id => getRecord(id, DEFAULT_CONFIG)))

    for (const r of records) {
      if (!r) {
        console.log(`  [NOT FOUND]`)
        continue
      }
      const idShort = r.id.slice(0, 8)
      console.log(`\n[${r.type}] ${idShort}... deprecated=${r.deprecated ?? false}`)
      if (r.type === 'warning') {
        const w = r as any
        console.log(`  avoid: ${w.avoid?.slice(0, 100)}...`)
      } else if (r.type === 'procedure') {
        const p = r as any
        console.log(`  name: ${p.name}`)
      } else if (r.type === 'error') {
        const e = r as any
        console.log(`  errorText: ${e.errorText?.slice(0, 100)}...`)
      } else if (r.type === 'discovery') {
        const d = r as any
        console.log(`  what: ${d.what?.slice(0, 100)}...`)
      }
    }

    // Check similarity between first two if both exist and have embeddings
    const first = records[0]
    const second = records[1]
    if (first?.embedding && second) {
      const results = await vectorSearchSimilar(first.embedding, {
        limit: 50,
        similarityThreshold: 0.3,
        includeDeprecated: true
      }, DEFAULT_CONFIG)
      const match = results.find(r => r.record.id === second.id)
      const firstShort = first.id.slice(0, 8)
      const secondShort = second.id.slice(0, 8)
      console.log(`\nSimilarity ${firstShort} -> ${secondShort}: ${match?.similarity?.toFixed(3) ?? 'NOT IN TOP 50'}`)
      console.log(`Same type: ${first.type === second.type}`)
      console.log(`Consolidation threshold: 0.88`)
    }
  }

  await closeLanceDB()
}

main().catch(err => {
  console.error('Error:', err)
  process.exit(1)
})
