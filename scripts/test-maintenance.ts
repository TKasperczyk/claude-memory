/**
 * Test maintenance operations in dry-run mode
 */
import { initMilvus, queryRecords } from '../src/lib/milvus.js'
import { loadConfig } from '../src/lib/config.js'
import { findGitRoot } from '../src/lib/context.js'
import {
  findContradictionPairs,
  findGlobalCandidates,
  checkGlobalPromotion,
  checkContradiction,
  type ContradictionPair
} from '../src/lib/maintenance.js'
import { buildExactText } from '../src/lib/shared.js'

async function main() {
  const configRoot = findGitRoot(process.cwd()) ?? process.cwd()
  const config = loadConfig(configRoot)

  console.log('Initializing Milvus...')
  await initMilvus(config)

  // 1. Find contradiction pairs
  console.log('\n=== Contradiction Detection (dry-run) ===')
  const pairs = await findContradictionPairs(config)
  console.log(`Found ${pairs.length} potential contradiction pairs`)

  for (const pair of pairs.slice(0, 5)) {
    console.log(`\nPair (similarity: ${pair.similarity.toFixed(3)}):`)
    console.log(`  NEWER [${pair.newer.type}] ${pair.newer.id.slice(0, 8)}...`)
    console.log(`    ${buildExactText(pair.newer).slice(0, 150)}...`)
    console.log(`  OLDER [${pair.older.type}] ${pair.older.id.slice(0, 8)}...`)
    console.log(`    ${buildExactText(pair.older).slice(0, 150)}...`)

    // Check what LLM would say (limit to first 2 to save API costs)
    if (pairs.indexOf(pair) < 2) {
      try {
        console.log('  Checking with LLM...')
        const result = await checkContradiction(pair, config)
        console.log(`  LLM verdict: ${result.verdict}`)
        console.log(`  Reason: ${result.reason}`)
      } catch (err) {
        console.log(`  LLM check failed: ${err}`)
      }
    }
  }

  // 2. Find global promotion candidates
  console.log('\n=== Global Promotion Candidates ===')
  const globalCandidates = await findGlobalCandidates(config)
  console.log(`Found ${globalCandidates.length} global candidates (heuristic-based)`)

  for (const r of globalCandidates.slice(0, 10)) {
    console.log(`\n  [${r.type}] ${r.id.slice(0, 8)}... project=${r.project}`)
    switch (r.type) {
      case 'command':
        console.log(`    command: ${r.command}`)
        break
      case 'error':
        console.log(`    error: ${r.errorText?.slice(0, 80)}...`)
        break
      case 'discovery':
        console.log(`    what: ${r.what?.slice(0, 80)}...`)
        break
    }

    // Check LLM opinion for first few
    if (globalCandidates.indexOf(r) < 3) {
      try {
        console.log('    Checking with LLM...')
        const result = await checkGlobalPromotion(r, config)
        console.log(`    LLM: shouldPromote=${result.shouldPromote}, confidence=${result.confidence}`)
        console.log(`    Reason: ${result.reason}`)
      } catch (err) {
        console.log(`    LLM check failed: ${err}`)
      }
    }
  }

  // 3. Look at deprecated records to understand why they were deprecated
  console.log('\n=== Deprecated Records Analysis ===')
  const deprecated = await queryRecords({
    filter: 'deprecated == true',
    limit: 20,
    orderBy: 'timestamp_desc'
  }, config)

  console.log(`Found ${deprecated.length} deprecated records`)
  for (const r of deprecated.slice(0, 8)) {
    console.log(`  - [${r.type}] ${r.id.slice(0, 8)}... success=${r.successCount} failure=${r.failureCount}`)
    console.log(`    ${buildExactText(r).slice(0, 100)}...`)
  }

  console.log('\n=== Test complete ===')
}

main().catch(console.error)
