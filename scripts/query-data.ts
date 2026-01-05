/**
 * Quick data collection script for improvement plan research
 */
import { initMilvus, queryRecords, countRecords } from '../src/lib/milvus.js'
import { loadConfig } from '../src/lib/config.js'
import { findGitRoot } from '../src/lib/context.js'

async function main() {
  const configRoot = findGitRoot(process.cwd()) ?? process.cwd()
  const config = loadConfig(configRoot)

  console.log('Initializing Milvus...')
  await initMilvus(config)

  // 1. Count total records
  const total = await countRecords({}, config)
  console.log(`\n=== Total Records: ${total} ===\n`)

  // 2. Generalized records
  const generalizedCount = await countRecords({ filter: 'generalized == true' }, config)
  console.log(`\n=== Generalized Records: ${generalizedCount} ===`)

  if (generalizedCount > 0) {
    const generalizedSamples = await queryRecords({
      filter: 'generalized == true',
      limit: 5,
      orderBy: 'timestamp_desc'
    }, config)
    console.log('Sample generalized records:')
    for (const r of generalizedSamples) {
      console.log(`  - [${r.type}] ${r.id.slice(0, 8)}... project=${r.project || 'none'}`)
      const content = JSON.stringify(r).slice(0, 200)
      console.log(`    content preview: ${content}...`)
    }
  }

  // 3. Global scope records
  const globalCount = await countRecords({ filter: 'scope == "global"' }, config)
  console.log(`\n=== Global Scope Records: ${globalCount} ===`)

  if (globalCount > 0) {
    const globalSamples = await queryRecords({
      filter: 'scope == "global"',
      limit: 10,
      orderBy: 'timestamp_desc'
    }, config)
    console.log('Sample global records:')
    for (const r of globalSamples) {
      console.log(`  - [${r.type}] ${r.id.slice(0, 8)}...`)
      switch(r.type) {
        case 'command':
          console.log(`    command: ${r.command}`)
          break
        case 'error':
          console.log(`    error: ${r.errorText?.slice(0, 100)}...`)
          console.log(`    resolution: ${r.resolution?.slice(0, 100)}...`)
          break
        case 'discovery':
          console.log(`    what: ${r.what}`)
          console.log(`    where: ${r.where}`)
          break
        case 'procedure':
          console.log(`    name: ${r.name}`)
          break
      }
    }
  }

  // 4. Deprecated records
  const deprecatedCount = await countRecords({ filter: 'deprecated == true' }, config)
  console.log(`\n=== Deprecated Records: ${deprecatedCount} ===`)

  // 5. Records by type
  console.log('\n=== Records by Type ===')
  for (const type of ['command', 'error', 'discovery', 'procedure']) {
    const count = await countRecords({ filter: `type == "${type}"` }, config)
    console.log(`  ${type}: ${count}`)
  }

  // 6. Check domain distribution for domain filter issue
  console.log('\n=== Domain Distribution (top 10) ===')
  const allRecords = await queryRecords({ limit: 5000 }, config)
  const domainCounts: Record<string, number> = {}
  for (const r of allRecords) {
    const domain = r.domain || 'empty'
    domainCounts[domain] = (domainCounts[domain] || 0) + 1
  }
  const sortedDomains = Object.entries(domainCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
  for (const [domain, count] of sortedDomains) {
    console.log(`  ${domain}: ${count}`)
  }

  // 7. Usage stats - check if failure tracking is working
  console.log('\n=== High Failure Records ===')
  const allWithFailures = await queryRecords({
    filter: 'failure_count > 0',
    limit: 10,
    orderBy: 'timestamp_desc'
  }, config)
  console.log(`Records with failures: ${allWithFailures.length}`)
  for (const r of allWithFailures.slice(0, 5)) {
    console.log(`  - [${r.type}] success=${r.successCount} failure=${r.failureCount} retrieval=${r.retrievalCount} usage=${r.usageCount}`)
  }

  console.log('\n=== Data collection complete ===')
}

main().catch(console.error)
