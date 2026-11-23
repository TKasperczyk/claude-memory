import { spawn, spawnSync } from 'child_process'
import express from 'express'
import fs from 'fs'
import os from 'os'
import path from 'path'
import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { createSettingsRouter } from '../dashboard/server/routes/settings.js'
import {
  DATA_MIGRATIONS,
  getMigrationCollectionKey,
  runPendingMigrations
} from '../src/lib/data-migrations.js'
import { saveMigrationsState } from '../src/lib/migrations-state.js'
import {
  ALL_SETTINGS_FIELDS,
  CURRENT_SETTINGS_VERSION,
  DEFAULT_SETTINGS,
  HISTORICAL_DEFAULT_SETTINGS
} from '../src/lib/settings-schema.js'
import {
  buildSparseSettingsFile,
  getSettingsPath,
  isHistoricalDefault,
  loadSettings,
  migrateSettingsIfNeeded,
  resetSettings,
  saveSettings,
  validateSettingValue,
  type Settings
} from '../src/lib/settings.js'
import { DEFAULT_CONFIG, type Config } from '../src/lib/types.js'

const LOCAL_TSX_BIN = path.join(process.cwd(), 'node_modules', '.bin', 'tsx')

function getGuaranteedDeadPid(): number {
  const proc = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf-8' })
  if (typeof proc.pid === 'number' && proc.pid > 0) {
    return proc.pid
  }
  return 2147483647
}

function makeTempDir(prefix: string, cleanupList: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  cleanupList.push(dir)
  return dir
}

describe('sparse settings persistence and legacy v1->v2 migration', () => {
  const tempDirs: string[] = []
  const envBackup: Array<[string, string | undefined]> = []

  function setTempEnv(key: string, value: string | undefined): void {
    envBackup.push([key, process.env[key]])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }

  afterEach(() => {
    while (envBackup.length > 0) {
      const [key, value] = envBackup.pop()!
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  describe('historical defaults table invariants', () => {
    it('contains only valid non-current defaults and excludes opt-out/custom-prone values', () => {
      for (const [rawKey, values] of Object.entries(HISTORICAL_DEFAULT_SETTINGS)) {
        const key = rawKey as keyof Settings
        expect(Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key)).toBe(true)
        expect(Array.isArray(values)).toBe(true)
        expect(values!.length).toBeGreaterThan(0)
        for (const value of values!) {
          expect(value).not.toBe(DEFAULT_SETTINGS[key])
          const validation = validateSettingValue(key, value)
          expect(validation.ok).toBe(true)
        }
      }

      // Guardrail checks: never drop deliberate opt-outs or common user customizations.
      expect(isHistoricalDefault('autoUpdateIntervalHours', 0)).toBe(false)
      expect(isHistoricalDefault('enableHaikuRetrieval', true)).toBe(false)
      expect(isHistoricalDefault('maxRecords', 5)).toBe(false)
      expect(isHistoricalDefault('maxTokens', 2000)).toBe(false)
      expect(isHistoricalDefault('extractionModel', 'claude-opus-5-5')).toBe(false)
    })
  })

  describe('sparse persistence', () => {
    it('writes only non-default overrides plus settingsVersion=2 and strips keys reverted to defaults', () => {
      const dir = makeTempDir('cm-settings-sparse-', tempDirs)
      const settingsPath = path.join(dir, 'settings.json')

      saveSettings({ extractionModel: 'claude-opus-5-5', maxRecords: 5 }, { settingsPath })
      const diskAfterSave = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
      expect(diskAfterSave).toEqual({
        settingsVersion: CURRENT_SETTINGS_VERSION,
        maxRecords: 5,
        extractionModel: 'claude-opus-5-5'
      })

      // loadSettings merges defaults + overrides without leaking settingsVersion.
      const loaded = loadSettings({ settingsPath })
      expect(loaded.extractionModel).toBe('claude-opus-5-5')
      expect(loaded.maxRecords).toBe(5)
      expect(loaded.usageRatioWeight).toBe(DEFAULT_SETTINGS.usageRatioWeight)
      expect('settingsVersion' in loaded).toBe(false)

      // Reverting one key back to its default strips it from disk.
      saveSettings({ maxRecords: DEFAULT_SETTINGS.maxRecords }, { settingsPath })
      const diskAfterRevert = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
      expect(diskAfterRevert).toEqual({
        settingsVersion: CURRENT_SETTINGS_VERSION,
        extractionModel: 'claude-opus-5-5'
      })

      // Reverting the remaining override leaves only settingsVersion: 2.
      saveSettings({ extractionModel: DEFAULT_SETTINGS.extractionModel }, { settingsPath })
      const diskAllDefaults = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
      expect(diskAllDefaults).toEqual({
        settingsVersion: CURRENT_SETTINGS_VERSION
      })
    })

    it('preserves explicit v2 overrides even when they match a historical default value', () => {
      const dir = makeTempDir('cm-settings-v2-hist-', tempDirs)
      const settingsPath = path.join(dir, 'settings.json')

      saveSettings({
        usageRatioWeight: 0.2,
        suppressionMode: 'soft',
        maxSemanticQueryChars: 3000,
        minSemanticSimilarity: 0.7
      }, { settingsPath })

      const disk = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
      expect(disk).toEqual({
        settingsVersion: CURRENT_SETTINGS_VERSION,
        minSemanticSimilarity: 0.7,
        usageRatioWeight: 0.2,
        suppressionMode: 'soft',
        maxSemanticQueryChars: 3000
      })

      // Subsequent migration check must be an O(1) no-op and keep these overrides intact.
      const mig = migrateSettingsIfNeeded({ settingsPath })
      expect(mig.status).toBe('up-to-date')
      expect(fs.existsSync(`${settingsPath}.bak-pre-v2`)).toBe(false)

      // Unrelated save preserves explicit v2 historical-value overrides.
      saveSettings({ maxRecords: 12 }, { settingsPath })
      const loaded = loadSettings({ settingsPath })
      expect(loaded.usageRatioWeight).toBe(0.2)
      expect(loaded.suppressionMode).toBe('soft')
      expect(loaded.maxSemanticQueryChars).toBe(3000)
      expect(loaded.minSemanticSimilarity).toBe(0.7)
      expect(loaded.maxRecords).toBe(12)
    })

    it('never persists CC_MEMORIES_SETTING_* env overrides to disk during saveSettings()', () => {
      const dir = makeTempDir('cm-settings-env-', tempDirs)
      const settingsPath = path.join(dir, 'settings.json')

      setTempEnv('CC_MEMORIES_SETTING_MAX_RECORDS', '15')
      setTempEnv('CC_MEMORIES_SETTING_MIN_SEMANTIC_SIMILARITY', '0.4')

      const withEnv = loadSettings({ settingsPath })
      expect(withEnv.maxRecords).toBe(15)
      expect(withEnv.minSemanticSimilarity).toBe(0.4)

      saveSettings({ extractionModel: 'claude-opus-5-5' }, { settingsPath })
      const disk = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
      expect(disk).toEqual({
        settingsVersion: CURRENT_SETTINGS_VERSION,
        extractionModel: 'claude-opus-5-5'
      })
    })

    it('writes through symlinks (including dangling symlinks) and preserves permissions', () => {
      const dir = makeTempDir('cm-settings-symlink-', tempDirs)
      const realDir = path.join(dir, 'dotfiles')
      fs.mkdirSync(realDir, { recursive: true })
      const realTarget = path.join(realDir, 'settings.json')
      const linkPath = path.join(dir, 'settings.json')

      // Dangling symlink first
      fs.symlinkSync(realTarget, linkPath)
      saveSettings({ maxRecords: 11 }, { settingsPath: linkPath })
      expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true)
      expect(fs.existsSync(realTarget)).toBe(true)
      expect(JSON.parse(fs.readFileSync(realTarget, 'utf-8'))).toEqual({
        settingsVersion: CURRENT_SETTINGS_VERSION,
        maxRecords: 11
      })

      // Restrict mode and save again -> mode preserved, symlink preserved
      fs.chmodSync(realTarget, 0o600)
      saveSettings({ maxRecords: 12 }, { settingsPath: linkPath })
      expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true)
      expect(fs.statSync(realTarget).mode & 0o777).toBe(0o600)
      expect(loadSettings({ settingsPath: linkPath }).maxRecords).toBe(12)

      // resetSettings through symlink preserves symlink and target mode while clearing overrides
      resetSettings({ settingsPath: linkPath })
      expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true)
      expect(fs.statSync(realTarget).mode & 0o777).toBe(0o600)
      expect(JSON.parse(fs.readFileSync(realTarget, 'utf-8'))).toEqual({
        settingsVersion: CURRENT_SETTINGS_VERSION
      })
      expect(loadSettings({ settingsPath: linkPath })).toEqual(DEFAULT_SETTINGS)

      // resetSettings on a dangling symlink leaves symlink intact without creating target
      fs.unlinkSync(realTarget)
      resetSettings({ settingsPath: linkPath })
      expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true)
      expect(fs.existsSync(realTarget)).toBe(false)
    })

    it('resetSettings removes settings.json and is idempotent when missing', () => {
      const dir = makeTempDir('cm-settings-reset-', tempDirs)
      const settingsPath = path.join(dir, 'settings.json')

      resetSettings({ settingsPath })
      expect(fs.existsSync(settingsPath)).toBe(false)

      saveSettings({ maxRecords: 14 }, { settingsPath })
      expect(fs.existsSync(settingsPath)).toBe(true)

      resetSettings({ settingsPath })
      expect(fs.existsSync(settingsPath)).toBe(false)
      expect(loadSettings({ settingsPath })).toEqual(DEFAULT_SETTINGS)
    })

    it('normalizes -0 to 0 in buildSparseSettingsFile and validation', () => {
      const sparse = buildSparseSettingsFile({
        ...DEFAULT_SETTINGS,
        topicChangeThreshold: -0
      })
      expect(sparse).toEqual({ settingsVersion: CURRENT_SETTINGS_VERSION })
      const validated = validateSettingValue('topicChangeThreshold', -0)
      expect(validated.ok && Object.is(validated.normalized, 0)).toBe(true)
      expect(validated.ok && Object.is(validated.normalized, -0)).toBe(false)
    })
  })

  describe('legacy v1->v2 migration', () => {
    it('returns up-to-date (no-file) without creating any files when settings.json is absent', () => {
      const dir = makeTempDir('cm-settings-nofile-', tempDirs)
      const settingsPath = path.join(dir, 'settings.json')

      const result = migrateSettingsIfNeeded({ settingsPath })
      expect(result.status).toBe('up-to-date')
      expect(result.skipReason).toBe('no-file')
      expect(fs.existsSync(settingsPath)).toBe(false)
      expect(fs.existsSync(`${settingsPath}.bak-pre-v2`)).toBe(false)
    })

    it('migrates a full legacy pre-v0.3 settings.json, backs it up, drops current+historical+obsolete keys, and keeps genuine overrides', () => {
      const dir = makeTempDir('cm-settings-legacy-', tempDirs)
      const settingsPath = path.join(dir, 'settings.json')

      const legacyPayload: Record<string, unknown> = {
        ...DEFAULT_SETTINGS,
        // Historical defaults across releases (should all be dropped)
        minSemanticSimilarity: 0.7,
        semanticAnchorThreshold: 0.7,
        usageRatioWeight: 0.2,
        topicChangeThreshold: 0.3,
        recentlyInjectedWindow: 20,
        suppressionMode: 'soft',
        fallbackKeywordSemanticFloor: false,
        maxSemanticQueryChars: 3000,
        prePromptTimeoutMs: 8000,
        haikuQueryTimeoutMs: 2500,
        consolidationThreshold: 0.85,
        crossTypeConsolidationThreshold: 0.93,
        maxTranscriptChars: 500000,
        reviewModel: 'claude-opus-4-8',
        chatModel: 'claude-opus-4-5-20251101',
        // Obsolete removed keys (should be dropped)
        discoveryMaxAgeDays: 180,
        contradictionBatchSize: 15,
        // Invalid value (should be dropped)
        staleDays: -10,
        // Genuine user customizations (must be preserved!)
        extractionModel: 'claude-opus-5-5',
        maxRecords: 5,
        autoUpdateIntervalHours: 0,
        enableHaikuRetrieval: true
      }
      const originalRaw = JSON.stringify(legacyPayload, null, 2)
      fs.writeFileSync(settingsPath, originalRaw, 'utf-8')

      // 1. Read-only loadSettings() immediately strips historical defaults in memory WITHOUT mutating disk!
      const effectiveBeforeMigration = loadSettings({ settingsPath })
      expect(effectiveBeforeMigration.usageRatioWeight).toBe(DEFAULT_SETTINGS.usageRatioWeight)
      expect(effectiveBeforeMigration.suppressionMode).toBe('hard')
      expect(effectiveBeforeMigration.topicChangeThreshold).toBe(0)
      expect(effectiveBeforeMigration.recentlyInjectedWindow).toBe(200)
      expect(effectiveBeforeMigration.maxSemanticQueryChars).toBe(1200)
      expect(effectiveBeforeMigration.prePromptTimeoutMs).toBe(10000)
      expect(effectiveBeforeMigration.minSemanticSimilarity).toBe(0.65)
      expect(effectiveBeforeMigration.reviewModel).toBe('claude-opus-5-5')
      expect(effectiveBeforeMigration.chatModel).toBe('claude-opus-5-5')
      expect(effectiveBeforeMigration.extractionModel).toBe('claude-opus-5-5')
      expect(effectiveBeforeMigration.maxRecords).toBe(5)
      expect(effectiveBeforeMigration.autoUpdateIntervalHours).toBe(0)
      expect(effectiveBeforeMigration.enableHaikuRetrieval).toBe(true)
      expect(fs.readFileSync(settingsPath, 'utf-8')).toBe(originalRaw)
      expect(fs.existsSync(`${settingsPath}.bak-pre-v2`)).toBe(false)

      // 2. Dry-run reports plan without mutating disk or creating backup.
      const dryRun = migrateSettingsIfNeeded({ settingsPath, dryRun: true })
      expect(dryRun.status).toBe('would-run')
      expect(dryRun.fromVersion).toBe(1)
      expect(dryRun.toVersion).toBe(CURRENT_SETTINGS_VERSION)
      expect(dryRun.keptKeys).toEqual([
        'maxRecords',
        'enableHaikuRetrieval',
        'autoUpdateIntervalHours',
        'extractionModel'
      ])
      expect(dryRun.droppedKeys).toContain('usageRatioWeight')
      expect(dryRun.droppedKeys).toContain('maxSemanticQueryChars')
      expect(dryRun.droppedKeys).toContain('discoveryMaxAgeDays')
      expect(dryRun.droppedKeys).toContain('staleDays')
      expect(fs.readFileSync(settingsPath, 'utf-8')).toBe(originalRaw)
      expect(fs.existsSync(`${settingsPath}.bak-pre-v2`)).toBe(false)

      // 3. Real migration creates exact backup and sparse v2 file.
      const migrated = migrateSettingsIfNeeded({ settingsPath })
      expect(migrated.status).toBe('migrated')
      expect(migrated.backupPath).toBe(`${settingsPath}.bak-pre-v2`)
      expect(fs.readFileSync(migrated.backupPath!, 'utf-8')).toBe(originalRaw)

      const migratedDisk = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
      expect(migratedDisk).toEqual({
        settingsVersion: CURRENT_SETTINGS_VERSION,
        maxRecords: 5,
        enableHaikuRetrieval: true,
        autoUpdateIntervalHours: 0,
        extractionModel: 'claude-opus-5-5'
      })

      // 4. Re-running migration is O(1) lock-free up-to-date even while lock is held.
      const lockPath = path.join(dir, 'locks', 'settings.lock')
      fs.mkdirSync(path.dirname(lockPath), { recursive: true })
      fs.writeFileSync(lockPath, `${process.pid}\n${Date.now()}`)
      const secondRun = migrateSettingsIfNeeded({ settingsPath, lockPath })
      expect(secondRun.status).toBe('up-to-date')
      expect(secondRun.fromVersion).toBe(CURRENT_SETTINGS_VERSION)
      fs.unlinkSync(lockPath)
    })

    it('migrates legacy nested { retrieval, maintenance } files cleanly into sparse v2', () => {
      const dir = makeTempDir('cm-settings-nested-', tempDirs)
      const settingsPath = path.join(dir, 'settings.json')

      fs.writeFileSync(settingsPath, JSON.stringify({
        retrieval: {
          maxRecords: 6,
          usageRatioWeight: 0.2,
          staleDays: 30,
          oldNestedJunk: 'ignore-me'
        },
        maintenance: {
          staleDays: 90,
          consolidationThreshold: 0.85,
          idleSessionSweepHours: 12
        }
      }, null, 2))

      const res = migrateSettingsIfNeeded({ settingsPath })
      expect(res.status).toBe('migrated')
      expect(res.keptKeys).toEqual(['maxRecords', 'idleSessionSweepHours'])
      expect(res.droppedKeys).toContain('usageRatioWeight')
      expect(res.droppedKeys).toContain('consolidationThreshold')
      expect(res.droppedKeys).toContain('retrieval.oldNestedJunk')
      expect(res.droppedKeys).toContain('retrieval.staleDays')

      expect(JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))).toEqual({
        settingsVersion: CURRENT_SETTINGS_VERSION,
        maxRecords: 6,
        idleSessionSweepHours: 12
      })
    })

    it('never overwrites an existing settings.json.bak-pre-v2 backup file', () => {
      const dir = makeTempDir('cm-settings-bak-preserve-', tempDirs)
      const settingsPath = path.join(dir, 'settings.json')
      const originalBackupPath = `${settingsPath}.bak-pre-v2`

      fs.writeFileSync(originalBackupPath, '{"original": true}\n', 'utf-8')
      fs.writeFileSync(settingsPath, JSON.stringify({ usageRatioWeight: 0.2, maxRecords: 4 }), 'utf-8')

      const res = migrateSettingsIfNeeded({ settingsPath })
      expect(res.status).toBe('migrated')
      expect(res.backupPath).toBeDefined()
      expect(res.backupPath).not.toBe(originalBackupPath)
      expect(fs.readFileSync(originalBackupPath, 'utf-8')).toBe('{"original": true}\n')
      expect(JSON.parse(fs.readFileSync(res.backupPath!, 'utf-8'))).toEqual({
        usageRatioWeight: 0.2,
        maxRecords: 4
      })
    })

    it('does not downgrade future settingsVersion files (e.g., settingsVersion: 3) on migrate or save', () => {
      const dir = makeTempDir('cm-settings-future-', tempDirs)
      const settingsPath = path.join(dir, 'settings.json')
      const raw = JSON.stringify({
        settingsVersion: 3,
        usageRatioWeight: 0.2,
        futureExperimentalFlag: true
      }, null, 2)
      fs.writeFileSync(settingsPath, raw, 'utf-8')

      const res = migrateSettingsIfNeeded({ settingsPath })
      expect(res.status).toBe('up-to-date')
      expect(res.fromVersion).toBe(3)
      expect(fs.readFileSync(settingsPath, 'utf-8')).toBe(raw)
      expect(loadSettings({ settingsPath }).usageRatioWeight).toBe(0.2)

      saveSettings({ maxRecords: 10 }, { settingsPath })
      expect(JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))).toEqual({
        settingsVersion: 3,
        maxRecords: 10,
        usageRatioWeight: 0.2,
        futureExperimentalFlag: true
      })
    })

    it('migrates legacy file before applying patch in saveSettings(), preventing stale defaults from sticking', () => {
      const dir = makeTempDir('cm-settings-save-mig-', tempDirs)
      const settingsPath = path.join(dir, 'settings.json')

      const legacy = {
        usageRatioWeight: 0.2,
        maxSemanticQueryChars: 3000,
        suppressionMode: 'soft',
        extractionModel: 'claude-opus-5-5'
      }
      fs.writeFileSync(settingsPath, JSON.stringify(legacy, null, 2), 'utf-8')

      // User changes an unrelated setting (maxRecords) before migration has run.
      saveSettings({ maxRecords: 10 }, { settingsPath })

      // Backup must exist and stale historical defaults must NOT be stamped as v2 overrides.
      expect(fs.existsSync(`${settingsPath}.bak-pre-v2`)).toBe(true)
      expect(JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))).toEqual({
        settingsVersion: CURRENT_SETTINGS_VERSION,
        maxRecords: 10,
        extractionModel: 'claude-opus-5-5'
      })
    })

    it('honors an explicit save of a historical-default value on top of a legacy file', () => {
      const dir = makeTempDir('cm-settings-save-explicit-', tempDirs)
      const settingsPath = path.join(dir, 'settings.json')

      fs.writeFileSync(settingsPath, JSON.stringify({
        usageRatioWeight: 0.2,
        maxSemanticQueryChars: 3000
      }), 'utf-8')

      // Explicitly passing usageRatioWeight: 0.2 persists it, while untouched maxSemanticQueryChars: 3000 is still dropped.
      saveSettings({ usageRatioWeight: 0.2 }, { settingsPath })

      expect(JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))).toEqual({
        settingsVersion: CURRENT_SETTINGS_VERSION,
        usageRatioWeight: 0.2
      })
    })

    it('skips corrupt JSON on migration without destroying it, falls back on load, and recovers cleanly on save', () => {
      const dir = makeTempDir('cm-settings-corrupt-', tempDirs)
      const settingsPath = path.join(dir, 'settings.json')
      fs.writeFileSync(settingsPath, '{not valid json', 'utf-8')

      const mig = migrateSettingsIfNeeded({ settingsPath })
      expect(mig.status).toBe('skipped')
      expect(mig.skipReason).toBe('invalid-file')
      expect(mig.error).toContain('not valid JSON')
      expect(fs.readFileSync(settingsPath, 'utf-8')).toBe('{not valid json')

      expect(loadSettings({ settingsPath })).toEqual(DEFAULT_SETTINGS)

      saveSettings({ maxRecords: 9 }, { settingsPath })
      expect(fs.existsSync(`${settingsPath}.bak-corrupt`)).toBe(true)
      expect(JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))).toEqual({
        settingsVersion: CURRENT_SETTINGS_VERSION,
        maxRecords: 9
      })
    })

    it('respects live-PID lock contention and reclaims dead-PID locks during migration', () => {
      const dir = makeTempDir('cm-settings-lock-', tempDirs)
      const settingsPath = path.join(dir, 'settings.json')
      const lockPath = path.join(dir, 'locks', 'settings.lock')

      fs.writeFileSync(settingsPath, JSON.stringify({ usageRatioWeight: 0.2 }), 'utf-8')
      fs.mkdirSync(path.dirname(lockPath), { recursive: true })
      fs.writeFileSync(lockPath, `${process.pid}\n${Date.now()}`)

      // Live PID holds lock -> skipped cleanly after wait without mutating file.
      const contended = migrateSettingsIfNeeded({ settingsPath, lockPath })
      expect(contended.status).toBe('skipped')
      expect(contended.skipReason).toBe('locked')
      expect(fs.existsSync(`${settingsPath}.bak-pre-v2`)).toBe(false)

      // Dead PID lock is reclaimed cleanly.
      fs.writeFileSync(lockPath, `${getGuaranteedDeadPid()}\n${Date.now()}`)
      const reclaimed = migrateSettingsIfNeeded({ settingsPath, lockPath })
      expect(reclaimed.status).toBe('migrated')
      expect(JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))).toEqual({
        settingsVersion: CURRENT_SETTINGS_VERSION
      })
    })

    it('serializes concurrent OS subprocesses running migrateSettingsIfNeeded() and saveSettings() on settings.lock', async () => {
      const dir = makeTempDir('cm-settings-race-', tempDirs)
      const settingsPath = path.join(dir, 'settings.json')
      const lockPath = path.join(dir, 'locks', 'settings.lock')

      fs.writeFileSync(settingsPath, JSON.stringify({
        usageRatioWeight: 0.2,
        suppressionMode: 'soft',
        maxSemanticQueryChars: 3000,
        extractionModel: 'claude-opus-5-5'
      }, null, 2), 'utf-8')

      const runSnippet = (code: string): Promise<{ status: number | null; stdout: string; stderr: string }> =>
        new Promise((resolve, reject) => {
          const proc = spawn(LOCAL_TSX_BIN, ['-e', code], {
            cwd: process.cwd(),
            stdio: ['ignore', 'pipe', 'pipe']
          })
          let stdout = ''
          let stderr = ''
          proc.stdout.on('data', chunk => { stdout += chunk.toString() })
          proc.stderr.on('data', chunk => { stderr += chunk.toString() })
          proc.on('error', reject)
          proc.on('close', status => resolve({ status, stdout: stdout.trim(), stderr: stderr.trim() }))
        })

      const [migProc, saveProc] = await Promise.all([
        runSnippet(
          `import { migrateSettingsIfNeeded } from './src/lib/settings.ts';`
          + `console.log(JSON.stringify(migrateSettingsIfNeeded({ settingsPath: ${JSON.stringify(settingsPath)}, lockPath: ${JSON.stringify(lockPath)} })));`
        ),
        runSnippet(
          `import { saveSettings } from './src/lib/settings.ts';`
          + `saveSettings({ maxRecords: 11 }, { settingsPath: ${JSON.stringify(settingsPath)}, lockPath: ${JSON.stringify(lockPath)} });`
          + `console.log('SAVED');`
        )
      ])

      expect(migProc.status).toBe(0)
      expect(saveProc.status).toBe(0)
      const migResult = JSON.parse(migProc.stdout) as { status: string }
      expect(['migrated', 'up-to-date']).toContain(migResult.status)

      expect(JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))).toEqual({
        settingsVersion: CURRENT_SETTINGS_VERSION,
        maxRecords: 11,
        extractionModel: 'claude-opus-5-5'
      })
      const backupFiles = fs.readdirSync(dir).filter(name => name.startsWith('settings.json.bak-pre-v2'))
      expect(backupFiles).toEqual(['settings.json.bak-pre-v2'])
    })
  })

  describe('integration with runPendingMigrations and CLI runners', () => {
    it('migrates legacy settings.json inside runPendingMigrations even when LanceDB migrations are already up-to-date', async () => {
      const dir = makeTempDir('cm-mig-settings-uptodate-', tempDirs)
      const settingsPath = path.join(dir, 'settings.json')
      const statePath = path.join(dir, 'migrations-state.json')
      const lockPath = path.join(dir, 'locks', 'migrations.lock')

      const config: Config = {
        ...DEFAULT_CONFIG,
        lancedb: { directory: path.join(dir, 'lancedb'), table: 'already_done' }
      }

      // Mark all LanceDB migrations already applied (simulating v0.3.0 -> v0.3.1 upgrade on silwen/ivory).
      const collectionKey = getMigrationCollectionKey(config)
      const applied: Record<string, { appliedAt: number; scanned: number; updated: number }> = {}
      for (const migration of DATA_MIGRATIONS) {
        applied[migration.id] = { appliedAt: Date.now(), scanned: 10, updated: 0 }
      }
      saveMigrationsState({ version: 1, collections: { [collectionKey]: { applied, updatedAt: Date.now() } } }, statePath)

      fs.writeFileSync(settingsPath, JSON.stringify({
        ...DEFAULT_SETTINGS,
        usageRatioWeight: 0.2,
        extractionModel: 'claude-opus-5-5'
      }, null, 2))

      // Dry-run reports would-run without touching settings.json.
      const dryRes = await runPendingMigrations(config, { dryRun: true, statePath, lockPath, settingsPath })
      expect(dryRes.status).toBe('would-run')
      expect(dryRes.pendingIds).toEqual([])
      expect(dryRes.settingsMigration?.status).toBe('would-run')
      expect(dryRes.settingsMigration?.keptKeys).toEqual(['extractionModel'])
      expect(fs.existsSync(`${settingsPath}.bak-pre-v2`)).toBe(false)

      // Real run migrates settings.json without touching LanceDB.
      const applyRes = await runPendingMigrations(config, { statePath, lockPath, settingsPath })
      expect(applyRes.status).toBe('applied')
      expect(applyRes.steps).toEqual([])
      expect(applyRes.mutated).toBe(false)
      expect(applyRes.compacted).toBe(false)
      expect(applyRes.settingsMigration?.status).toBe('migrated')
      expect(applyRes.settingsMigration?.keptKeys).toEqual(['extractionModel'])
      expect(JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))).toEqual({
        settingsVersion: CURRENT_SETTINGS_VERSION,
        extractionModel: 'claude-opus-5-5'
      })

      // Subsequent run is O(1) up-to-date with no settingsMigration payload.
      const afterRes = await runPendingMigrations(config, { statePath, lockPath, settingsPath })
      expect(afterRes.status).toBe('up-to-date')
      expect(afterRes.settingsMigration).toBeUndefined()
    })

    it('migrates legacy settings.json inside runPendingMigrations even when LanceDB table does not exist yet', async () => {
      const dir = makeTempDir('cm-mig-settings-notable-', tempDirs)
      const settingsPath = path.join(dir, 'settings.json')
      const statePath = path.join(dir, 'migrations-state.json')
      const lockPath = path.join(dir, 'locks', 'migrations.lock')
      const config: Config = {
        ...DEFAULT_CONFIG,
        lancedb: { directory: path.join(dir, 'lancedb'), table: 'missing_table' }
      }

      fs.writeFileSync(settingsPath, JSON.stringify({
        maxSemanticQueryChars: 3000,
        maxRecords: 4
      }, null, 2))

      // Dry-run when LanceDB table does not exist must report only settings migration (no phantom pendingIds).
      const dryRes = await runPendingMigrations(config, { dryRun: true, statePath, lockPath, settingsPath })
      expect(dryRes.status).toBe('would-run')
      expect(dryRes.pendingIds).toEqual([])
      expect(dryRes.steps).toEqual([])
      expect(dryRes.settingsMigration?.status).toBe('would-run')

      const res = await runPendingMigrations(config, { statePath, lockPath, settingsPath })
      expect(res.status).toBe('applied')
      expect(res.pendingIds).toEqual([])
      expect(res.steps).toEqual([])
      expect(res.settingsMigration?.status).toBe('migrated')
      expect(JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))).toEqual({
        settingsVersion: CURRENT_SETTINGS_VERSION,
        maxRecords: 4
      })
    })

    it('reports skipped (not up-to-date) when LanceDB is up-to-date but settings migration is skipped for corrupt JSON or lock', async () => {
      const dir = makeTempDir('cm-mig-settings-skipped-', tempDirs)
      const settingsPath = path.join(dir, 'settings.json')
      const settingsLockPath = path.join(dir, 'locks', 'settings.lock')
      const statePath = path.join(dir, 'migrations-state.json')
      const lockPath = path.join(dir, 'locks', 'migrations.lock')
      const config: Config = {
        ...DEFAULT_CONFIG,
        lancedb: { directory: path.join(dir, 'lancedb'), table: 'already_done_skip' }
      }

      const collectionKey = getMigrationCollectionKey(config)
      const applied: Record<string, { appliedAt: number; scanned: number; updated: number }> = {}
      for (const migration of DATA_MIGRATIONS) {
        applied[migration.id] = { appliedAt: Date.now(), scanned: 10, updated: 0 }
      }
      saveMigrationsState({ version: 1, collections: { [collectionKey]: { applied, updatedAt: Date.now() } } }, statePath)

      // 1. Corrupt settings.json -> top-level status='skipped', skipReason='invalid-settings'
      fs.writeFileSync(settingsPath, '{corrupt json', 'utf-8')
      const corruptRes = await runPendingMigrations(config, {
        statePath,
        lockPath,
        settingsPath,
        settingsLockPath
      })
      expect(corruptRes.status).toBe('skipped')
      expect(corruptRes.skipReason).toBe('invalid-settings')
      expect(corruptRes.settingsMigration?.status).toBe('skipped')
      expect(corruptRes.settingsMigration?.skipReason).toBe('invalid-file')

      // 2. Live lock on settings.lock -> top-level status='skipped', skipReason='locked'
      fs.writeFileSync(settingsPath, JSON.stringify({ usageRatioWeight: 0.2 }), 'utf-8')
      fs.mkdirSync(path.dirname(settingsLockPath), { recursive: true })
      fs.writeFileSync(settingsLockPath, `${process.pid}\n${Date.now()}`)
      const lockedRes = await runPendingMigrations(config, {
        statePath,
        lockPath,
        settingsPath,
        settingsLockPath
      })
      fs.unlinkSync(settingsLockPath)
      expect(lockedRes.status).toBe('skipped')
      expect(lockedRes.skipReason).toBe('locked')
      expect(lockedRes.settingsMigration?.status).toBe('skipped')
      expect(lockedRes.settingsMigration?.skipReason).toBe('locked')
    })

    it('wires settings migration cleanly through self-update CLI (--dry-run and real run)', () => {
      const dir = makeTempDir('cm-self-update-settings-', tempDirs)
      const isolatedHome = path.join(dir, 'home')
      fs.mkdirSync(isolatedHome, { recursive: true })
      const settingsPath = path.join(dir, 'settings.json')

      fs.writeFileSync(settingsPath, JSON.stringify({
        ...DEFAULT_SETTINGS,
        usageRatioWeight: 0.2,
        suppressionMode: 'soft',
        maxSemanticQueryChars: 3000,
        extractionModel: 'claude-opus-5-5'
      }, null, 2))

      const env = {
        ...process.env,
        HOME: isolatedHome,
        CC_MEMORIES_DATA_DIR: dir,
        CC_MEMORIES_LANCEDB_DIR: path.join(dir, 'lancedb'),
        CC_MEMORIES_COLLECTION: 'self_update_settings_test',
        CC_MEMORIES_SETTING_AUTO_REBUILD_ENABLED: 'false'
      }

      // 1. Dry-run (text + JSON) must NOT mutate settings.json or report phantom LanceDB migrations.
      const dryTextProc = spawnSync(LOCAL_TSX_BIN, ['src/self-update.ts', '--dry-run'], {
        cwd: process.cwd(),
        encoding: 'utf-8',
        env
      })
      expect(dryTextProc.status).toBe(0)
      expect(dryTextProc.stderr).toContain('Migrations: would-run (settings v1->v2:')
      expect(dryTextProc.stderr).not.toContain('3 pending:')

      const dryProc = spawnSync(LOCAL_TSX_BIN, ['src/self-update.ts', '--dry-run', '--json'], {
        cwd: process.cwd(),
        encoding: 'utf-8',
        env
      })
      expect(dryProc.status).toBe(0)
      const dryJson = JSON.parse(dryProc.stdout) as {
        status: string
        migrations?: {
          status: string
          pendingIds: string[]
          settingsMigration?: { status: string; keptKeys: string[]; droppedKeys: string[] }
        }
      }
      expect(dryJson.status).toBe('completed')
      expect(dryJson.migrations?.status).toBe('would-run')
      expect(dryJson.migrations?.pendingIds).toEqual([])
      expect(dryJson.migrations?.settingsMigration?.status).toBe('would-run')
      expect(dryJson.migrations?.settingsMigration?.keptKeys).toEqual(['extractionModel'])
      expect(dryJson.migrations?.settingsMigration?.droppedKeys.length).toBe(ALL_SETTINGS_FIELDS.length - 1)
      expect(fs.existsSync(`${settingsPath}.bak-pre-v2`)).toBe(false)

      // 2. Real run migrates settings.json cleanly.
      const runProc = spawnSync(LOCAL_TSX_BIN, ['src/self-update.ts', '--rebuild-only', '--json'], {
        cwd: process.cwd(),
        encoding: 'utf-8',
        env
      })
      expect(runProc.status).toBe(0)
      const runJson = JSON.parse(runProc.stdout) as {
        status: string
        migrations?: {
          status: string
          pendingIds: string[]
          settingsMigration?: { status: string; backupPath?: string; keptKeys: string[] }
        }
      }
      expect(runJson.status).toBe('completed')
      expect(runJson.migrations?.status).toBe('applied')
      expect(runJson.migrations?.pendingIds).toEqual([])
      expect(runJson.migrations?.settingsMigration?.status).toBe('migrated')
      expect(runJson.migrations?.settingsMigration?.backupPath).toBe(`${settingsPath}.bak-pre-v2`)
      expect(fs.existsSync(`${settingsPath}.bak-pre-v2`)).toBe(true)
      expect(JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))).toEqual({
        settingsVersion: CURRENT_SETTINGS_VERSION,
        extractionModel: 'claude-opus-5-5'
      })

      // 3. Corrupt settings.json when LanceDB is up-to-date reports skipped + warning (never up-to-date).
      const collectionKey = getMigrationCollectionKey({
        ...DEFAULT_CONFIG,
        lancedb: { directory: path.join(dir, 'lancedb'), table: 'self_update_settings_test' }
      })
      const applied: Record<string, { appliedAt: number; scanned: number; updated: number }> = {}
      for (const migration of DATA_MIGRATIONS) {
        applied[migration.id] = { appliedAt: Date.now(), scanned: 0, updated: 0 }
      }
      saveMigrationsState(
        { version: 1, collections: { [collectionKey]: { applied, updatedAt: Date.now() } } },
        path.join(dir, 'migrations-state.json')
      )
      fs.writeFileSync(settingsPath, '{corrupt json', 'utf-8')

      const corruptProc = spawnSync(LOCAL_TSX_BIN, ['src/self-update.ts', '--dry-run'], {
        cwd: process.cwd(),
        encoding: 'utf-8',
        env
      })
      expect(corruptProc.status).toBe(0)
      expect(corruptProc.stderr).toContain('Migrations: skipped (settings skipped (invalid-file))')
      expect(corruptProc.stderr).toContain('Warning: settings.json is not valid JSON')
      expect(corruptProc.stderr).not.toContain('Migrations: up-to-date')
    })

    it('reports pending settings migration in maintenance CLI --dry-run without mutating settings.json', () => {
      const dir = makeTempDir('cm-maint-settings-dry-', tempDirs)
      const isolatedHome = path.join(dir, 'home')
      fs.mkdirSync(isolatedHome, { recursive: true })
      const settingsPath = path.join(dir, 'settings.json')

      const originalRaw = JSON.stringify({
        ...DEFAULT_SETTINGS,
        usageRatioWeight: 0.2,
        extractionModel: 'claude-opus-5-5'
      }, null, 2)
      fs.writeFileSync(settingsPath, originalRaw, 'utf-8')

      const proc = spawnSync(LOCAL_TSX_BIN, ['src/maintenance.ts', '--dry-run'], {
        cwd: process.cwd(),
        encoding: 'utf-8',
        env: {
          ...process.env,
          HOME: isolatedHome,
          CC_MEMORIES_DATA_DIR: dir,
          CC_MEMORIES_LANCEDB_DIR: path.join(dir, 'lancedb'),
          CC_MEMORIES_COLLECTION: 'maint_settings_dry_test'
        }
      })

      expect(proc.status).toBe(0)
      expect(proc.stderr).toContain('[DRY RUN] Pending settings migration v1->v2:')
      expect(proc.stderr).not.toContain('Pending data migrations (3)')
      expect(fs.readFileSync(settingsPath, 'utf-8')).toBe(originalRaw)
      expect(fs.existsSync(`${settingsPath}.bak-pre-v2`)).toBe(false)
    })

    it('persists sparse settings through real PUT /api/settings and PATCH /api/settings routes', async () => {
      const settingsPath = getSettingsPath()
      const backupPath = `${settingsPath}.bak-pre-v2`
      resetSettings()
      fs.rmSync(backupPath, { force: true })

      try {
        const app = express()
        app.use(express.json())
        app.use(createSettingsRouter())

        // Start with a legacy unversioned file on disk.
        fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
        fs.writeFileSync(settingsPath, JSON.stringify({
          ...DEFAULT_SETTINGS,
          usageRatioWeight: 0.2,
          maxSemanticQueryChars: 3000,
          extractionModel: 'claude-opus-5-5'
        }, null, 2))

        // GET /api/settings returns full Settings merged with migrated defaults (no settingsVersion field).
        const getRes = await request(app).get('/api/settings')
        expect(getRes.status).toBe(200)
        expect(getRes.body.usageRatioWeight).toBe(DEFAULT_SETTINGS.usageRatioWeight)
        expect(getRes.body.maxSemanticQueryChars).toBe(DEFAULT_SETTINGS.maxSemanticQueryChars)
        expect(getRes.body.extractionModel).toBe('claude-opus-5-5')
        expect('settingsVersion' in getRes.body).toBe(false)

        // PATCH /api/settings migrates legacy file, backs it up, and writes sparse overrides.
        const patchRes = await request(app)
          .patch('/api/settings')
          .send({ setting: 'maxRecords', value: 6 })
        expect(patchRes.status).toBe(200)
        expect(patchRes.body.maxRecords).toBe(6)
        expect(fs.existsSync(backupPath)).toBe(true)
        expect(JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))).toEqual({
          settingsVersion: CURRENT_SETTINGS_VERSION,
          maxRecords: 6,
          extractionModel: 'claude-opus-5-5'
        })

        // PUT /api/settings with full defaults + one override strips default keys.
        const putRes = await request(app)
          .put('/api/settings')
          .send({ ...DEFAULT_SETTINGS, maxRecords: 8, extractionModel: 'claude-opus-5-5' })
        expect(putRes.status).toBe(200)
        expect(JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))).toEqual({
          settingsVersion: CURRENT_SETTINGS_VERSION,
          extractionModel: 'claude-opus-5-5'
        })

        // PATCH rejects metadata key settingsVersion.
        const badPatch = await request(app)
          .patch('/api/settings')
          .send({ setting: 'settingsVersion', value: 1 })
        expect(badPatch.status).toBe(400)

        // POST /api/settings/reset deletes settings.json and returns defaults.
        const resetRes = await request(app).post('/api/settings/reset')
        expect(resetRes.status).toBe(200)
        expect(resetRes.body).toEqual(DEFAULT_SETTINGS)
        expect(fs.existsSync(settingsPath)).toBe(false)
      } finally {
        resetSettings()
        fs.rmSync(backupPath, { force: true })
      }
    })
  })
})
