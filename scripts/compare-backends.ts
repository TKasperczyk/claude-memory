#!/usr/bin/env tsx
import fs from 'node:fs'

/**
 * Backend comparison harness: captures retrieval, search, and maintenance behavior
 * from both Milvus and LanceDB backends, then compares results.
 *
 * Usage:
 *   # Capture from LanceDB (current code)
 *   pnpm tsx scripts/compare-backends.ts capture > /tmp/lancedb-results.json
 *
 *   # Capture from Milvus (old code in worktree)
 *   cd /tmp/claude-memory-milvus && pnpm tsx scripts/compare-backends.ts capture > /tmp/milvus-results.json
 *
 *   # Compare results
 *   pnpm tsx scripts/compare-backends.ts compare /tmp/milvus-results.json /tmp/lancedb-results.json
 */

// -------------- Types --------------

interface CaptureResults {
  backend: string
  timestamp: string
  recordIntegrity: RecordIntegrityResult
  retrieval: RetrievalTestResult[]
  hybridSearch: HybridSearchTestResult[]
  maintenance: MaintenanceTestResult[]
}

interface RecordIntegrityResult {
  totalCount: number
  byType: Record<string, number>
  byScope: Record<string, number>
  deprecatedCount: number
  sampleRecords: SampleRecord[]
}

interface SampleRecord {
  id: string
  type: string
  scope: string
  project: string
  timestamp: number
  hasEmbedding: boolean
  contentLength: number
  successCount: number
  failureCount: number
  retrievalCount: number
  usageCount: number
}

interface HybridSearchTestResult {
  query: string
  project: string
  resultCount: number
  results: Array<{
    id: string
    type: string
    similarity: number
    score: number
    keywordMatch: boolean
  }>
  nearMissCount?: number
}

interface RetrievalTestResult {
  prompt: string
  project: string
  injectedCount: number
  injectedIds: string[]
  timedOut: boolean
}

interface MaintenanceTestResult {
  operation: string
  candidateCount: number
  actionCount: number
  summary: Record<string, unknown>
  actions: Array<{
    type: string
    recordId?: string
    description?: string
  }>
  error?: string
}

// -------------- Capture Logic --------------

async function capture(): Promise<CaptureResults> {
  // Dynamic imports — works from either worktree
  const { initMilvus, closeMilvus, countRecords, queryRecords, hybridSearch, getRecord } =
    await import('../src/lib/milvus.js')
  const { retrieveContext } = await import('../src/lib/retrieval.js')
  const { runAllMaintenance } = await import('../src/lib/maintenance-api.js')
  const { DEFAULT_CONFIG } = await import('../src/lib/types.js')

  // Detect backend
  let backend = 'unknown'
  try {
    await import('../src/lib/lancedb-client.js')
    backend = 'lancedb'
  } catch {
    backend = 'milvus'
  }

  console.error(`[compare] Capturing from ${backend} backend...`)

  await initMilvus(DEFAULT_CONFIG)

  // --- Record Integrity ---
  console.error('[compare] Checking record integrity...')
  const totalCount = await countRecords({}, DEFAULT_CONFIG)

  const allRecords = await queryRecords({ limit: 10000 }, DEFAULT_CONFIG)

  const byType: Record<string, number> = {}
  const byScope: Record<string, number> = {}
  let deprecatedCount = 0
  for (const r of allRecords) {
    byType[r.type] = (byType[r.type] ?? 0) + 1
    byScope[r.scope] = (byScope[r.scope] ?? 0) + 1
    if (r.deprecated) deprecatedCount++
  }

  // Sample 20 records spread across the collection for field-level comparison
  const sampleIndices = Array.from({ length: 20 }, (_, i) => Math.floor(i * allRecords.length / 20))
  const sampleRecords: SampleRecord[] = []
  for (const idx of sampleIndices) {
    const r = allRecords[idx]
    if (!r) continue
    const full = await getRecord(r.id, DEFAULT_CONFIG, { includeEmbedding: true })
    sampleRecords.push({
      id: r.id,
      type: r.type,
      scope: r.scope,
      project: r.project ?? '',
      timestamp: r.timestamp,
      hasEmbedding: Boolean(full?.embedding?.length),
      contentLength: JSON.stringify(r).length,
      successCount: r.successCount ?? 0,
      failureCount: r.failureCount ?? 0,
      retrievalCount: r.retrievalCount ?? 0,
      usageCount: r.usageCount ?? 0,
    })
  }

  const recordIntegrity: RecordIntegrityResult = {
    totalCount,
    byType,
    byScope,
    deprecatedCount,
    sampleRecords,
  }

  // --- Hybrid Search ---
  console.error('[compare] Running hybrid search tests...')
  const searchQueries = [
    { query: 'docker container build error', project: '/home/luthriel/Programming/claude-memory' },
    { query: 'embedding model dimension mismatch', project: '/home/luthriel/Programming/claude-memory' },
    { query: 'Milvus flush sync delay', project: '/home/luthriel/Programming/claude-memory' },
    { query: 'pnpm build typescript compilation', project: '/home/luthriel/Programming/claude-memory' },
    { query: 'git commit hook verification', project: '/home/luthriel/Programming/claude-memory' },
    { query: 'API rate limit retry', project: '/home/luthriel' },
    { query: 'SSH connection timeout', project: '/home/luthriel' },
    { query: 'memory extraction deduplication', project: '/home/luthriel/Programming/claude-memory' },
    { query: 'dashboard react component rendering', project: '/home/luthriel/Programming/claude-memory' },
    { query: 'maintenance consolidation stale records', project: '/home/luthriel/Programming/claude-memory' },
    { query: 'Azure Active Directory authentication', project: '/home/luthriel' },
    { query: 'systemd service restart failure', project: '/home/luthriel' },
    { query: 'nginx reverse proxy configuration', project: '/home/luthriel' },
    { query: 'PostgreSQL query optimization index', project: '/home/luthriel' },
    { query: 'Claude Code hooks pre-prompt injection', project: '/home/luthriel/Programming/claude-memory' },
  ]

  const hybridSearchResults: HybridSearchTestResult[] = []
  for (const sq of searchQueries) {
    try {
      const results = await hybridSearch({
        query: sq.query,
        project: sq.project,
        includeGlobal: true,
        limit: 10,
        diagnostic: true,
      } as any, DEFAULT_CONFIG) as any

      const qualified = results.qualified ?? results
      const nearMisses = results.nearMisses ?? []

      hybridSearchResults.push({
        query: sq.query,
        project: sq.project,
        resultCount: qualified.length,
        results: qualified.map((r: any) => ({
          id: r.record.id,
          type: r.record.type,
          similarity: Math.round(r.similarity * 10000) / 10000,
          score: Math.round(r.score * 10000) / 10000,
          keywordMatch: r.keywordMatch,
        })),
        nearMissCount: nearMisses.length,
      })
    } catch (error) {
      console.error(`[compare] Search failed for "${sq.query}":`, error)
      hybridSearchResults.push({
        query: sq.query,
        project: sq.project,
        resultCount: -1,
        results: [],
      })
    }
  }

  // --- Retrieval (pre-prompt simulation) ---
  console.error('[compare] Running retrieval tests...')
  const retrievalPrompts = [
    { prompt: 'I need to fix the docker build', project: '/home/luthriel/Programming/claude-memory' },
    { prompt: 'How do I run the tests?', project: '/home/luthriel/Programming/claude-memory' },
    { prompt: 'The embedding API is returning wrong dimensions', project: '/home/luthriel/Programming/claude-memory' },
    { prompt: 'Deploy the app to production', project: '/home/luthriel' },
    { prompt: 'Check the Milvus collection status', project: '/home/luthriel/Programming/claude-memory' },
    { prompt: 'Fix the SSH key permission issue on the server', project: '/home/luthriel' },
    { prompt: 'Add a new maintenance runner for record cleanup', project: '/home/luthriel/Programming/claude-memory' },
    { prompt: 'The dashboard is showing wrong statistics', project: '/home/luthriel/Programming/claude-memory' },
  ]

  const retrievalResults: RetrievalTestResult[] = []
  for (const rp of retrievalPrompts) {
    try {
      const result = await retrieveContext(
        { prompt: rp.prompt, cwd: rp.project },
        DEFAULT_CONFIG,
        { projectRoot: rp.project }
      )
      retrievalResults.push({
        prompt: rp.prompt,
        project: rp.project,
        injectedCount: result.injectedRecords?.length ?? 0,
        injectedIds: (result.injectedRecords ?? []).map((r: any) => r.id),
        timedOut: result.timedOut ?? false,
      })
    } catch (error) {
      console.error(`[compare] Retrieval failed for "${rp.prompt}":`, error)
      retrievalResults.push({
        prompt: rp.prompt,
        project: rp.project,
        injectedCount: -1,
        injectedIds: [],
        timedOut: false,
      })
    }
  }

  // --- Maintenance Dry Run ---
  console.error('[compare] Running maintenance dry run...')
  let maintenanceResults: MaintenanceTestResult[] = []
  try {
    const opResults = await runAllMaintenance(true, DEFAULT_CONFIG)
    maintenanceResults = opResults.map((r: any) => ({
      operation: r.operation,
      candidateCount: r.candidates?.length ?? 0,
      actionCount: r.actions?.length ?? 0,
      summary: r.summary ?? {},
      actions: (r.actions ?? []).slice(0, 50).map((a: any) => ({
        type: a.type ?? a.action ?? 'unknown',
        recordId: a.recordId ?? a.id,
        description: a.description ?? a.reason ?? a.summary,
      })),
      error: r.error,
    }))
  } catch (error) {
    console.error('[compare] Maintenance failed:', error)
    maintenanceResults = [{ operation: 'ALL', candidateCount: -1, actionCount: -1, summary: {}, actions: [], error: String(error) }]
  }

  await closeMilvus()

  return {
    backend,
    timestamp: new Date().toISOString(),
    recordIntegrity,
    retrieval: retrievalResults,
    hybridSearch: hybridSearchResults,
    maintenance: maintenanceResults,
  }
}

// -------------- Compare Logic --------------

function compare(milvusPath: string, lancedbPath: string): void {
  const milvus: CaptureResults = JSON.parse(fs.readFileSync(milvusPath, 'utf-8'))
  const lancedb: CaptureResults = JSON.parse(fs.readFileSync(lancedbPath, 'utf-8'))

  const c = {
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
    dim: '\x1b[2m',
    bold: '\x1b[1m',
    reset: '\x1b[0m',
  }

  let issues = 0
  let warnings = 0

  function pass(msg: string): void {
    console.log(`  ${c.green}✓${c.reset} ${msg}`)
  }
  function warn(msg: string): void {
    warnings++
    console.log(`  ${c.yellow}⚠${c.reset} ${msg}`)
  }
  function fail(msg: string): void {
    issues++
    console.log(`  ${c.red}✗${c.reset} ${msg}`)
  }
  function header(msg: string): void {
    console.log(`\n${c.bold}${c.cyan}═══ ${msg} ═══${c.reset}`)
  }

  // --- Record Integrity ---
  header('RECORD INTEGRITY')

  const mi = milvus.recordIntegrity
  const li = lancedb.recordIntegrity

  if (mi.totalCount === li.totalCount) {
    pass(`Total count matches: ${mi.totalCount}`)
  } else {
    fail(`Total count mismatch: Milvus=${mi.totalCount} LanceDB=${li.totalCount}`)
  }

  const allTypes = new Set([...Object.keys(mi.byType), ...Object.keys(li.byType)])
  for (const type of allTypes) {
    const mv = mi.byType[type] ?? 0
    const lv = li.byType[type] ?? 0
    if (mv === lv) {
      pass(`Type "${type}": ${mv}`)
    } else {
      fail(`Type "${type}": Milvus=${mv} LanceDB=${lv}`)
    }
  }

  if (mi.deprecatedCount === li.deprecatedCount) {
    pass(`Deprecated count matches: ${mi.deprecatedCount}`)
  } else {
    fail(`Deprecated count mismatch: Milvus=${mi.deprecatedCount} LanceDB=${li.deprecatedCount}`)
  }

  // Compare sample records field by field
  let sampleMatches = 0
  let sampleMismatches = 0
  for (const mSample of mi.sampleRecords) {
    const lSample = li.sampleRecords.find(s => s.id === mSample.id)
    if (!lSample) {
      fail(`Sample record ${mSample.id.slice(0, 8)} missing in LanceDB`)
      sampleMismatches++
      continue
    }
    const fields: (keyof SampleRecord)[] = ['type', 'scope', 'project', 'timestamp', 'hasEmbedding', 'successCount', 'failureCount', 'retrievalCount', 'usageCount']
    let match = true
    for (const field of fields) {
      if (mSample[field] !== lSample[field]) {
        fail(`Sample ${mSample.id.slice(0, 8)} field "${field}": Milvus=${mSample[field]} LanceDB=${lSample[field]}`)
        match = false
      }
    }
    if (match) sampleMatches++
    else sampleMismatches++
  }
  if (sampleMismatches === 0) {
    pass(`All ${sampleMatches} sample records match field-by-field`)
  }

  // --- Hybrid Search ---
  header('HYBRID SEARCH')

  for (let i = 0; i < milvus.hybridSearch.length; i++) {
    const mq = milvus.hybridSearch[i]
    const lq = lancedb.hybridSearch[i]
    if (!lq) { fail(`Missing LanceDB result for query "${mq.query}"`); continue }

    const mIds = new Set(mq.results.map(r => r.id))
    const lIds = new Set(lq.results.map(r => r.id))
    const overlap = [...mIds].filter(id => lIds.has(id))
    const overlapPct = mIds.size > 0 ? Math.round(overlap.length / mIds.size * 100) : (lIds.size === 0 ? 100 : 0)

    const queryLabel = `"${mq.query.slice(0, 40)}"`

    if (overlapPct === 100 && mq.resultCount === lq.resultCount) {
      // Check ranking order
      const mOrder = mq.results.map(r => r.id)
      const lOrder = lq.results.map(r => r.id)
      const sameOrder = mOrder.every((id, idx) => lOrder[idx] === id)
      if (sameOrder) {
        pass(`${queryLabel}: ${mq.resultCount} results, identical order`)
      } else {
        warn(`${queryLabel}: ${mq.resultCount} results, same set but different order`)
      }
    } else if (overlapPct >= 70) {
      warn(`${queryLabel}: ${overlapPct}% overlap (M=${mq.resultCount} L=${lq.resultCount})`)
    } else if (mq.resultCount === 0 && lq.resultCount === 0) {
      pass(`${queryLabel}: both returned 0 results`)
    } else {
      warn(`${queryLabel}: ${overlapPct}% overlap (M=${mq.resultCount} L=${lq.resultCount})`)
    }

    // Compare similarity scores for overlapping results
    for (const mResult of mq.results) {
      const lResult = lq.results.find(r => r.id === mResult.id)
      if (!lResult) continue
      const simDiff = Math.abs(mResult.similarity - lResult.similarity)
      if (simDiff > 0.05) {
        warn(`  ${mResult.id.slice(0, 8)}: similarity drift ${mResult.similarity.toFixed(4)} → ${lResult.similarity.toFixed(4)} (Δ${simDiff.toFixed(4)})`)
      }
    }
  }

  // --- Retrieval ---
  header('RETRIEVAL (PRE-PROMPT INJECTION)')

  for (let i = 0; i < milvus.retrieval.length; i++) {
    const mr = milvus.retrieval[i]
    const lr = lancedb.retrieval[i]
    if (!lr) { fail(`Missing LanceDB retrieval for "${mr.prompt}"`); continue }

    const promptLabel = `"${mr.prompt.slice(0, 40)}"`
    const mIds = new Set(mr.injectedIds)
    const lIds = new Set(lr.injectedIds)
    const overlap = [...mIds].filter(id => lIds.has(id))
    const overlapPct = mIds.size > 0 ? Math.round(overlap.length / mIds.size * 100) : (lIds.size === 0 ? 100 : 0)

    if (overlapPct === 100 && mr.injectedCount === lr.injectedCount) {
      pass(`${promptLabel}: ${mr.injectedCount} injected, identical set`)
    } else if (overlapPct >= 70) {
      warn(`${promptLabel}: ${overlapPct}% overlap (M=${mr.injectedCount} L=${lr.injectedCount})`)
    } else if (mr.injectedCount === 0 && lr.injectedCount === 0) {
      pass(`${promptLabel}: both injected 0`)
    } else {
      warn(`${promptLabel}: ${overlapPct}% overlap (M=${mr.injectedCount} L=${lr.injectedCount})`)
    }
  }

  // --- Maintenance ---
  header('MAINTENANCE (DRY RUN)')

  for (let i = 0; i < milvus.maintenance.length; i++) {
    const mm = milvus.maintenance[i]
    const lm = lancedb.maintenance[i]
    if (!lm) { fail(`Missing LanceDB maintenance for ${mm.operation}`); continue }

    if (mm.error && lm.error) {
      warn(`${mm.operation}: both errored (M: ${mm.error.slice(0, 60)}, L: ${lm.error.slice(0, 60)})`)
    } else if (mm.error || lm.error) {
      fail(`${mm.operation}: one errored (M: ${mm.error ?? 'ok'}, L: ${lm.error ?? 'ok'})`)
    } else if (mm.candidateCount === lm.candidateCount && mm.actionCount === lm.actionCount) {
      pass(`${mm.operation}: candidates=${mm.candidateCount} actions=${mm.actionCount}`)
      // Compare action targets
      const mActionIds = new Set(mm.actions.map(a => a.recordId).filter(Boolean))
      const lActionIds = new Set(lm.actions.map(a => a.recordId).filter(Boolean))
      const actionOverlap = [...mActionIds].filter(id => lActionIds.has(id))
      if (mActionIds.size > 0 && actionOverlap.length < mActionIds.size) {
        warn(`  Action targets differ: ${actionOverlap.length}/${mActionIds.size} overlap`)
      }
    } else {
      warn(`${mm.operation}: candidates M=${mm.candidateCount} L=${lm.candidateCount}, actions M=${mm.actionCount} L=${lm.actionCount}`)
    }
  }

  // --- Summary ---
  header('SUMMARY')
  if (issues === 0 && warnings === 0) {
    console.log(`\n  ${c.green}${c.bold}PERFECT MATCH${c.reset} — no issues or warnings\n`)
  } else {
    console.log(`\n  Issues: ${issues > 0 ? c.red + issues + c.reset : '0'}`)
    console.log(`  Warnings: ${warnings > 0 ? c.yellow + warnings + c.reset : '0'}`)
    if (issues === 0) {
      console.log(`  ${c.green}No critical issues.${c.reset} Warnings are expected (minor scoring differences between backends).\n`)
    } else {
      console.log(`  ${c.red}Critical issues found — investigate before proceeding.${c.reset}\n`)
    }
  }
}

// -------------- CLI --------------

async function main() {
  const command = process.argv[2]

  if (command === 'capture') {
    const results = await capture()
    // Output to stdout as JSON (all logging goes to stderr)
    process.stdout.write(JSON.stringify(results, null, 2) + '\n')
  } else if (command === 'compare') {
    const milvusPath = process.argv[3]
    const lancedbPath = process.argv[4]
    if (!milvusPath || !lancedbPath) {
      console.error('Usage: compare-backends.ts compare <milvus.json> <lancedb.json>')
      process.exit(1)
    }
    compare(milvusPath, lancedbPath)
  } else {
    console.error('Usage:')
    console.error('  compare-backends.ts capture          > results.json')
    console.error('  compare-backends.ts compare <a.json> <b.json>')
    process.exit(1)
  }
}

main().catch(error => {
  console.error('Fatal:', error)
  process.exit(1)
})
