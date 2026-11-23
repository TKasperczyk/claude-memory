import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  bm25Search,
  buildFilter,
  closeLanceDB,
  initLanceDB,
  insertRecord
} from '../src/lib/lancedb.js'
import { DEFAULT_CONFIG, EMBEDDING_DIM, type Config, type DiscoveryRecord, type ErrorRecord, type MemoryRecord, type WarningRecord } from '../src/lib/types.js'
import { isCatchAllDirectory, resolveAttributionScope } from '../src/lib/scope-attribution.js'
import { coerceExtractionResult } from '../src/lib/extract.js'
import { clearStaticDocCache, findStaticDocOverlap, loadStaticProjectDocs } from '../src/lib/static-docs.js'
import { checkValidity, isRecordTtlExpired } from '../src/lib/maintenance/scans.js'
import { migrateCatchAllScopeRecords, runStaticDocReconciliation } from '../src/lib/maintenance/runners/static-doc-runner.js'
import { extractFailureSignature, lookupFailureMemories } from '../src/hooks/post-tool-failure.js'
import { isNativeAutoMemoryFileWrite } from '../src/hooks/memory-write-hint.js'
import { queryDaemon, startDaemonServer } from '../src/lib/daemon.js'
import { getInstallationStatus, installHooks } from '../src/lib/installer.js'
import { sanitizeMergedUpdates, selectReconcileTarget } from '../src/lib/write-reconciliation.js'
import { sanitizeRecordUpdates } from '../src/lib/record-updates.js'
import { findGlobalCandidates } from '../src/lib/maintenance/scans.js'

function unitVec(axis: number): number[] {
  const v = new Array<number>(EMBEDDING_DIM).fill(0)
  v[axis % EMBEDDING_DIM] = 1
  return v
}

function makeTempEnv(): { dir: string; config: Config } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-phase3-test-'))
  const config: Config = {
    ...DEFAULT_CONFIG,
    lancedb: {
      directory: path.join(dir, 'lancedb'),
      table: 'phase3_test_memories'
    }
  }
  return { dir, config }
}

describe('Phase 3: Scoping, Durability/TTL, Static Docs, PostToolUseFailure, & Warm Daemon', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    clearStaticDocCache()
    await closeLanceDB()
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('prevents /home and /tmp catch-all attribution and supports 3-tier scope + linkedWorkspaces', async () => {
    expect(isCatchAllDirectory(os.homedir())).toBe(true)
    expect(isCatchAllDirectory('/tmp')).toBe(true)
    expect(isCatchAllDirectory('/tmp/random-scratch')).toBe(true)
    expect(isCatchAllDirectory('/var/tmp/build')).toBe(true)
    expect(isCatchAllDirectory('/srv/projects/my-repo')).toBe(false)

    expect(resolveAttributionScope(os.homedir(), null)).toEqual({
      scope: 'environment',
      project: '',
      isCatchAll: true
    })
    expect(resolveAttributionScope('/tmp/scratch', null)).toEqual({
      scope: 'environment',
      project: '',
      isCatchAll: true
    })
    expect(resolveAttributionScope('/srv/projects/app/sub', '/srv/projects/app')).toEqual({
      scope: 'project',
      project: '/srv/projects/app',
      isCatchAll: false
    })

    // Extraction coercion downgrades catch-all project paths to environment scope and preserves volatility/ttlDays
    const extracted = coerceExtractionResult({
      records: [{
        type: 'discovery',
        what: 'iGPU passthrough uses cloned HDMI EDID firmware',
        where: '/etc/default/grub',
        evidence: 'drm.edid_firmware=HDMI-A-1:edid/my_edid.bin',
        confidence: 'verified',
        project: os.homedir(),
        volatility: 'stable',
        ttlDays: 365,
        sourceExcerpt: 'drm.edid_firmware'
      }]
    }, { sessionId: 's1', cwd: os.homedir() })

    expect(extracted).toHaveLength(1)
    expect(extracted[0].scope).toBe('environment')
    expect(extracted[0].project).toBe('')
    expect(extracted[0].volatility).toBe('stable')
    expect(extracted[0].ttlDays).toBe(365)

    // Real LanceDB 3-tier scope + linkedWorkspaces isolation test
    const { dir, config } = makeTempEnv()
    tempDirs.push(dir)
    await initLanceDB(config)

    const envRec: DiscoveryRecord = {
      id: 'aaaa0001-1111-4111-8111-111111111111',
      type: 'discovery',
      what: 'Local workstation proxy listens on port 8443 with TLS',
      where: 'workstation',
      evidence: 'tested via curl',
      confidence: 'verified',
      scope: 'environment',
      project: '',
      timestamp: 1000,
      lastUsed: 1000,
      deprecated: false,
      embedding: unitVec(1)
    }
    const linkedRec: DiscoveryRecord = {
      id: 'aaaa0002-1111-4111-8111-111111111111',
      type: 'discovery',
      what: 'Shared protobuf schema lives in workspace-proto under proto/v2',
      where: '/srv/workspace-proto/proto/v2',
      evidence: 'checked buf.yaml',
      confidence: 'verified',
      scope: 'project',
      project: '/srv/workspace-proto',
      timestamp: 1000,
      lastUsed: 1000,
      deprecated: false,
      embedding: unitVec(2)
    }
    const privateOtherRec: DiscoveryRecord = {
      id: 'aaaa0003-1111-4111-8111-111111111111',
      type: 'discovery',
      what: 'Secret billing cron schedule for unrelated private repo',
      where: '/srv/private-billing',
      evidence: 'crontab',
      confidence: 'verified',
      scope: 'project',
      project: '/srv/private-billing',
      timestamp: 1000,
      lastUsed: 1000,
      deprecated: false,
      embedding: unitVec(3)
    }
    const legacyHomeRec: DiscoveryRecord = {
      id: 'aaaa0004-1111-4111-8111-111111111111',
      type: 'discovery',
      what: 'Legacy home directory systemd quirk',
      where: os.homedir(),
      evidence: 'systemctl status',
      confidence: 'verified',
      scope: 'project',
      project: os.homedir(),
      timestamp: 1000,
      lastUsed: 1000,
      deprecated: false,
      embedding: unitVec(4)
    }

    await insertRecord(envRec, config)
    await insertRecord(linkedRec, config)
    await insertRecord(privateOtherRec, config)
    await insertRecord(legacyHomeRec, config)

    // Repo /srv/workspace-app linked to /srv/workspace-proto sees linked + environment, NOT private-billing
    const filter = buildFilter({
      project: '/srv/workspace-app',
      linkedWorkspaces: ['/srv/workspace-proto'],
      includeGlobal: true
    })
    expect(filter).toContain("OR scope = 'global' OR scope = 'environment'")
    expect(filter).toContain('/srv/workspace-proto')

    const linkedHits = await bm25Search({
      query: 'protobuf schema workspace-proto',
      project: '/srv/workspace-app',
      linkedWorkspaces: ['/srv/workspace-proto'],
      includeGlobal: true
    }, config)
    expect(linkedHits.map(h => h.record.id)).toContain(linkedRec.id)

    const envHits = await bm25Search({
      query: 'workstation proxy port 8443',
      project: '/srv/workspace-app',
      includeGlobal: true
    }, config)
    expect(envHits.map(h => h.record.id)).toContain(envRec.id)

    // Catch-all (/tmp) search with onlySharedScopes=true never leaks private project records
    const catchAllLeak = await bm25Search({
      query: 'secret billing cron schedule',
      onlySharedScopes: true
    }, config)
    expect(catchAllLeak).toEqual([])

    // Catch-all scope migration re-attributes legacy /home/<user> record to environment without re-embedding
    const migration = await migrateCatchAllScopeRecords(config)
    expect(migration.migrated).toBe(1)
    const afterMigration = await bm25Search({
      query: 'legacy home directory systemd quirk',
      onlySharedScopes: true
    }, config)
    expect(afterMigration.map(h => h.record.id)).toContain(legacyHomeRec.id)
    expect(afterMigration[0].record.scope).toBe('environment')
  })

  it('expires ephemeral and TTL-bounded records in stale-check validity', async () => {
    const dayMs = 24 * 60 * 60 * 1000
    const oldEphemeral: DiscoveryRecord = {
      id: 'bbbb0001-1111-4111-8111-111111111111',
      type: 'discovery',
      what: 'Temporary workaround for feature flag X',
      where: 'src/flags.ts',
      evidence: 'flag enabled during rollout',
      confidence: 'verified',
      volatility: 'ephemeral',
      ttlDays: 7,
      timestamp: Date.now() - 10 * dayMs,
      lastUsed: Date.now() - 10 * dayMs
    }
    const freshStable: DiscoveryRecord = {
      ...oldEphemeral,
      id: 'bbbb0002-1111-4111-8111-111111111111',
      volatility: 'stable',
      ttlDays: undefined
    }

    expect(isRecordTtlExpired(oldEphemeral).expired).toBe(true)
    expect(await checkValidity(oldEphemeral)).toEqual({ valid: false, reason: 'ttl-expired:7d' })
    expect(await checkValidity(freshStable)).toEqual({ valid: true })
  })

  it('reconciles Tier-0 CLAUDE.md/AGENTS.md docs and surfaces graduation candidates', async () => {
    const { dir, config } = makeTempEnv()
    tempDirs.push(dir)
    const repoDir = path.join(dir, 'repo')
    fs.mkdirSync(repoDir, { recursive: true })
    fs.writeFileSync(
      path.join(repoDir, 'CLAUDE.md'),
      '# Architecture\n\n- Always run pnpm build before running installer reconciliation because dist hooks are loaded from disk.\n',
      'utf-8'
    )

    const docs = loadStaticProjectDocs(repoDir)
    expect(docs.digest).toContain('pnpm build')

    await initLanceDB(config)
    const coveredRec: DiscoveryRecord = {
      id: 'cccc0001-1111-4111-8111-111111111111',
      type: 'discovery',
      what: 'Always run pnpm build before running installer reconciliation because dist hooks load from disk',
      where: 'CLAUDE.md',
      evidence: 'dist hooks loaded from disk',
      confidence: 'verified',
      project: repoDir,
      scope: 'project',
      timestamp: 1000,
      lastUsed: 1000,
      deprecated: false,
      embedding: unitVec(10)
    }
    const gradRec: DiscoveryRecord = {
      id: 'cccc0002-1111-4111-8111-111111111111',
      type: 'discovery',
      what: 'Staging PostgreSQL requires sslmode=verify-full with custom internal CA bundle',
      where: 'infra/db.ts',
      evidence: 'verified across 4 deployments',
      confidence: 'verified',
      project: repoDir,
      scope: 'project',
      usageCount: 4,
      volatility: 'stable',
      timestamp: 1000,
      lastUsed: 1000,
      deprecated: false,
      embedding: unitVec(11)
    }

    expect(findStaticDocOverlap(coveredRec, docs, 0.72, 5)).not.toBeNull()
    expect(findStaticDocOverlap(gradRec, docs, 0.72, 5)).toBeNull()

    await insertRecord(coveredRec, config)
    await insertRecord(gradRec, config)

    const reconcile = await runStaticDocReconciliation(false, config)
    expect(reconcile.summary.deprecated).toBe(1)
    expect(reconcile.summary.graduationSuggestions).toBe(1)
  })

  it('discovers global ~/.claude/AGENTS.md and ~/.claude/skills/*/SKILL.md with bounded digest budgeting', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-global-static-docs-'))
    tempDirs.push(dir)
    const fakeHome = path.join(dir, 'home')
    const fakeRepo = path.join(dir, 'repo')
    fs.mkdirSync(path.join(fakeHome, '.claude', 'skills', '.git'), { recursive: true })
    fs.mkdirSync(path.join(fakeHome, '.claude', 'skills', 'synced'), { recursive: true })
    fs.mkdirSync(path.join(fakeHome, '.claude', 'skills', 'codex-workflow'), { recursive: true })
    fs.mkdirSync(fakeRepo, { recursive: true })

    fs.writeFileSync(
      path.join(fakeRepo, 'CLAUDE.md'),
      '# Repo Instructions\n\n- Run vitest before merging pull requests.\n',
      'utf-8'
    )
    fs.writeFileSync(
      path.join(fakeHome, '.claude', 'CLAUDE.md'),
      '# Global Claude\n\n- Keep patches focused and avoid speculative refactors.\n',
      'utf-8'
    )
    fs.writeFileSync(
      path.join(fakeHome, '.claude', 'AGENTS.md'),
      '# Global Agents\n\n- Always verify staging migrations with dry-run output before production apply.\n',
      'utf-8'
    )
    fs.writeFileSync(
      path.join(fakeHome, '.claude', 'skills', 'codex-workflow', 'SKILL.md'),
      [
        '---',
        'name: codex-workflow',
        'description: Codex-powered implementation workflow via codex-swarm.',
        '---',
        '',
        '# Codex Implementation Workflow',
        '',
        '- Always verify codex-swarm patches against real data before merging to main branch.'
      ].join('\n'),
      'utf-8'
    )

    const docs = loadStaticProjectDocs(fakeRepo, fakeRepo, { homeDir: fakeHome })
    const labels = docs.entries.map(e => e.label)
    expect(labels).toContain('repo/CLAUDE.md')
    expect(labels).toContain('~/.claude/CLAUDE.md')
    expect(labels).toContain('~/.claude/AGENTS.md')
    expect(labels).toContain('~/.claude/skills/codex-workflow/SKILL.md')
    expect(labels.some(l => l.includes('.git') || l.includes('synced'))).toBe(false)
    expect(docs.digest).toContain('~/.claude/AGENTS.md')
    expect(docs.digest).toContain('~/.claude/skills/codex-workflow/SKILL.md')

    // When cwd === homeDir, ~/.claude/* must retain canonical ~/.claude/* labels without duplication
    const homeDocs = loadStaticProjectDocs(undefined, fakeHome, { homeDir: fakeHome })
    expect(homeDocs.entries.filter(e => e.path.endsWith('codex-workflow/SKILL.md'))).toHaveLength(1)
    expect(homeDocs.entries.find(e => e.path.endsWith('codex-workflow/SKILL.md'))?.label)
      .toBe('~/.claude/skills/codex-workflow/SKILL.md')

    // Deterministic overlap matches facts documented in ~/.claude/AGENTS.md and global skills
    const skillRec: DiscoveryRecord = {
      id: 'cccc0010-1111-4111-8111-111111111111',
      type: 'discovery',
      what: 'Always verify codex-swarm patches against real data before merging to main branch',
      where: 'codex-workflow',
      evidence: 'codex-workflow skill',
      confidence: 'verified',
      scope: 'global',
      project: ''
    }
    const agentsRec: DiscoveryRecord = {
      id: 'cccc0011-1111-4111-8111-111111111111',
      type: 'discovery',
      what: 'Always verify staging migrations with dry-run output before production apply',
      where: 'global agents',
      evidence: 'AGENTS.md',
      confidence: 'verified',
      scope: 'global',
      project: ''
    }
    expect(findStaticDocOverlap(skillRec, docs, 0.72, 5)?.matchedLabel)
      .toBe('~/.claude/skills/codex-workflow/SKILL.md')
    expect(findStaticDocOverlap(agentsRec, docs, 0.72, 5)?.matchedLabel)
      .toBe('~/.claude/AGENTS.md')

    // Large global skill collections (40 skills) stay strictly bounded in both count and digest chars
    for (let i = 0; i < 40; i += 1) {
      const name = `extra-skill-${String(i).padStart(2, '0')}`
      const skillDir = path.join(fakeHome, '.claude', 'skills', name)
      fs.mkdirSync(skillDir, { recursive: true })
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        `---\nname: ${name}\ndescription: Detailed operational workflow for service ${name} across clusters.\n---\n\n# ${name}\n\n${'Operational guidance paragraph. '.repeat(40)}\n`,
        'utf-8'
      )
    }
    clearStaticDocCache()
    const largeDocs = loadStaticProjectDocs(fakeRepo, fakeRepo, { homeDir: fakeHome })
    const globalSkillEntries = largeDocs.entries.filter(e => e.label.startsWith('~/.claude/skills/'))
    expect(globalSkillEntries.length).toBeLessThanOrEqual(32)
    expect(largeDocs.digest.length).toBeLessThanOrEqual(6_000)
    // Primary docs still survive in the budgeted digest even with dozens of global skills
    expect(largeDocs.digest).toContain('repo/CLAUDE.md')
    expect(largeDocs.digest).toContain('~/.claude/CLAUDE.md')
    expect(largeDocs.digest).toContain('~/.claude/AGENTS.md')

    // Symlinked AGENTS.md -> CLAUDE.md must deduplicate to one entry and never waste digest budget,
    // and YAML multiline block scalar descriptions (`description: >`) must be preserved in skill digests.
    const symlinkRepo = path.join(dir, 'symlink-repo')
    fs.mkdirSync(path.join(symlinkRepo, '.claude', 'skills', 'multi-desc'), { recursive: true })
    fs.writeFileSync(path.join(symlinkRepo, 'CLAUDE.md'), '# Shared Instructions\n\n- Unique fact A.\n', 'utf-8')
    fs.symlinkSync(path.join(symlinkRepo, 'CLAUDE.md'), path.join(symlinkRepo, 'AGENTS.md'))
    fs.writeFileSync(
      path.join(symlinkRepo, '.claude', 'skills', 'multi-desc', 'SKILL.md'),
      [
        '---',
        'name: multi-desc',
        'description: >',
        '  Multiline folded summary for deploying',
        '  zero-downtime workers.',
        '---',
        '',
        '# Worker Deployment',
        '',
        'Long body text. '.repeat(500)
      ].join('\n'),
      'utf-8'
    )
    const emptyHome = path.join(dir, 'empty-home')
    fs.mkdirSync(emptyHome, { recursive: true })
    clearStaticDocCache()
    const symlinkDocs = loadStaticProjectDocs(symlinkRepo, symlinkRepo, { homeDir: emptyHome })
    expect(symlinkDocs.entries.filter(e => e.kind === 'primary')).toHaveLength(1)
    expect(symlinkDocs.entries[0]?.label).toBe('symlink-repo/CLAUDE.md')
    expect(symlinkDocs.digest).not.toContain('symlink-repo/AGENTS.md')
    expect(symlinkDocs.digest).toContain('Multiline folded summary for deploying zero-downtime workers.')
  })

  it('deterministically matches known error/warning fixes on PostToolUseFailure in <100ms without LLM or embeddings', async () => {
    const { dir, config } = makeTempEnv()
    tempDirs.push(dir)
    await initLanceDB(config)

    const errFix: ErrorRecord = {
      id: 'dddd0001-1111-4111-8111-111111111111',
      type: 'error',
      errorText: 'SQLITE_BUSY: database is locked during vitest parallel execution',
      errorType: 'database',
      cause: 'concurrent writers without WAL busy_timeout',
      resolution: 'Enable PRAGMA journal_mode=WAL and busy_timeout=5000',
      context: { project: '/srv/app' },
      project: '/srv/app',
      scope: 'project',
      timestamp: 1000,
      lastUsed: 1000,
      deprecated: false,
      embedding: unitVec(20)
    }
    const unrelatedWarn: WarningRecord = {
      id: 'dddd0002-1111-4111-8111-111111111111',
      type: 'warning',
      avoid: 'Using rm -rf on nfs mounts',
      useInstead: 'Use rsync --delete',
      reason: 'NFS metadata lock storms',
      severity: 'warning',
      project: '/srv/app',
      scope: 'project',
      timestamp: 1000,
      lastUsed: 1000,
      deprecated: false,
      embedding: unitVec(21)
    }
    await insertRecord(errFix, config)
    await insertRecord(unrelatedWarn, config)

    const payload = {
      hook_event_name: 'PostToolUseFailure' as const,
      session_id: 'fail-sess-1',
      transcript_path: '',
      cwd: '/srv/app',
      permission_mode: 'default',
      tool_name: 'Bash',
      tool_input: { command: 'pnpm vitest run test/db.test.ts' },
      error: 'Error: SQLITE_BUSY: database is locked during vitest parallel execution'
    }

    const sig = extractFailureSignature(payload)
    expect(sig?.errorCodes.has('sqlite_busy')).toBe(true)

    const lookup = await lookupFailureMemories(payload, config, { skipSuppression: true })
    expect(lookup.records.map(r => r.id)).toEqual([errFix.id])
    expect(lookup.context).toContain('<known-failure-matches>')
    expect(lookup.context).toContain('PRAGMA journal_mode=WAL')
    expect(lookup.durationMs).toBeLessThan(500)

    // Native Claude Code auto-memory file detection
    expect(isNativeAutoMemoryFileWrite({
      tool_name: 'Write',
      tool_input: { file_path: '/home/user/.claude/projects/-srv-app/memory/debugging.md' }
    })).toBe(true)
    expect(isNativeAutoMemoryFileWrite({
      tool_name: 'Write',
      tool_input: { file_path: '/srv/app/src/index.ts' }
    })).toBe(false)
  })

  it('serves /health and /post-tool-failure over a warm Unix-socket daemon and falls back cleanly when stopped', async () => {
    const { dir, config } = makeTempEnv()
    tempDirs.push(dir)
    const sockPath = path.join(dir, 'test-daemon.sock')
    const pidPath = path.join(dir, 'test-daemon.pid')

    // Missing socket returns null immediately
    expect(await queryDaemon('/health', undefined, { socketPath: sockPath })).toBeNull()

    await initLanceDB(config)
    const handle = await startDaemonServer({
      socketPath: sockPath,
      pidPath,
      idleTimeoutMs: 60_000,
      onPostToolFailure: async (payload, cfg) => lookupFailureMemories(payload, cfg, { skipSuppression: true })
    })

    try {
      const health = await queryDaemon<{ ok: boolean; pid: number }>('/health', undefined, { socketPath: sockPath })
      expect(health?.ok).toBe(true)
      expect(health?.pid).toBe(process.pid)
    } finally {
      await handle.close()
    }

    expect(fs.existsSync(sockPath)).toBe(false)
    expect(fs.existsSync(pidPath)).toBe(false)
  })

  it('registers PostToolUseFailure with Bash matcher and 3s timeout in installer', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-installer-p3-'))
    tempDirs.push(dir)
    const settingsPath = path.join(dir, 'settings.json')
    const status = installHooks(settingsPath, dir)
    expect(status.PostToolUseFailure.installed).toBe(true)

    const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    const entry = saved.hooks.PostToolUseFailure.find((e: any) => e.matcher === 'Bash')
    expect(entry).toBeDefined()
    expect(entry.hooks[0].timeout).toBe(3)
    expect(getInstallationStatus(settingsPath, dir).hooks.PostToolUseFailure.installed).toBe(true)
  })

  it('preserves project scope on ProcedureRecord, clears project on explicit environment scope, and validates enum/volatility updates', () => {
    // Regression: ProcedureRecord previously ran applyCommonOptionalFields before pickProject,
    // misclassifying normal repo procedures as scope='environment'.
    const procInRepo = coerceExtractionResult({
      records: [{
        type: 'procedure',
        name: 'Deploy API server',
        steps: ['pnpm build', 'systemctl restart api'],
        sourceExcerpt: 'pnpm build'
      }]
    }, { sessionId: 's1', cwd: '/srv/projects/my-repo', project: '/srv/projects/my-repo' })
    expect(procInRepo).toHaveLength(1)
    expect(procInRepo[0].scope).not.toBe('environment')
    expect((procInRepo[0] as any).context.project).toBe('/srv/projects/my-repo')

    // Procedure extracted from /home catch-all must become environment with empty context.project
    const procInHome = coerceExtractionResult({
      records: [{
        type: 'procedure',
        name: 'Restart local DNS',
        steps: ['systemctl restart systemd-resolved'],
        sourceExcerpt: 'systemd-resolved'
      }]
    }, { sessionId: 's2', cwd: os.homedir() })
    expect(procInHome).toHaveLength(1)
    expect(procInHome[0].scope).toBe('environment')
    expect(procInHome[0].project).toBe('')
    expect((procInHome[0] as any).context.project).toBe('')

    // Explicit scope='environment' inside a real repo must leave project empty
    const envInRepo = coerceExtractionResult({
      records: [{
        type: 'discovery',
        what: 'Local AI proxy runs on 127.0.0.1:8443',
        where: 'workstation',
        evidence: 'curl check',
        confidence: 'verified',
        scope: 'environment',
        sourceExcerpt: '8443'
      }]
    }, { sessionId: 's3', cwd: '/srv/projects/my-repo', project: '/srv/projects/my-repo' })
    expect(envInRepo).toHaveLength(1)
    expect(envInRepo[0].scope).toBe('environment')
    expect(envInRepo[0].project).toBe('')

    // sanitizeMergedUpdates must reject invalid enum strings
    const discTarget: DiscoveryRecord = {
      id: 'd-enum', type: 'discovery', what: 'old', where: 'w', evidence: 'e', confidence: 'verified'
    }
    const sanitized = sanitizeMergedUpdates(discTarget, { what: 'new', confidence: 'super-high' })
    expect(sanitized).toEqual({ what: 'new' })

    // selectReconcileTarget must reject missing/out-of-bounds indices when multiple neighbors exist
    const n0 = { record: discTarget, similarity: 0.85 }
    const n1 = { record: { ...discTarget, id: 'd-enum-2' }, similarity: 0.80 }
    expect(selectReconcileTarget([n0, n1], 1)).toBe(n1)
    expect(selectReconcileTarget([n0, n1], 99)).toBeNull()
    expect(selectReconcileTarget([n0, n1], -1)).toBeNull()
    expect(selectReconcileTarget([n0, n1], undefined)).toBeNull()
    expect(selectReconcileTarget([n0], undefined)).toBe(n0)
    expect(selectReconcileTarget([n0], 2)).toBeNull()

    // sanitizeRecordUpdates supports volatility & ttlDays
    const upd = sanitizeRecordUpdates(discTarget, { volatility: 'ephemeral', ttlDays: 14, scope: 'environment' })
    expect(upd.rejectedFields).toEqual([])
    expect(upd.updates).toEqual({ volatility: 'ephemeral', ttlDays: 14, scope: 'environment' })
  })

  it('rejects noisy Exit code 1 stdout and unrelated global warnings in PostToolUseFailure while matching punctuation-heavy errors', async () => {
    // Non-error Exit code 1 outputs and interruption notices must short-circuit to null signature
    expect(extractFailureSignature({
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_input: { command: 'ls /tmp/pictures' },
      error: 'Exit code 1\ndesk-depth.png desk-mesh.png walk-1.png'
    })).toBeNull()
    expect(extractFailureSignature({
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_input: { command: 'touch /tmp/x' },
      error: '[Tool call did not complete: the turn was ended to deliver the message that follows.]'
    })).toBeNull()

    // buildFilter must honor includeEnvironment: false even when onlySharedScopes is true
    expect(buildFilter({ onlySharedScopes: true, includeEnvironment: false })).toBe("scope = 'global'")

    const { dir, config } = makeTempEnv()
    tempDirs.push(dir)
    await initLanceDB(config)

    const unrelatedGlobalWarning: WarningRecord = {
      id: 'eeee0001-1111-4111-8111-111111111111',
      type: 'warning',
      avoid: 'Using Vibma MCP server for creating or modifying Figma designs when running scripts',
      useInstead: 'Use Vibma only for reading Figma documents',
      reason: 'Creates broken layers when using automated calls without manual review',
      severity: 'warning',
      scope: 'global',
      project: '',
      timestamp: 1000,
      lastUsed: 1000,
      deprecated: false,
      embedding: unitVec(30)
    }
    const glibError: ErrorRecord = {
      id: 'eeee0002-1111-4111-8111-111111111111',
      type: 'error',
      errorText: 'GLib-GObject:ERROR:../glib/gobject/gsignal.c:4084:invalid_closure_notify: assertion failed',
      errorType: 'runtime',
      resolution: 'Restart wireplumber user service after disabling bluez monitor plugin',
      context: { project: '/srv/audio' },
      scope: 'global',
      project: '',
      timestamp: 1000,
      lastUsed: 1000,
      deprecated: false,
      embedding: unitVec(31)
    }
    await insertRecord(unrelatedGlobalWarning, config)
    await insertRecord(glibError, config)

    // Python TypeError sharing common English words MUST NOT trigger unrelated global Figma warning
    const noiseRes = await lookupFailureMemories({
      hook_event_name: 'PostToolUseFailure',
      session_id: 'noise-s',
      transcript_path: '',
      cwd: '/srv/app',
      permission_mode: 'default',
      tool_name: 'Bash',
      tool_input: { command: 'python3 -I - <<PY\nprint("creating designs when running")\nPY' },
      error: "Exit code 1\nTraceback (most recent call last):\n  File '<stdin>', line 5\nTypeError: cannot use 'tuple' when creating without key"
    }, config, { skipSuppression: true })
    expect(noiseRes.records).toEqual([])

    // Punctuation-glued GLib error MUST still match via aligned FTS tokenization
    const glibRes = await lookupFailureMemories({
      hook_event_name: 'PostToolUseFailure',
      session_id: 'glib-s',
      transcript_path: '',
      cwd: '/srv/audio',
      permission_mode: 'default',
      tool_name: 'Bash',
      tool_input: { command: 'wireplumber' },
      error: 'Exit code 134\nGLib-GObject:ERROR:../glib/gobject/gsignal.c:4084:invalid_closure_notify: assertion failed'
    }, config, { skipSuppression: true })
    expect(glibRes.records.map(r => r.id)).toEqual([glibError.id])
  })

  it('smartly re-attributes repo-referencing catch-all records, skips unclassified personal notes, and excludes environment scope from global promotion', async () => {
    const { dir, config } = makeTempEnv()
    tempDirs.push(dir)
    const fakeRepo = path.join(dir, 'real-repo')
    fs.mkdirSync(fakeRepo, { recursive: true })
    execFileSync('git', ['init', fakeRepo], { stdio: 'ignore' })
    const fileInRepo = path.join(fakeRepo, 'src/server.ts')
    fs.mkdirSync(path.dirname(fileInRepo), { recursive: true })
    fs.writeFileSync(fileInRepo, 'export const PORT = 3000\n')

    await initLanceDB(config)

    const repoRefRec: DiscoveryRecord = {
      id: 'ffff0001-1111-4111-8111-111111111111',
      type: 'discovery',
      what: 'Server port is configured in real-repo',
      where: fileInRepo,
      evidence: `Found in ${fileInRepo}`,
      confidence: 'verified',
      scope: 'project',
      project: os.homedir(),
      timestamp: 1000,
      lastUsed: 1000,
      deprecated: false,
      embedding: unitVec(40)
    }
    const personalDownloadsRec: DiscoveryRecord = {
      id: 'ffff0002-1111-4111-8111-111111111111',
      type: 'discovery',
      what: 'OpenSubtitles has one Polish subtitle for Aladdin 2019',
      where: path.join(os.homedir(), 'Downloads'),
      evidence: 'sub 7889582',
      confidence: 'verified',
      scope: 'project',
      project: path.join(os.homedir(), 'Downloads'),
      timestamp: 1000,
      lastUsed: 1000,
      deprecated: false,
      embedding: unitVec(41)
    }
    const highUsageEnvRec: DiscoveryRecord = {
      id: 'ffff0003-1111-4111-8111-111111111111',
      type: 'discovery',
      what: 'Workstation iGPU passthrough uses cloned HDMI EDID firmware',
      where: '/etc/default/grub',
      evidence: 'iommu=pt',
      confidence: 'verified',
      scope: 'environment',
      project: '',
      usageCount: 10,
      retrievalCount: 10,
      timestamp: 1000,
      lastUsed: 1000,
      deprecated: false,
      embedding: unitVec(42)
    }

    const configPathEnvRec: DiscoveryRecord = {
      id: 'ffff0004-1111-4111-8111-111111111111',
      type: 'discovery',
      what: 'Custom terminal font configured in ~/.config/kitty/kitty.conf and /etc/hosts aliases',
      where: '~/.config/kitty/kitty.conf',
      evidence: 'edited ~/.claude/settings.json and /usr/local/bin/helper',
      confidence: 'verified',
      scope: 'project',
      project: os.homedir(),
      timestamp: 1000,
      lastUsed: 1000,
      deprecated: false,
      embedding: unitVec(43)
    }

    await insertRecord(repoRefRec, config)
    await insertRecord(personalDownloadsRec, config)
    await insertRecord(highUsageEnvRec, config)
    await insertRecord(configPathEnvRec, config)

    const migration = await migrateCatchAllScopeRecords(config)
    expect(migration.reattributedToProject).toBe(1)
    expect(migration.promotedToEnvironment).toBe(1)
    expect(migration.skippedUnclassified).toBe(1)

    // findGlobalCandidates must NEVER propose environment-scoped records for global promotion
    const globalCandidates = await findGlobalCandidates(config)
    expect(globalCandidates.map(r => r.id)).not.toContain(highUsageEnvRec.id)
  })

  it('refuses to hijack an already-running daemon socket and reflects fresh writes via checkoutLatest', async () => {
    const { dir, config } = makeTempEnv()
    tempDirs.push(dir)
    const sockPath = path.join(dir, 'live-daemon.sock')
    const pidPath = path.join(dir, 'live-daemon.pid')
    await initLanceDB(config)

    const handle = await startDaemonServer({
      socketPath: sockPath,
      pidPath,
      idleTimeoutMs: 60_000,
      onPostToolFailure: async (payload, cfg) => lookupFailureMemories(payload, cfg, { skipSuppression: true })
    })

    try {
      // Starting a second daemon on the same live socket must fail cleanly instead of unlinking it
      await expect(startDaemonServer({ socketPath: sockPath, pidPath })).rejects.toThrow(/already listening/i)

      // Insert a new error record after daemon started and verify daemon immediately sees it
      const freshErr: ErrorRecord = {
        id: '99990001-1111-4111-8111-111111111111',
        type: 'error',
        errorText: 'ERR_DAEMON_FRESHNESS_TEST: socket pool saturated',
        errorType: 'network',
        resolution: 'Increase maxSockets to 32',
        context: { project: '/srv/app' },
        project: '/srv/app',
        scope: 'project',
        timestamp: Date.now(),
        lastUsed: Date.now(),
        deprecated: false,
        embedding: unitVec(50)
      }
      await insertRecord(freshErr, config)

      const resp = await queryDaemon<{ records: MemoryRecord[] }>('/post-tool-failure', {
        payload: {
          hook_event_name: 'PostToolUseFailure',
          session_id: 's-fresh',
          transcript_path: '',
          cwd: '/srv/app',
          permission_mode: 'default',
          tool_name: 'Bash',
          tool_input: { command: 'node server.js' },
          error: 'Error: ERR_DAEMON_FRESHNESS_TEST: socket pool saturated'
        },
        config
      }, { socketPath: sockPath })

      expect(resp?.records.map(r => r.id)).toEqual([freshErr.id])
    } finally {
      await handle.close()
    }
  })
})
