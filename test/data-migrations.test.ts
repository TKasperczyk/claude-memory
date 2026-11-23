import { execFileSync, spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DATA_MIGRATIONS,
  getMigrationCollectionKey,
  getPendingMigrations,
  loadMigrationsState,
  MIGRATION_IDS,
  runPendingMigrations,
  type DataMigrationDefinition
} from '../src/lib/data-migrations.js'
import {
  bm25Search,
  buildLanceRow,
  closeLanceDB,
  getRecord,
  initLanceDB,
  insertRecord
} from '../src/lib/lancedb.js'
import { ensureClient } from '../src/lib/lancedb-client.js'
import { canonicalizePath } from '../src/lib/paths.js'
import {
  DEFAULT_CONFIG,
  EMBEDDING_DIM,
  type CommandRecord,
  type Config,
  type DiscoveryRecord
} from '../src/lib/types.js'

function unitVec(axis: number): number[] {
  const vec = new Array<number>(EMBEDDING_DIM).fill(0)
  vec[axis % EMBEDDING_DIM] = 1
  return vec
}

function makeTempConfig(
  baseDir: string,
  table: string = 'migrations_test_memories'
): Config {
  return {
    ...DEFAULT_CONFIG,
    lancedb: {
      directory: path.join(baseDir, 'lancedb'),
      table
    },
    embeddings: {
      ...DEFAULT_CONFIG.embeddings,
      // Point to an unreachable port so any accidental re-embedding fails immediately.
      baseUrl: 'http://127.0.0.1:1/v1'
    }
  }
}

describe('versioned automatic data migrations', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await closeLanceDB()
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('runs all 3 ordered zero-re-embedding migrations, compacts on mutation, and skips O(1) thereafter', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-migrations-e2e-'))
    tempDirs.push(tmpDir)

    // Create a real directory + symlink to test canonical path normalization.
    const realProjectDir = path.join(tmpDir, 'real-workspaces', 'demo-app')
    fs.mkdirSync(realProjectDir, { recursive: true })
    const symlinkWorkspace = path.join(tmpDir, 'linked-workspaces')
    fs.symlinkSync(path.join(tmpDir, 'real-workspaces'), symlinkWorkspace)
    const symlinkedProject = path.join(symlinkWorkspace, 'demo-app')
    const canonicalProject = canonicalizePath(realProjectDir)

    // Create a real git repo for Migration 3 re-attribution.
    const realGitRepo = path.join(tmpDir, 'repos', 'target-repo')
    fs.mkdirSync(realGitRepo, { recursive: true })
    execFileSync('git', ['init', '-q'], { cwd: realGitRepo })
    const repoFile = path.join(realGitRepo, 'src', 'server.ts')
    fs.mkdirSync(path.dirname(repoFile), { recursive: true })
    fs.writeFileSync(repoFile, 'export const port = 8080\n')
    const canonicalGitRepo = canonicalizePath(realGitRepo)

    const config = makeTempConfig(tmpDir)
    const statePath = path.join(tmpDir, 'migrations-state.json')
    const lockPath = path.join(tmpDir, 'locks', 'migrations.lock')

    await initLanceDB(config)

    // 1. Active record with symlinked project/cwd AND stale deprecation provenance.
    const recSymlinkAndStaleDep: CommandRecord = {
      id: '11111111-1111-4111-8111-111111111111',
      type: 'command',
      command: 'pnpm test',
      exitCode: 0,
      outcome: 'success',
      context: {
        project: symlinkedProject,
        cwd: symlinkedProject,
        intent: 'run unit test suite'
      },
      project: symlinkedProject,
      scope: 'project',
      timestamp: 1000,
      lastUsed: 1000,
      deprecated: false,
      deprecatedAt: 900,
      deprecatedReason: 'stale-restore-artifact',
      supersedingRecordId: '99999999-9999-4999-8999-999999999999',
      embedding: unitVec(1)
    }

    // 2. Deprecated record with symlinked project whose deprecation fields MUST be preserved.
    const recDeprecatedSymlink: DiscoveryRecord = {
      id: '22222222-2222-4222-8222-222222222222',
      type: 'discovery',
      what: 'Old deprecated build step',
      where: 'Makefile',
      evidence: 'superseded',
      confidence: 'verified',
      project: symlinkedProject,
      scope: 'project',
      timestamp: 1100,
      lastUsed: 1100,
      deprecated: true,
      deprecatedAt: 1200,
      deprecatedReason: 'actually-deprecated',
      supersedingRecordId: '88888888-8888-4888-8888-888888888888',
      embedding: unitVec(2)
    }

    // 3. Record with outdated search_text (simulating pre-v0.3 row where search_text = exact_text only).
    const recLegacySearchText: DiscoveryRecord = {
      id: '33333333-3333-4333-8333-333333333333',
      type: 'discovery',
      what: 'Database connection pooling setup',
      where: 'db/pool.ts',
      evidence: 'verified with k6 stress test against pgbouncer_unicorn_token',
      confidence: 'verified',
      entities: ['pgbouncer-unicorn'],
      project: canonicalProject,
      scope: 'project',
      timestamp: 1300,
      lastUsed: 1300,
      deprecated: false,
      embedding: unitVec(3)
    }

    // 4. Catch-all record referencing a real git repo -> should re-attribute to repo.
    const recCatchAllRepo: DiscoveryRecord = {
      id: '44444444-4444-4444-8444-444444444444',
      type: 'discovery',
      what: `Server listens on 8080 in ${repoFile}`,
      where: repoFile,
      evidence: 'read server.ts',
      confidence: 'verified',
      project: os.homedir(),
      scope: 'project',
      timestamp: 1400,
      lastUsed: 1400,
      deprecated: false,
      embedding: unitVec(4)
    }

    // 5. Catch-all record with workstation/infra signal -> should promote to environment scope.
    const recCatchAllEnv: DiscoveryRecord = {
      id: '55555555-5555-4555-8555-555555555555',
      type: 'discovery',
      what: 'WireGuard wg0 interface reloads via systemctl restart wg-quick@wg0',
      where: '/etc/wireguard/wg0.conf',
      evidence: 'journalctl -u wg-quick@wg0',
      confidence: 'verified',
      project: '/tmp/scratch-work',
      scope: 'project',
      timestamp: 1500,
      lastUsed: 1500,
      deprecated: false,
      embedding: unitVec(5)
    }

    // 6. Catch-all personal/unclassified note -> must remain untouched.
    const recCatchAllPersonal: DiscoveryRecord = {
      id: '66666666-6666-4666-8666-666666666666',
      type: 'discovery',
      what: 'Grocery list reminder for weekend trip',
      where: 'notes',
      evidence: 'user note',
      confidence: 'inferred',
      project: os.homedir(),
      scope: 'project',
      timestamp: 1600,
      lastUsed: 1600,
      deprecated: false,
      embedding: unitVec(6)
    }

    await insertRecord(recSymlinkAndStaleDep, config)
    await insertRecord(recDeprecatedSymlink, config)
    await insertRecord(recCatchAllRepo, config)
    await insertRecord(recCatchAllEnv, config)
    await insertRecord(recCatchAllPersonal, config)

    // Insert recLegacySearchText directly with stale search_text lacking evidence/entities.
    const { table } = await ensureClient(config)
    const staleRow = await buildLanceRow(recLegacySearchText, config)
    staleRow.search_text = 'Database connection pooling setup'
    await table.add([staleRow])

    // Dry-run reports all 3 pending without mutating DB or state file.
    const dryRunRes = await runPendingMigrations(config, { dryRun: true, statePath, lockPath })
    expect(dryRunRes.status).toBe('would-run')
    expect(dryRunRes.pendingIds).toEqual([
      MIGRATION_IDS.CANONICAL_PATHS_AND_RESTORES,
      MIGRATION_IDS.BACKFILL_SEARCH_TEXT,
      MIGRATION_IDS.CATCHALL_SCOPE
    ])
    expect(dryRunRes.mutated).toBe(false)
    expect(dryRunRes.compacted).toBe(false)
    expect(fs.existsSync(statePath)).toBe(false)
    expect((await getRecord(recSymlinkAndStaleDep.id, config))?.project).toBe(symlinkedProject)

    // Real run applies all 3 in order and compacts the table.
    const applyRes = await runPendingMigrations(config, { statePath, lockPath })
    expect(applyRes.status).toBe('applied')
    expect(applyRes.mutated).toBe(true)
    expect(applyRes.compacted).toBe(true)
    expect(applyRes.steps.map(s => s.id)).toEqual([
      MIGRATION_IDS.CANONICAL_PATHS_AND_RESTORES,
      MIGRATION_IDS.BACKFILL_SEARCH_TEXT,
      MIGRATION_IDS.CATCHALL_SCOPE
    ])
    expect(applyRes.steps[0].updated).toBe(2)
    expect(applyRes.steps[1].updated).toBe(1)
    expect(applyRes.steps[2].updated).toBe(2)
    expect(applyRes.steps[2].details).toMatchObject({
      reattributedToProject: 1,
      promotedToEnvironment: 1
    })
    // recCatchAllPersonal (plus the two /tmp-rooted non-git test fixtures) stay untouched as unclassified.
    expect(applyRes.steps[2].details?.skippedUnclassified).toBeGreaterThanOrEqual(1)

    // Verify Migration 1 results
    const after1 = await getRecord(recSymlinkAndStaleDep.id, config, { includeEmbedding: true }) as CommandRecord
    expect(after1.project).toBe(canonicalProject)
    expect(after1.context.project).toBe(canonicalProject)
    expect(after1.context.cwd).toBe(canonicalProject)
    expect(after1.deprecated).toBe(false)
    expect(after1.deprecatedAt).toBeUndefined()
    expect(after1.deprecatedReason).toBeUndefined()
    expect(after1.supersedingRecordId).toBeUndefined()
    expect(after1.embedding?.[1]).toBe(1)

    const afterDep = await getRecord(recDeprecatedSymlink.id, config)
    expect(afterDep?.project).toBe(canonicalProject)
    expect(afterDep?.deprecated).toBe(true)
    expect(afterDep?.deprecatedAt).toBe(1200)
    expect(afterDep?.deprecatedReason).toBe('actually-deprecated')
    expect(afterDep?.supersedingRecordId).toBe('88888888-8888-4888-8888-888888888888')

    // Verify Migration 2 results (BM25 FTS finds backfilled evidence token)
    const bm25Hits = await bm25Search({
      query: 'pgbouncer_unicorn_token',
      project: canonicalProject
    }, config)
    expect(bm25Hits.map(h => h.record.id)).toContain(recLegacySearchText.id)

    // Verify Migration 3 results
    const afterRepo = await getRecord(recCatchAllRepo.id, config)
    expect(afterRepo?.scope).toBe('project')
    expect(afterRepo?.project).toBe(canonicalGitRepo)

    const afterEnv = await getRecord(recCatchAllEnv.id, config)
    expect(afterEnv?.scope).toBe('environment')
    expect(afterEnv?.project).toBe('')

    const afterPersonal = await getRecord(recCatchAllPersonal.id, config)
    expect(afterPersonal?.scope).toBe('project')
    expect(afterPersonal?.project).toBe(os.homedir())

    // Verify persisted state
    const collectionKey = getMigrationCollectionKey(config)
    const state = loadMigrationsState(statePath)
    expect(Object.keys(state.collections[collectionKey]?.applied ?? {})).toEqual(
      DATA_MIGRATIONS.map(m => m.id)
    )
    expect(getPendingMigrations(config, { statePath })).toEqual([])

    // O(1) fast path: even if lock file is held by live PID, returns up-to-date immediately.
    fs.mkdirSync(path.dirname(lockPath), { recursive: true })
    fs.writeFileSync(lockPath, `${process.pid}\n${Date.now()}`)
    const fastPathRes = await runPendingMigrations(config, { statePath, lockPath })
    expect(fastPathRes.status).toBe('up-to-date')
    expect(fastPathRes.steps).toEqual([])
    expect(fastPathRes.compacted).toBe(false)
    fs.unlinkSync(lockPath)

    // Idempotency: deleting state file and re-running updates 0 rows and skips compaction.
    fs.unlinkSync(statePath)
    const rerunRes = await runPendingMigrations(config, { statePath, lockPath })
    expect(rerunRes.status).toBe('applied')
    expect(rerunRes.mutated).toBe(false)
    expect(rerunRes.compacted).toBe(false)
    expect(rerunRes.steps.every(step => step.updated === 0)).toBe(true)
  })

  it('skips cleanly when the LanceDB table does not exist on disk yet', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-migrations-notable-'))
    tempDirs.push(tmpDir)

    const config = makeTempConfig(tmpDir, 'nonexistent_table')
    const statePath = path.join(tmpDir, 'migrations-state.json')
    const lockPath = path.join(tmpDir, 'locks', 'migrations.lock')

    const res = await runPendingMigrations(config, { statePath, lockPath })
    expect(res.status).toBe('skipped')
    expect(res.skipReason).toBe('table-not-found')
    expect(fs.existsSync(path.join(tmpDir, 'lancedb'))).toBe(false)
    expect(fs.existsSync(statePath)).toBe(false)
  })

  it('respects exclusive lock contention and reclaims stale locks from dead PIDs', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-migrations-lock-'))
    tempDirs.push(tmpDir)

    const config = makeTempConfig(tmpDir)
    const statePath = path.join(tmpDir, 'migrations-state.json')
    const lockPath = path.join(tmpDir, 'locks', 'migrations.lock')
    await initLanceDB(config)

    // Active lock held by current live PID -> skip cleanly.
    fs.mkdirSync(path.dirname(lockPath), { recursive: true })
    fs.writeFileSync(lockPath, `${process.pid}\n${Date.now()}`)

    const lockedRes = await runPendingMigrations(config, { statePath, lockPath })
    expect(lockedRes.status).toBe('skipped')
    expect(lockedRes.skipReason).toBe('locked')
    expect(fs.existsSync(statePath)).toBe(false)

    // Stale lock held by dead PID -> reclaim and succeed.
    fs.writeFileSync(lockPath, `999999\n${Date.now()}`)
    const reclaimedRes = await runPendingMigrations(config, { statePath, lockPath })
    expect(reclaimedRes.status).toBe('applied')
    expect(fs.existsSync(lockPath)).toBe(false)
    expect(getPendingMigrations(config, { statePath })).toEqual([])
  })

  it('persists progress per step, halts on failure without running later steps, and resumes cleanly', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-migrations-partial-'))
    tempDirs.push(tmpDir)

    const config = makeTempConfig(tmpDir)
    const statePath = path.join(tmpDir, 'migrations-state.json')
    const lockPath = path.join(tmpDir, 'locks', 'migrations.lock')
    await initLanceDB(config)

    let shouldFailSecond = true
    const runFirst = vi.fn(async () => ({ scanned: 5, updated: 0 }))
    const runSecond = vi.fn(async () => {
      if (shouldFailSecond) throw new Error('simulated transient failure')
      return { scanned: 5, updated: 0 }
    })
    const runThird = vi.fn(async () => ({ scanned: 5, updated: 0 }))

    const customMigrations: DataMigrationDefinition[] = [
      { id: MIGRATION_IDS.CANONICAL_PATHS_AND_RESTORES, description: 'first', run: runFirst },
      { id: MIGRATION_IDS.BACKFILL_SEARCH_TEXT, description: 'second', run: runSecond },
      { id: MIGRATION_IDS.CATCHALL_SCOPE, description: 'third', run: runThird }
    ]

    const firstAttempt = await runPendingMigrations(config, {
      statePath,
      lockPath,
      migrations: customMigrations
    })
    expect(firstAttempt.status).toBe('failed')
    expect(firstAttempt.error).toContain('simulated transient failure')
    expect(runFirst).toHaveBeenCalledTimes(1)
    expect(runSecond).toHaveBeenCalledTimes(1)
    expect(runThird).not.toHaveBeenCalled()

    // Step 1 is already recorded; steps 2 and 3 remain pending.
    expect(getPendingMigrations(config, { statePath, migrations: customMigrations })).toEqual([
      MIGRATION_IDS.BACKFILL_SEARCH_TEXT,
      MIGRATION_IDS.CATCHALL_SCOPE
    ])

    // Second attempt skips Step 1 and completes Steps 2 and 3.
    shouldFailSecond = false
    const secondAttempt = await runPendingMigrations(config, {
      statePath,
      lockPath,
      migrations: customMigrations
    })
    expect(secondAttempt.status).toBe('applied')
    expect(runFirst).toHaveBeenCalledTimes(1)
    expect(runSecond).toHaveBeenCalledTimes(2)
    expect(runThird).toHaveBeenCalledTimes(1)
    expect(getPendingMigrations(config, { statePath, migrations: customMigrations })).toEqual([])
  })

  it('tracks collections independently and heals corrupt state JSON', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-migrations-multi-'))
    tempDirs.push(tmpDir)

    const configA = makeTempConfig(tmpDir, 'collection_a')
    const configB = makeTempConfig(tmpDir, 'collection_b')
    const statePath = path.join(tmpDir, 'migrations-state.json')
    const lockPath = path.join(tmpDir, 'locks', 'migrations.lock')

    await initLanceDB(configA)
    await initLanceDB(configB)

    // Write corrupt state JSON first; runner must recover safely.
    fs.writeFileSync(statePath, '{not valid json', 'utf-8')

    const resA = await runPendingMigrations(configA, { statePath, lockPath })
    expect(resA.status).toBe('applied')
    expect(getPendingMigrations(configA, { statePath })).toEqual([])
    expect(getPendingMigrations(configB, { statePath })).toHaveLength(DATA_MIGRATIONS.length)

    const resB = await runPendingMigrations(configB, { statePath, lockPath })
    expect(resB.status).toBe('applied')
    expect(getPendingMigrations(configA, { statePath })).toEqual([])
    expect(getPendingMigrations(configB, { statePath })).toEqual([])

    const state = loadMigrationsState(statePath)
    expect(Object.keys(state.collections)).toHaveLength(2)
  })

  it('never runs heavy data migrations inside initLanceDB()', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-migrations-no-init-'))
    tempDirs.push(tmpDir)

    const realDir = path.join(tmpDir, 'real-proj')
    const linkDir = path.join(tmpDir, 'link-proj')
    fs.mkdirSync(realDir, { recursive: true })
    fs.symlinkSync(realDir, linkDir)

    const config = makeTempConfig(tmpDir)
    const statePath = path.join(tmpDir, 'migrations-state.json')
    await initLanceDB(config)

    const rec: DiscoveryRecord = {
      id: '77777777-7777-4777-8777-777777777777',
      type: 'discovery',
      what: 'Symlinked discovery',
      where: 'README.md',
      evidence: 'checked',
      confidence: 'verified',
      project: linkDir,
      scope: 'project',
      timestamp: 1000,
      lastUsed: 1000,
      deprecated: false,
      deprecatedAt: 500,
      embedding: unitVec(7)
    }
    await insertRecord(rec, config)
    await closeLanceDB()

    // Re-opening LanceDB via initLanceDB must stay fast and never mutate rows or write migration state.
    await initLanceDB(config)
    const afterInit = await getRecord(rec.id, config)
    expect(afterInit?.project).toBe(linkDir)
    expect(afterInit?.deprecatedAt).toBe(500)
    expect(fs.existsSync(statePath)).toBe(false)
  })

  it('reports migration status cleanly in self-update CLI --dry-run --json without mutating DB', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-migrations-cli-'))
    tempDirs.push(tmpDir)

    const lancedbDir = path.join(tmpDir, 'lancedb')
    const config: Config = {
      ...DEFAULT_CONFIG,
      lancedb: {
        directory: lancedbDir,
        table: 'cli_dry_run_table'
      }
    }
    await initLanceDB(config)
    await closeLanceDB()

    const proc = spawnSync(
      'npx',
      ['tsx', 'src/self-update.ts', '--dry-run', '--json'],
      {
        cwd: process.cwd(),
        encoding: 'utf-8',
        env: {
          ...process.env,
          CC_MEMORIES_DATA_DIR: tmpDir,
          CC_MEMORIES_LANCEDB_DIR: lancedbDir,
          CC_MEMORIES_COLLECTION: 'cli_dry_run_table'
        }
      }
    )

    expect(proc.status).toBe(0)
    const parsed = JSON.parse(proc.stdout) as {
      migrations?: { status: string; pendingIds: string[]; mutated: boolean; compacted: boolean }
    }
    expect(parsed.migrations).toBeDefined()
    expect(parsed.migrations?.status).toBe('would-run')
    expect(parsed.migrations?.pendingIds).toEqual(DATA_MIGRATIONS.map(m => m.id))
    expect(parsed.migrations?.mutated).toBe(false)
    expect(parsed.migrations?.compacted).toBe(false)
    expect(fs.existsSync(path.join(tmpDir, 'migrations-state.json'))).toBe(false)
  })

  it('runs pending migrations automatically inside post-session-worker when the table exists', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-migrations-worker-'))
    tempDirs.push(tmpDir)

    const lancedbDir = path.join(tmpDir, 'lancedb')
    const table = 'worker_migration_table'
    const config: Config = {
      ...DEFAULT_CONFIG,
      lancedb: { directory: lancedbDir, table },
      embeddings: { ...DEFAULT_CONFIG.embeddings, baseUrl: 'http://127.0.0.1:1/v1' }
    }
    await initLanceDB(config)

    const staleRec: DiscoveryRecord = {
      id: '88888888-8888-4888-8888-888888888888',
      type: 'discovery',
      what: 'Worker migration check',
      where: 'README.md',
      evidence: 'verified',
      confidence: 'verified',
      project: '/srv/demo',
      scope: 'project',
      timestamp: 1000,
      lastUsed: 1000,
      deprecated: false,
      deprecatedAt: 500,
      deprecatedReason: 'stale-restore',
      embedding: unitVec(8)
    }
    await insertRecord(staleRec, config)
    await closeLanceDB()

    const inputFile = path.join(tmpDir, 'worker-input.json')
    fs.writeFileSync(inputFile, JSON.stringify({
      hook_event_name: 'SessionEnd',
      reason: 'clear',
      session_id: 'worker-mig-session',
      transcript_path: '',
      cwd: tmpDir,
      permission_mode: 'default'
    }), 'utf-8')

    const proc = spawnSync(
      'npx',
      ['tsx', 'src/hooks/post-session-worker.ts', inputFile],
      {
        cwd: process.cwd(),
        encoding: 'utf-8',
        env: {
          ...process.env,
          CC_MEMORIES_DATA_DIR: tmpDir,
          CC_MEMORIES_LANCEDB_DIR: lancedbDir,
          CC_MEMORIES_COLLECTION: table,
          CC_MEMORIES_SETTING_AUTO_MAINTENANCE_INTERVAL_HOURS: '0',
          CC_MEMORIES_SETTING_AUTO_UPDATE_INTERVAL_HOURS: '0',
          CC_MEMORIES_SETTING_AUTO_REBUILD_ENABLED: 'false'
        }
      }
    )

    expect(proc.status).toBe(0)
    const statePath = path.join(tmpDir, 'migrations-state.json')
    expect(fs.existsSync(statePath)).toBe(true)
    expect(getPendingMigrations(config, { statePath })).toEqual([])

    const after = await getRecord(staleRec.id, config)
    expect(after?.deprecatedAt).toBeUndefined()
    expect(after?.deprecatedReason).toBeUndefined()
  })

  it('reports pending migrations in maintenance CLI --dry-run without mutating state', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-migrations-maint-'))
    tempDirs.push(tmpDir)

    const lancedbDir = path.join(tmpDir, 'lancedb')
    const table = 'maint_dry_run_table'
    const config: Config = {
      ...DEFAULT_CONFIG,
      lancedb: { directory: lancedbDir, table }
    }
    await initLanceDB(config)
    await closeLanceDB()

    const proc = spawnSync(
      'npx',
      ['tsx', 'src/maintenance.ts', '--dry-run'],
      {
        cwd: process.cwd(),
        encoding: 'utf-8',
        env: {
          ...process.env,
          CC_MEMORIES_DATA_DIR: tmpDir,
          CC_MEMORIES_LANCEDB_DIR: lancedbDir,
          CC_MEMORIES_COLLECTION: table
        }
      }
    )

    expect(proc.status).toBe(0)
    expect(proc.stderr).toContain('[DRY RUN] Pending data migrations (3)')
    expect(fs.existsSync(path.join(tmpDir, 'migrations-state.json'))).toBe(false)
  })
})
