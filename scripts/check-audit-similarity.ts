import { initMilvus, getRecord, vectorSearchSimilar, queryRecords, countRecords } from '../src/lib/milvus.js'
import { loadSettings } from '../src/lib/settings.js'
import { DEFAULT_CONFIG } from '../src/lib/types.js'

const duplicates = [
  ['1909d583', '1c98d3c5'],
  ['9ccca83a', '9d0e32de'],
  ['b08e856e', '7f3dcf65'],
  ['b57c5083', 'cd178514'],
  ['d795b047', 'a95bf6c8'],
  ['76a5ec97', '92ee98c0'],
  ['8caf68d7', 'f858a047'],
  ['ea3c7b99', '6f7355e2'],
  ['c51ed188', 'f605fac8'],
  ['e0d0bcbe', '640f0ec1'],
  ['f66f4340', 'a578a9a0'],
  ['8b53f476', '283f1b9d']
]

async function main() {
  await initMilvus()

  // First check database status
  const total = await countRecords({})
  console.log('Total records in database:', total)

  const sample = await queryRecords({ limit: 3 })
  console.log('Sample IDs:', sample.map(r => r.id).join(', '))
  console.log('')

  // Check if audit IDs are prefixes
  const firstAuditId = duplicates[0][0]
  const matchingRecords = await queryRecords({
    filter: `id like "${firstAuditId}%"`,
    limit: 5
  })
  console.log(`Records matching "${firstAuditId}%":`, matchingRecords.map(r => r.id))
  console.log('')

  const settings = loadSettings()
  console.log('Cross-type threshold:', settings.crossTypeConsolidationThreshold)
  console.log('Same-type threshold:', settings.consolidationThreshold)
  console.log('')

  for (const [id1, id2] of duplicates) {
    // Try exact match first
    let r1 = await getRecord(id1, DEFAULT_CONFIG, { includeEmbedding: true })
    let r2 = await getRecord(id2, DEFAULT_CONFIG, { includeEmbedding: true })

    // If not found, try prefix match
    if (!r1) {
      const matches = await queryRecords({ filter: `id like "${id1}%"`, limit: 1, includeEmbeddings: true })
      r1 = matches[0] ?? null
    }
    if (!r2) {
      const matches = await queryRecords({ filter: `id like "${id2}%"`, limit: 1, includeEmbeddings: true })
      r2 = matches[0] ?? null
    }

    if (!r1 || !r2) {
      console.log(`${id1} <-> ${id2}: MISSING (r1=${!!r1}, r2=${!!r2})`)
      continue
    }

    // Search from r1 to find r2
    const results = await vectorSearchSimilar(r1.embedding, { limit: 100 })
    const match = results.find(r => r.record.id === r2.id)
    const similarity = match ? match.similarity : 'NOT FOUND in top 100'

    const sameType = r1.type === r2.type
    const threshold = sameType ? settings.consolidationThreshold : settings.crossTypeConsolidationThreshold
    const wouldPass = typeof similarity === 'number' && similarity >= threshold

    console.log(`${r1.id} (${r1.type}${r1.deprecated ? ',DEP' : ''}) <-> ${r2.id} (${r2.type}${r2.deprecated ? ',DEP' : ''})`)
    console.log(`  Similarity: ${typeof similarity === 'number' ? similarity.toFixed(4) : similarity}`)
    console.log(`  Same type: ${sameType}, Threshold: ${threshold}, Would pass: ${wouldPass}`)
    console.log('')
  }
}

main()
