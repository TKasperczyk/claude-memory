/**
 * Test cross-domain retrieval behavior
 */
import { initMilvus, hybridSearch } from '../src/lib/milvus.js'
import { loadConfig } from '../src/lib/config.js'
import { findGitRoot, extractSignals } from '../src/lib/context.js'

async function main() {
  const configRoot = findGitRoot(process.cwd()) ?? process.cwd()
  const config = loadConfig(configRoot)

  console.log('Initializing Milvus...')
  await initMilvus(config)

  // Simulate being in this project (build-tools domain) but asking about docker
  const query1 = 'how to run docker container'
  const cwd1 = '/home/luthriel/Programming/claude-memory'
  const signals1 = extractSignals(query1, cwd1)

  console.log('\n=== Test 1: Docker query in claude-memory project ===')
  console.log(`Query: "${query1}"`)
  console.log(`CWD: ${cwd1}`)
  console.log(`Inferred domain: ${signals1.domain}`)
  console.log(`Inferred project: ${signals1.projectRoot}`)

  // Search with domain filter
  const results1 = await hybridSearch({
    query: query1,
    limit: 5,
    project: signals1.projectRoot,
    domain: signals1.domain
  }, config)

  console.log(`\nResults with domain filter (${results1.length}):`)
  for (const r of results1) {
    console.log(`  [${r.record.type}] score=${r.score.toFixed(3)} sim=${r.similarity.toFixed(3)} domain=${r.record.domain}`)
    console.log(`    ${JSON.stringify(r.record).slice(0, 100)}...`)
  }

  // Search without domain filter
  const results1b = await hybridSearch({
    query: query1,
    limit: 5,
    project: signals1.projectRoot
    // no domain filter
  }, config)

  console.log(`\nResults without domain filter (${results1b.length}):`)
  for (const r of results1b) {
    console.log(`  [${r.record.type}] score=${r.score.toFixed(3)} sim=${r.similarity.toFixed(3)} domain=${r.record.domain}`)
    console.log(`    ${JSON.stringify(r.record).slice(0, 100)}...`)
  }

  // Test 2: Query about milvus
  const query2 = 'milvus vector database embedding search'
  console.log('\n=== Test 2: Milvus query ===')
  console.log(`Query: "${query2}"`)

  const results2 = await hybridSearch({
    query: query2,
    limit: 5
  }, config)

  console.log(`\nResults (${results2.length}):`)
  for (const r of results2) {
    console.log(`  [${r.record.type}] score=${r.score.toFixed(3)} sim=${r.similarity.toFixed(3)} domain=${r.record.domain}`)
    console.log(`    ${JSON.stringify(r.record).slice(0, 100)}...`)
  }

  console.log('\n=== Domain filter test complete ===')
}

main().catch(console.error)
