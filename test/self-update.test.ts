import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  SelfUpdateCommandResult,
  SelfUpdateCommandRunner
} from '../src/lib/self-update.js'
import {
  DIST_DIRECTORY,
  getBuildStampPath,
  getDistPath,
  getHookArtifactRelativePath,
  getHookScriptPath,
  HOOK_SCRIPTS,
  MCP_SERVER_SCRIPT,
  POST_SESSION_WORKER_SCRIPT,
  REQUIRED_DIST_ARTIFACTS
} from '../src/lib/runtime-artifacts.js'

type SelfUpdateModule = typeof import('../src/lib/self-update.js')

type GitFixture = {
  root: string
  seed: string
  remote: string
  storage: string
  settingsPath: string
  statePath: string
  lockPath: string
}

type RunnerOptions = {
  installFailures?: number
  buildFailure?: boolean
  fetchFailure?: boolean
  mergeFailure?: boolean
  missingBuildArtifacts?: readonly string[]
  onBuild?: (root: string) => void
  onMerge?: () => void
}

type CommandCall = {
  command: string
  args: string[]
}

let tempDir = ''
let fixture: GitFixture
let originalAutoUpdate: string | undefined
let originalAutoRebuild: string | undefined
const PRE_PROMPT_ARTIFACT =
  getHookArtifactRelativePath(HOOK_SCRIPTS.UserPromptSubmit)
const HOOK_ARTIFACTS = [
  ...new Set(Object.values(HOOK_SCRIPTS).map(getHookArtifactRelativePath))
]
const POST_SESSION_WORKER_ARTIFACT =
  getHookArtifactRelativePath(POST_SESSION_WORKER_SCRIPT)
const REQUIRED_ARTIFACT_CLASSES = [
  ...HOOK_ARTIFACTS.map(relativePath => [`hook ${relativePath}`, relativePath] as const),
  ['post-session worker', POST_SESSION_WORKER_ARTIFACT] as const,
  ['MCP entry point', MCP_SERVER_SCRIPT] as const
]

function runProcess(command: string, args: string[], cwd?: string): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0'
    }
  })
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`
    )
  }
  return result.stdout.trim()
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, 'utf-8')
}

function writeRuntimeArtifacts(distRoot: string, label: string): void {
  for (const relativePath of REQUIRED_DIST_ARTIFACTS) {
    writeFile(path.join(distRoot, relativePath), `${label}: ${relativePath}\n`)
  }
}

function readPrePrompt(root: string, directory: string = DIST_DIRECTORY): string {
  return fs.readFileSync(
    path.join(getDistPath(root, directory), PRE_PROMPT_ARTIFACT),
    'utf-8'
  )
}

function canonicalize(targetPath: string): string {
  const resolvedPath = path.resolve(targetPath)
  try {
    return fs.realpathSync(resolvedPath)
  } catch {
    return resolvedPath
  }
}

function createGitFixture(baseDirectory: string): GitFixture {
  const remote = path.join(baseDirectory, 'origin.git')
  const seed = path.join(baseDirectory, 'seed')
  const root = path.join(baseDirectory, 'checkout')
  const storage = path.join(baseDirectory, 'storage')

  runProcess('git', ['init', '--bare', '--initial-branch=main', remote])
  runProcess('git', ['clone', remote, seed])
  runProcess('git', ['config', 'user.name', 'Self Update Test'], seed)
  runProcess('git', ['config', 'user.email', 'self-update@example.test'], seed)

  writeFile(path.join(seed, 'package.json'), JSON.stringify({
    name: 'claude-memory',
    version: '0.0.0',
    private: true
  }, null, 2))
  writeFile(path.join(seed, 'tsconfig.json'), '{}\n')
  writeFile(path.join(seed, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")
  writeFile(path.join(seed, 'pnpm-workspace.yaml'), 'packages: []\n')
  writeFile(path.join(seed, 'src', 'index.ts'), 'export const version = 1\n')
  writeFile(path.join(seed, 'shared', 'types.d.ts'), 'export type Fixture = string\n')
  writeFile(path.join(seed, '.gitignore'), [
    'dist/',
    'dist.next/',
    'dist.prev/',
    'dist.prev.saved/'
  ].join('\n'))
  runProcess('git', ['add', '.'], seed)
  runProcess('git', ['commit', '-m', 'initial'], seed)
  runProcess('git', ['push', '--set-upstream', 'origin', 'main'], seed)

  runProcess('git', ['clone', remote, root])
  runProcess('git', ['config', 'user.name', 'Self Update Test'], root)
  runProcess('git', ['config', 'user.email', 'self-update@example.test'], root)
  writeRuntimeArtifacts(path.join(root, 'dist'), 'old build')
  makeDistFresh(root)

  return {
    root,
    seed,
    remote,
    storage,
    settingsPath: path.join(storage, '.claude', 'settings.json'),
    statePath: path.join(storage, 'self-update-state.json'),
    lockPath: path.join(storage, 'locks', 'self-update.lock')
  }
}

function setTreeMtime(targetPath: string, timestamp: Date): void {
  if (!fs.existsSync(targetPath)) return
  const stats = fs.lstatSync(targetPath)
  if (stats.isDirectory()) {
    for (const name of fs.readdirSync(targetPath)) {
      setTreeMtime(path.join(targetPath, name), timestamp)
    }
  }
  fs.utimesSync(targetPath, timestamp, timestamp)
}

function sourceInputPaths(root: string): string[] {
  return [
    path.join(root, 'src'),
    path.join(root, 'shared'),
    path.join(root, 'tsconfig.json'),
    path.join(root, 'package.json')
  ]
}

function makeDistFresh(root: string): void {
  const sourceTime = new Date(Date.now() - 60_000)
  const distTime = new Date(Date.now() - 10_000)
  for (const sourcePath of sourceInputPaths(root)) {
    setTreeMtime(sourcePath, sourceTime)
  }
  setTreeMtime(path.join(root, 'dist'), distTime)
}

function makeDistStale(root: string): void {
  const distTime = new Date(Date.now() - 60_000)
  setTreeMtime(path.join(root, 'dist'), distTime)
  writeFile(
    path.join(root, 'src', 'index.ts'),
    `export const version = ${Date.now()}\n`
  )
}

function advanceRemote(content: string = `export const version = ${Date.now()}\n`): string {
  return advanceRemoteFile('src/index.ts', content, `remote ${Date.now()}`)
}

function advanceRemoteFile(relativePath: string, content: string, message: string): string {
  writeFile(path.join(fixture.seed, relativePath), content)
  runProcess('git', ['add', relativePath], fixture.seed)
  runProcess('git', ['commit', '-m', message], fixture.seed)
  runProcess('git', ['push', 'origin', 'main'], fixture.seed)
  return runProcess('git', ['rev-parse', 'HEAD'], fixture.seed)
}

async function loadSelfUpdate(options: {
  initializeBaseline?: boolean
} = {}): Promise<SelfUpdateModule> {
  vi.resetModules()
  vi.doMock('../src/lib/paths.js', () => ({
    CLAUDE_MEMORY_ROOT: fixture.storage,
    DEBUG_LOG_FILE: path.join(fixture.storage, 'debug.log'),
    LOCKS_DIR: path.join(fixture.storage, 'locks'),
    SELF_UPDATE_STATE_PATH: fixture.statePath,
    SELF_UPDATE_LOCK_PATH: fixture.lockPath,
    CLAUDE_SETTINGS_PATH: fixture.settingsPath,
    CLAUDE_CONFIG_PATH: path.join(fixture.storage, '.claude.json'),
    PROJECT_ROOT: fixture.root,
    canonicalizePath: canonicalize
  }))
  const selfUpdate = await import('../src/lib/self-update.js')
  if (options.initializeBaseline !== false) {
    initializeSuccessfulBaseline(selfUpdate, fixture.root)
  }
  return selfUpdate
}

function writeSuccessfulBuildStamp(
  selfUpdate: SelfUpdateModule,
  root: string
): ReturnType<SelfUpdateModule['inspectBuildState']> {
  const buildState = selfUpdate.inspectBuildState(root)
  writeFile(getBuildStampPath(root), JSON.stringify({
    commit: runProcess('git', ['rev-parse', 'HEAD'], root),
    builtAt: Date.now(),
    trigger: 'cli',
    node: process.version,
    sourceFingerprint: buildState.sourceFingerprint,
    installInputsFingerprint: buildState.installInputsFingerprint
  }, null, 2))
  return buildState
}

function initializeSuccessfulBaseline(selfUpdate: SelfUpdateModule, root: string): void {
  const buildState = writeSuccessfulBuildStamp(selfUpdate, root)
  let stateFile: {
    repositories?: Record<string, Record<string, unknown>>
    [key: string]: unknown
  } = {}
  if (fs.existsSync(fixture.statePath)) {
    stateFile = JSON.parse(fs.readFileSync(fixture.statePath, 'utf-8')) as typeof stateFile
  }
  const rootKey = canonicalize(root)
  const legacyState = stateFile.repositories ? {} : stateFile
  const repositories = stateFile.repositories ?? {}
  const existing = repositories[rootKey] ?? legacyState
  repositories[rootKey] = {
    ...existing,
    installedInputsFingerprint:
      existing.installedInputsFingerprint ?? buildState.installInputsFingerprint,
    history: Array.isArray(existing.history) ? existing.history : []
  }
  writeFile(fixture.statePath, JSON.stringify({ repositories }, null, 2))
}

function createRunner(
  selfUpdate: SelfUpdateModule,
  options: RunnerOptions = {}
): { runner: SelfUpdateCommandRunner; calls: CommandCall[] } {
  const calls: CommandCall[] = []
  let installFailuresRemaining = options.installFailures ?? 0
  const runner: SelfUpdateCommandRunner = (command, args, commandOptions) => {
    calls.push({ command, args: [...args] })
    if (command === 'git') {
      if (options.fetchFailure && args[0] === 'fetch') {
        return failureResult('simulated fetch failure')
      }
      if (options.mergeFailure && args[0] === 'merge') {
        return failureResult('simulated fast-forward failure')
      }
      if (args[0] === 'merge') options.onMerge?.()
      return selfUpdate.executeSelfUpdateCommand(command, args, commandOptions)
    }

    if (command === 'pnpm' && args[0] === 'install') {
      if (installFailuresRemaining > 0) {
        installFailuresRemaining -= 1
        return failureResult('simulated install failure')
      }
      return successResult()
    }

    if (command === 'pnpm' && args[0] === 'exec' && args[1] === 'tsc') {
      if (options.buildFailure) return failureResult('simulated TypeScript failure')
      const outputIndex = args.indexOf('--outDir')
      const outputDirectory = outputIndex >= 0 ? args[outputIndex + 1] : 'dist.next'
      const excluded = new Set(options.missingBuildArtifacts ?? [])
      for (const relativePath of REQUIRED_DIST_ARTIFACTS) {
        if (excluded.has(relativePath)) continue
        writeFile(
          path.join(commandOptions.cwd, outputDirectory, relativePath),
          `new build: ${relativePath}\n`
        )
      }
      options.onBuild?.(commandOptions.cwd)
      return successResult()
    }

    if (
      command === 'pnpm'
      && args.length === 2
      && args[0] === 'run'
      && args[1] === 'dashboard:build'
    ) {
      return successResult()
    }

    return failureResult(`unexpected command: ${command} ${args.join(' ')}`)
  }
  return { runner, calls }
}

function successResult(stdout: string = ''): SelfUpdateCommandResult {
  return { ok: true, stdout, stderr: '', exitCode: 0 }
}

function failureResult(stderr: string): SelfUpdateCommandResult {
  return { ok: false, stdout: '', stderr, exitCode: 1 }
}

function pnpmCalls(calls: CommandCall[]): CommandCall[] {
  return calls.filter(call => call.command === 'pnpm')
}

function gitCalls(calls: CommandCall[], operation: string): CommandCall[] {
  return calls.filter(call => call.command === 'git' && call.args[0] === operation)
}

function readState(root: string = fixture.root): Record<string, unknown> {
  const stateFile = JSON.parse(
    fs.readFileSync(fixture.statePath, 'utf-8')
  ) as { repositories?: Record<string, Record<string, unknown>> }
  return stateFile.repositories?.[canonicalize(root)] ?? {}
}

function readStateFile(): { repositories: Record<string, Record<string, unknown>> } {
  return JSON.parse(fs.readFileSync(fixture.statePath, 'utf-8')) as {
    repositories: Record<string, Record<string, unknown>>
  }
}

beforeEach(() => {
  originalAutoUpdate = process.env.CC_MEMORIES_SETTING_AUTO_UPDATE_INTERVAL_HOURS
  originalAutoRebuild = process.env.CC_MEMORIES_SETTING_AUTO_REBUILD_ENABLED
  process.env.CC_MEMORIES_SETTING_AUTO_UPDATE_INTERVAL_HOURS = '0'
  process.env.CC_MEMORIES_SETTING_AUTO_REBUILD_ENABLED = 'true'
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-memory-self-update-'))
  fixture = createGitFixture(tempDir)
})

afterEach(() => {
  if (originalAutoUpdate === undefined) {
    delete process.env.CC_MEMORIES_SETTING_AUTO_UPDATE_INTERVAL_HOURS
  } else {
    process.env.CC_MEMORIES_SETTING_AUTO_UPDATE_INTERVAL_HOURS = originalAutoUpdate
  }
  if (originalAutoRebuild === undefined) {
    delete process.env.CC_MEMORIES_SETTING_AUTO_REBUILD_ENABLED
  } else {
    process.env.CC_MEMORIES_SETTING_AUTO_REBUILD_ENABLED = originalAutoRebuild
  }
  vi.restoreAllMocks()
  vi.doUnmock('../src/lib/paths.js')
  vi.resetModules()
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
  tempDir = ''
})

describe('self-update freshness and build swapping', () => {
  it('requires all hook scripts, the detached worker, and the MCP entry point', () => {
    for (const script of Object.values(HOOK_SCRIPTS)) {
      expect(REQUIRED_DIST_ARTIFACTS)
        .toContain(getHookArtifactRelativePath(script))
    }
    expect(REQUIRED_DIST_ARTIFACTS).toContain(POST_SESSION_WORKER_ARTIFACT)
    expect(REQUIRED_DIST_ARTIFACTS).toContain(MCP_SERVER_SCRIPT)
  })

  it('detects a deleted source file from its persisted source fingerprint', async () => {
    const selfUpdate = await loadSelfUpdate()
    expect(selfUpdate.inspectBuildState(fixture.root).stale).toBe(false)

    fs.unlinkSync(path.join(fixture.root, 'src', 'index.ts'))

    const state = selfUpdate.inspectBuildState(fixture.root)
    expect(state.stale).toBe(true)
  })

  it('also detects deletion of an entire top-level source input', async () => {
    const selfUpdate = await loadSelfUpdate()
    expect(selfUpdate.inspectBuildState(fixture.root).stale).toBe(false)

    fs.rmSync(path.join(fixture.root, 'shared'), { recursive: true })

    expect(selfUpdate.inspectBuildState(fixture.root).stale).toBe(true)
  })

  it('detects source changes even when mtimes are restored to their old values', async () => {
    const selfUpdate = await loadSelfUpdate()
    const sourcePath = path.join(fixture.root, 'src', 'index.ts')
    const sourceDirectory = path.dirname(sourcePath)
    const fileTimes = fs.statSync(sourcePath)
    const directoryTimes = fs.statSync(sourceDirectory)

    writeFile(sourcePath, 'export const version = 999\n')
    fs.utimesSync(sourcePath, fileTimes.atime, fileTimes.mtime)
    fs.utimesSync(sourceDirectory, directoryTimes.atime, directoryTimes.mtime)

    expect(selfUpdate.inspectBuildState(fixture.root).stale).toBe(true)
  })

  it('rebuilds on an interval skip without advancing lastFetchAttemptAt', async () => {
    process.env.CC_MEMORIES_SETTING_AUTO_UPDATE_INTERVAL_HOURS = '24'
    const lastFetchAttemptAt = Date.now()
    writeFile(fixture.statePath, JSON.stringify({ lastFetchAttemptAt, history: [] }))
    const selfUpdate = await loadSelfUpdate()
    makeDistStale(fixture.root)
    const { runner, calls } = createRunner(selfUpdate)

    const result = selfUpdate.runSelfUpdate({ root: fixture.root, runner })

    expect(result.pull).toMatchObject({ status: 'interval', skipReason: 'interval' })
    expect(result.build.status).toBe('rebuilt')
    expect(gitCalls(calls, 'fetch')).toHaveLength(0)
    expect(readState().lastFetchAttemptAt).toBe(lastFetchAttemptAt)
  })

  it('keeps the old build and restores dist immediately when the second rename fails', async () => {
    const selfUpdate = await loadSelfUpdate()
    const { runner } = createRunner(selfUpdate)
    const originalRename = fs.renameSync.bind(fs)
    vi.spyOn(fs, 'renameSync').mockImplementation(((oldPath, newPath) => {
      if (
        path.basename(String(oldPath)) === 'dist.next'
        && path.basename(String(newPath)) === 'dist'
      ) {
        throw new Error('simulated second rename failure')
      }
      return originalRename(oldPath, newPath)
    }) as typeof fs.renameSync)

    const result = selfUpdate.runSelfUpdate({
      root: fixture.root,
      runner,
      forceRebuild: true
    })

    expect(result.build.status).toBe('failed')
    expect(result.build.error).toContain('simulated second rename failure')
    expect(readPrePrompt(fixture.root)).toBe(`old build: ${PRE_PROMPT_ARTIFACT}\n`)
    expect(fs.existsSync(path.join(fixture.root, 'dist.next'))).toBe(false)
    expect(fs.existsSync(path.join(fixture.root, 'dist.prev'))).toBe(false)
  })

  it('keeps the prior rollback artifact when the first swap rename fails', async () => {
    const selfUpdate = await loadSelfUpdate()
    writeRuntimeArtifacts(path.join(fixture.root, 'dist.prev'), 'prior rollback')
    const { runner } = createRunner(selfUpdate)
    const distPath = path.join(fixture.root, 'dist')
    const previousPath = path.join(fixture.root, 'dist.prev')
    const originalRename = fs.renameSync.bind(fs)
    vi.spyOn(fs, 'renameSync').mockImplementation(((oldPath, newPath) => {
      if (String(oldPath) === distPath && String(newPath) === previousPath) {
        throw new Error('simulated first rename failure')
      }
      return originalRename(oldPath, newPath)
    }) as typeof fs.renameSync)

    const result = selfUpdate.runSelfUpdate({
      root: fixture.root,
      runner,
      forceRebuild: true
    })

    expect(result.build.status).toBe('failed')
    expect(result.build.error).toContain('simulated first rename failure')
    expect(readPrePrompt(fixture.root)).toBe(`old build: ${PRE_PROMPT_ARTIFACT}\n`)
    expect(readPrePrompt(fixture.root, 'dist.prev'))
      .toBe(`prior rollback: ${PRE_PROMPT_ARTIFACT}\n`)
  })

  it.each(REQUIRED_ARTIFACT_CLASSES)(
    'rejects a staged build missing the %s artifact',
    async (_artifactClass, missingArtifact) => {
    const selfUpdate = await loadSelfUpdate()
    const { runner } = createRunner(selfUpdate, {
      missingBuildArtifacts: [missingArtifact]
    })

    const result = selfUpdate.runSelfUpdate({
      root: fixture.root,
      runner,
      forceRebuild: true
    })

    expect(result.build.status).toBe('failed')
    expect(result.build.error).toContain(missingArtifact)
    expect(readPrePrompt(fixture.root)).toBe(`old build: ${PRE_PROMPT_ARTIFACT}\n`)
    expect(fs.existsSync(path.join(fixture.root, 'dist.next'))).toBe(false)
    }
  )

  it('rejects staged output when source inputs change during compilation', async () => {
    const selfUpdate = await loadSelfUpdate()
    const { runner } = createRunner(selfUpdate, {
      onBuild: root => {
        writeFile(path.join(root, 'src', 'index.ts'), 'export const changedMidBuild = true\n')
      }
    })

    const result = selfUpdate.runSelfUpdate({
      root: fixture.root,
      runner,
      forceRebuild: true
    })

    expect(result.build.status).toBe('failed')
    expect(result.build.error).toContain('inputs changed during compilation')
    expect(readPrePrompt(fixture.root)).toBe(`old build: ${PRE_PROMPT_ARTIFACT}\n`)
    expect(fs.existsSync(path.join(fixture.root, 'dist.next'))).toBe(false)
  })

  it('repairs a missing dist from dist.prev even in dry-run mode', async () => {
    const selfUpdate = await loadSelfUpdate()
    const { runner, calls } = createRunner(selfUpdate)
    fs.renameSync(path.join(fixture.root, 'dist'), path.join(fixture.root, 'dist.prev'))

    const result = selfUpdate.runSelfUpdate({
      root: fixture.root,
      runner,
      dryRun: true
    })

    expect(result.recovery.restored).toBe(true)
    expect(fs.existsSync(path.join(fixture.root, 'dist'))).toBe(true)
    expect(fs.existsSync(path.join(fixture.root, 'dist.prev'))).toBe(false)
    expect(pnpmCalls(calls)).toHaveLength(0)
  })

  it('recovers both builds after a crash between the two swap renames', async () => {
    const selfUpdate = await loadSelfUpdate()
    const { runner, calls } = createRunner(selfUpdate)
    writeRuntimeArtifacts(path.join(fixture.root, 'dist.prev'), 'prior rollback')
    fs.renameSync(
      path.join(fixture.root, 'dist.prev'),
      path.join(fixture.root, 'dist.prev.saved')
    )
    fs.renameSync(
      path.join(fixture.root, 'dist'),
      path.join(fixture.root, 'dist.prev')
    )

    const result = selfUpdate.runSelfUpdate({
      root: fixture.root,
      runner,
      dryRun: true
    })

    expect(result.recovery.restored).toBe(true)
    expect(readPrePrompt(fixture.root)).toBe(`old build: ${PRE_PROMPT_ARTIFACT}\n`)
    expect(readPrePrompt(fixture.root, 'dist.prev'))
      .toBe(`prior rollback: ${PRE_PROMPT_ARTIFACT}\n`)
    expect(fs.existsSync(path.join(fixture.root, 'dist.prev.saved'))).toBe(false)
    expect(pnpmCalls(calls)).toHaveLength(0)
  })
})

describe('self-update pull behavior and guards', () => {
  it('fetches real remote state, fast-forwards, and always rebuilds after a pull', async () => {
    const remoteHead = advanceRemote()
    const selfUpdate = await loadSelfUpdate()
    const { runner, calls } = createRunner(selfUpdate)

    const result = selfUpdate.runSelfUpdate({
      root: fixture.root,
      runner,
      forcePull: true
    })

    expect(result.pull.status).toBe('pulled')
    expect(result.pull.behind).toBe(1)
    expect(result.build.status).toBe('rebuilt')
    expect(runProcess('git', ['rev-parse', 'HEAD'], fixture.root)).toBe(remoteHead)
    expect(gitCalls(calls, 'fetch')).toHaveLength(1)
    expect(gitCalls(calls, 'rev-list')).toHaveLength(1)
    expect(readPrePrompt(fixture.root)).toBe(`new build: ${PRE_PROMPT_ARTIFACT}\n`)
    expect(readPrePrompt(fixture.root, 'dist.prev'))
      .toBe(`old build: ${PRE_PROMPT_ARTIFACT}\n`)
  })

  it('rebuilds after a documentation-only pull', async () => {
    advanceRemoteFile('README.md', 'documentation-only update\n', 'documentation only')
    const selfUpdate = await loadSelfUpdate()
    let markerExistedBeforeMerge = false
    const { runner, calls } = createRunner(selfUpdate, {
      onMerge: () => {
        markerExistedBeforeMerge = readState().pendingBuild !== undefined
      }
    })

    const result = selfUpdate.runSelfUpdate({
      root: fixture.root,
      runner,
      forcePull: true
    })

    expect(result.pull.status).toBe('pulled')
    expect(result.dependencies.status).toBe('up-to-date')
    expect(result.build.status).toBe('rebuilt')
    expect(markerExistedBeforeMerge).toBe(true)
    expect(pnpmCalls(calls).filter(call => call.args[0] === 'exec')).toHaveLength(1)
  })

  it('installs and rebuilds after a lockfile-only pull', async () => {
    advanceRemoteFile(
      'pnpm-lock.yaml',
      "lockfileVersion: '9.1'\n",
      'lockfile only'
    )
    const selfUpdate = await loadSelfUpdate()
    const { runner, calls } = createRunner(selfUpdate)

    const result = selfUpdate.runSelfUpdate({
      root: fixture.root,
      runner,
      forcePull: true
    })

    expect(result.pull.status).toBe('pulled')
    expect(result.dependencies.status).toBe('success')
    expect(result.build.status).toBe('rebuilt')
    expect(pnpmCalls(calls).map(call => call.args[0])).toEqual(['install', 'exec'])
  })

  it('retries a failed install after a lockfile-only pull', async () => {
    advanceRemoteFile(
      'pnpm-lock.yaml',
      "lockfileVersion: '9.2'\n",
      'lockfile install retry'
    )
    const selfUpdate = await loadSelfUpdate()
    const failedRunner = createRunner(selfUpdate, { installFailures: 1 })

    const failed = selfUpdate.runSelfUpdate({
      root: fixture.root,
      runner: failedRunner.runner,
      forcePull: true
    })
    expect(failed.pull.status).toBe('pulled')
    expect(failed.dependencies.status).toBe('failed')
    expect(readState().pendingBuild).toEqual(expect.objectContaining({
      targetCommit: expect.any(String)
    }))

    const retryRunner = createRunner(selfUpdate)
    const retried = selfUpdate.runSelfUpdate({
      root: fixture.root,
      runner: retryRunner.runner
    })

    expect(retried.dependencies.status).toBe('success')
    expect(retried.build.status).toBe('rebuilt')
    expect(readState().pendingBuild).toBeUndefined()
  })

  it('retries a failed build after a documentation-only pull', async () => {
    advanceRemoteFile('README.md', 'pending documentation build\n', 'pending build')
    const selfUpdate = await loadSelfUpdate()
    const failedRunner = createRunner(selfUpdate, { buildFailure: true })

    const failed = selfUpdate.runSelfUpdate({
      root: fixture.root,
      runner: failedRunner.runner,
      forcePull: true
    })
    expect(failed.pull.status).toBe('pulled')
    expect(failed.build.status).toBe('failed')
    expect(readState().pendingBuild).toEqual(expect.objectContaining({
      targetCommit: expect.any(String)
    }))
    expect(selfUpdate.inspectBuildState(fixture.root).stale).toBe(false)

    const retryRunner = createRunner(selfUpdate)
    const retried = selfUpdate.runSelfUpdate({
      root: fixture.root,
      runner: retryRunner.runner
    })

    expect(retried.pull.status).toBe('up-to-date')
    expect(retried.build.status).toBe('rebuilt')
    expect(readState().pendingBuild).toBeUndefined()
  })

  it('advances lastFetchAttemptAt after a real fetch failure', async () => {
    const selfUpdate = await loadSelfUpdate()
    const { runner } = createRunner(selfUpdate, { fetchFailure: true })
    const before = Date.now()

    const result = selfUpdate.runSelfUpdate({
      root: fixture.root,
      runner,
      forcePull: true
    })

    expect(result.pull.status).toBe('fetch-failed')
    expect(result.status).toBe('failed')
    expect(readState().lastFetchAttemptAt).toEqual(expect.any(Number))
    expect(readState().lastFetchAttemptAt as number).toBeGreaterThanOrEqual(before)
  })

  it('does not advance the fetch timestamp for rebuild-only, but does after an up-to-date fetch', async () => {
    const selfUpdate = await loadSelfUpdate()
    const { runner, calls } = createRunner(selfUpdate)

    const rebuildOnly = selfUpdate.runSelfUpdate({
      root: fixture.root,
      runner,
      rebuildOnly: true
    })
    expect(rebuildOnly.pull.status).toBe('disabled')
    expect(readState().lastFetchAttemptAt).toBeUndefined()
    expect(gitCalls(calls, 'fetch')).toHaveLength(0)

    const fetched = selfUpdate.runSelfUpdate({
      root: fixture.root,
      runner,
      forcePull: true
    })
    expect(fetched.pull.status).toBe('up-to-date')
    expect(readState().lastFetchAttemptAt).toEqual(expect.any(Number))
    expect(gitCalls(calls, 'fetch')).toHaveLength(1)
  })

  it('refuses --pull when rebuilding is disabled', async () => {
    process.env.CC_MEMORIES_SETTING_AUTO_REBUILD_ENABLED = 'false'
    const selfUpdate = await loadSelfUpdate()
    const { runner, calls } = createRunner(selfUpdate)

    const result = selfUpdate.runSelfUpdate({
      root: fixture.root,
      runner,
      forcePull: true
    })

    expect(result.pull).toMatchObject({
      status: 'skipped',
      skipReason: 'rebuild-disabled'
    })
    expect(result.build.status).toBe('disabled')
    expect(gitCalls(calls, 'fetch')).toHaveLength(0)
  })

  it('does not let force bypass a dirty working-tree guard', async () => {
    const selfUpdate = await loadSelfUpdate()
    makeDistStale(fixture.root)
    const { runner, calls } = createRunner(selfUpdate)

    const result = selfUpdate.runSelfUpdate({
      root: fixture.root,
      runner,
      forcePull: true,
      forceRebuild: true
    })

    expect(result.pull.skipReason).toBe('dirty-tree')
    expect(result.build.status).toBe('rebuilt')
    expect(gitCalls(calls, 'fetch')).toHaveLength(0)
  })

  it('does not let force bypass local commits after the fetch refreshes the tracking ref', async () => {
    writeFile(path.join(fixture.root, 'src', 'index.ts'), 'export const local = true\n')
    runProcess('git', ['add', 'src/index.ts'], fixture.root)
    runProcess('git', ['commit', '-m', 'local'], fixture.root)
    const originalHead = runProcess('git', ['rev-parse', 'HEAD'], fixture.root)
    const selfUpdate = await loadSelfUpdate()
    const { runner, calls } = createRunner(selfUpdate)

    const result = selfUpdate.runSelfUpdate({
      root: fixture.root,
      runner,
      forcePull: true,
      forceRebuild: true
    })

    expect(result.pull).toMatchObject({
      status: 'skipped',
      skipReason: 'local-commits',
      ahead: 1
    })
    expect(result.build.status).toBe('rebuilt')
    expect(gitCalls(calls, 'fetch')).toHaveLength(1)
    expect(runProcess('git', ['rev-parse', 'HEAD'], fixture.root)).toBe(originalHead)
  })

  it('fails before building when a merge fails, preserves the marker, and resumes it later', async () => {
    const remoteHead = advanceRemote()
    const originalHead = runProcess('git', ['rev-parse', 'HEAD'], fixture.root)
    const selfUpdate = await loadSelfUpdate()
    const { runner, calls } = createRunner(selfUpdate, { mergeFailure: true })

    const result = selfUpdate.runSelfUpdate({
      root: fixture.root,
      runner,
      forcePull: true,
      forceRebuild: true
    })

    expect(result.pull).toMatchObject({
      status: 'failed',
      skipReason: 'not-fast-forwardable',
      ahead: 0,
      behind: 1
    })
    expect(result.status).toBe('failed')
    expect(result.build.status).not.toBe('rebuilt')
    expect(gitCalls(calls, 'merge')).toHaveLength(1)
    expect(pnpmCalls(calls).filter(call => call.args[0] === 'exec')).toHaveLength(0)
    expect(runProcess('git', ['rev-parse', 'HEAD'], fixture.root)).toBe(originalHead)
    expect(readState().pendingBuild).toEqual(expect.objectContaining({
      targetCommit: remoteHead
    }))

    const retryRunner = createRunner(selfUpdate)
    const retried = selfUpdate.runSelfUpdate({
      root: fixture.root,
      runner: retryRunner.runner
    })

    expect(retried.pull.status).toBe('pulled')
    expect(retried.build.status).toBe('rebuilt')
    expect(retried.status).toBe('completed')
    expect(runProcess('git', ['rev-parse', 'HEAD'], fixture.root)).toBe(remoteHead)
    expect(readState().pendingBuild).toBeUndefined()
  })

  it('requires the validated package root to be the exact git top-level', async () => {
    const nestedRoot = path.join(fixture.root, 'nested')
    writeFile(path.join(nestedRoot, 'package.json'), JSON.stringify({ name: 'claude-memory' }))
    writeFile(path.join(nestedRoot, 'tsconfig.json'), '{}')
    writeFile(path.join(nestedRoot, 'src', 'index.ts'), 'export {}\n')
    writeFile(path.join(nestedRoot, 'shared', 'types.d.ts'), 'export {}\n')
    writeFile(path.join(nestedRoot, 'dist', 'index.js'), 'export {}\n')
    makeDistFresh(nestedRoot)
    const selfUpdate = await loadSelfUpdate()
    const { runner, calls } = createRunner(selfUpdate)

    const result = selfUpdate.runSelfUpdate({
      root: nestedRoot,
      runner,
      forcePull: true
    })

    expect(result.pull.skipReason).toBe('git-root-mismatch')
    expect(gitCalls(calls, 'fetch')).toHaveLength(0)
  })

  it('restricts automatic pulls to the default branch tracking origin', async () => {
    runProcess('git', ['checkout', '-b', 'feature'], fixture.seed)
    runProcess('git', ['push', '--set-upstream', 'origin', 'feature'], fixture.seed)
    runProcess('git', ['fetch', 'origin', 'feature'], fixture.root)
    runProcess('git', ['checkout', '-b', 'feature', '--track', 'origin/feature'], fixture.root)
    const selfUpdate = await loadSelfUpdate()
    const automaticRunner = createRunner(selfUpdate)

    const automatic = selfUpdate.runSelfUpdate({
      root: fixture.root,
      runner: automaticRunner.runner,
      trigger: 'auto',
      forcePull: true
    })

    expect(automatic.pull).toMatchObject({
      status: 'skipped',
      skipReason: 'non-default-branch'
    })
    expect(gitCalls(automaticRunner.calls, 'fetch')).toHaveLength(0)

    const manualRunner = createRunner(selfUpdate)
    const manual = selfUpdate.runSelfUpdate({
      root: fixture.root,
      runner: manualRunner.runner,
      trigger: 'cli',
      forcePull: true
    })
    expect(manual.pull.status).toBe('up-to-date')
    expect(gitCalls(manualRunner.calls, 'fetch')).toHaveLength(1)
  })
})

describe('self-update state, reconciliation, and explicit operations', () => {
  it('migrates untouched flat legacy state without losing timestamps, history, hold, or fingerprints', async () => {
    const selfUpdate = await loadSelfUpdate({ initializeBaseline: false })
    const buildState = writeSuccessfulBuildStamp(selfUpdate, fixture.root)
    const lastFetchAttemptAt = 1_700_000_000_000
    const legacyHistoryEntry = {
      trigger: 'cli',
      status: 'skipped',
      startedAt: 10,
      completedAt: 20
    }
    writeFile(fixture.statePath, JSON.stringify({
      lastFetchAttemptAt,
      installedInputsFingerprint: buildState.installInputsFingerprint,
      heldSourceFingerprint: buildState.sourceFingerprint,
      history: [legacyHistoryEntry]
    }, null, 2))
    const { runner } = createRunner(selfUpdate)

    const result = selfUpdate.runSelfUpdate({
      root: fixture.root,
      runner,
      rebuildOnly: true
    })

    expect(result.hold).toMatchObject({
      active: true,
      fingerprint: buildState.sourceFingerprint
    })
    const migrated = readState()
    expect(migrated.lastFetchAttemptAt).toBe(lastFetchAttemptAt)
    expect(migrated.installedInputsFingerprint)
      .toBe(buildState.installInputsFingerprint)
    expect(migrated.heldSourceFingerprint).toBe(buildState.sourceFingerprint)
    expect((migrated.history as unknown[])[0]).toEqual(legacyHistoryEntry)
    expect(readStateFile().repositories).toHaveProperty(canonicalize(fixture.root))
  })

  it('retries a failed dependency install and includes the workspace manifest in its baseline', async () => {
    const selfUpdate = await loadSelfUpdate()
    writeFile(path.join(fixture.root, 'pnpm-lock.yaml'), "lockfileVersion: '9.1'\n")
    const firstRunner = createRunner(selfUpdate, { installFailures: 1 })

    const failed = selfUpdate.runSelfUpdate({
      root: fixture.root,
      runner: firstRunner.runner
    })
    expect(failed.dependencies.status).toBe('failed')
    expect(failed.build.status).not.toBe('rebuilt')

    const retryRunner = createRunner(selfUpdate)
    const retried = selfUpdate.runSelfUpdate({
      root: fixture.root,
      runner: retryRunner.runner
    })
    expect(retried.dependencies.status).toBe('success')
    expect(retried.build.status).toBe('rebuilt')
    expect(pnpmCalls(retryRunner.calls).filter(call => call.args[0] === 'install')).toHaveLength(1)

    const baselineRunner = createRunner(selfUpdate)
    const baseline = selfUpdate.runSelfUpdate({
      root: fixture.root,
      runner: baselineRunner.runner
    })
    expect(baseline.dependencies.status).toBe('not-needed')
    expect(pnpmCalls(baselineRunner.calls).filter(call => call.args[0] === 'install')).toHaveLength(0)

    writeFile(path.join(fixture.root, 'pnpm-workspace.yaml'), 'packages:\n  - dashboard\n')
    const workspaceRunner = createRunner(selfUpdate)
    const workspaceChanged = selfUpdate.runSelfUpdate({
      root: fixture.root,
      runner: workspaceRunner.runner
    })
    expect(workspaceChanged.dependencies.status).toBe('success')
    expect(pnpmCalls(workspaceRunner.calls).filter(call => call.args[0] === 'install')).toHaveLength(1)
  })

  it('repairs genuinely missing registrations while preserving a modified slash command', async () => {
    const selfUpdate = await loadSelfUpdate()
    const { runner } = createRunner(selfUpdate)
    selfUpdate.runSelfUpdate({ root: fixture.root, runner })

    const commandsDirectory = path.join(path.dirname(fixture.settingsPath), 'commands')
    const modifiedCommand = path.join(commandsDirectory, 'prior-knowledge.md')
    const missingCommand = path.join(commandsDirectory, 'skip-extraction.md')
    const untouchedCommand = path.join(commandsDirectory, 'remember.md')
    const untouchedCommandTime = new Date('2000-01-01T00:00:00.000Z')
    fs.utimesSync(untouchedCommand, untouchedCommandTime, untouchedCommandTime)
    writeFile(modifiedCommand, 'deliberate user edit\n')
    fs.unlinkSync(missingCommand)
    const settings = JSON.parse(fs.readFileSync(fixture.settingsPath, 'utf-8')) as {
      hooks: Record<string, Array<{ hooks?: Array<{ timeout?: number }> }>>
    }
    const userPromptHook = settings.hooks.UserPromptSubmit?.[0]?.hooks?.[0]
    if (!userPromptHook) throw new Error('fixture is missing UserPromptSubmit hook')
    userPromptHook.timeout = 99
    delete settings.hooks.PreCompact
    writeFile(fixture.settingsPath, JSON.stringify(settings, null, 2))

    const result = selfUpdate.runSelfUpdate({ root: fixture.root, runner })

    expect(result.reconciliation.status).toBe('success')
    expect(result.reconciliation.installedHooks).toContain('PreCompact')
    expect(result.reconciliation.installedCommands).toContain('skip-extraction')
    expect(result.reconciliation.modifiedCommands).toContain('prior-knowledge')
    expect(fs.readFileSync(modifiedCommand, 'utf-8')).toBe('deliberate user edit\n')
    expect(fs.existsSync(missingCommand)).toBe(true)
    expect(fs.statSync(untouchedCommand).mtimeMs).toBe(untouchedCommandTime.getTime())
    const repairedSettings = JSON.parse(fs.readFileSync(fixture.settingsPath, 'utf-8')) as {
      hooks: Record<string, Array<{ hooks?: Array<{ timeout?: number }> }>>
    }
    expect(repairedSettings.hooks.UserPromptSubmit?.[0]?.hooks?.[0]?.timeout).toBe(99)
  })

  it('writes Claude settings through a same-directory atomic rename', async () => {
    const selfUpdate = await loadSelfUpdate()
    const { runner } = createRunner(selfUpdate)
    const renameCalls: Array<[string, string]> = []
    const originalRename = fs.renameSync.bind(fs)
    vi.spyOn(fs, 'renameSync').mockImplementation(((oldPath, newPath) => {
      if (String(newPath) === fixture.settingsPath) {
        renameCalls.push([String(oldPath), String(newPath)])
      }
      return originalRename(oldPath, newPath)
    }) as typeof fs.renameSync)

    const result = selfUpdate.runSelfUpdate({
      root: fixture.root,
      runner,
      rebuildOnly: true
    })

    expect(result.reconciliation.status).toBe('success')
    expect(renameCalls).toHaveLength(1)
    expect(path.dirname(renameCalls[0][0])).toBe(path.dirname(fixture.settingsPath))
    expect(path.basename(renameCalls[0][0])).toMatch(/^\.settings\.json\..+\.tmp$/)
  })

  it('preserves a symlinked Claude settings file while atomically replacing its target', async () => {
    const targetPath = path.join(fixture.storage, 'dotfiles', 'claude-settings.json')
    writeFile(targetPath, '{}\n')
    fs.mkdirSync(path.dirname(fixture.settingsPath), { recursive: true })
    fs.symlinkSync(targetPath, fixture.settingsPath)
    const originalLink = fs.readlinkSync(fixture.settingsPath)
    const selfUpdate = await loadSelfUpdate()
    const { runner } = createRunner(selfUpdate)

    const result = selfUpdate.runSelfUpdate({
      root: fixture.root,
      runner,
      rebuildOnly: true
    })

    expect(result.reconciliation.status).toBe('success')
    expect(fs.lstatSync(fixture.settingsPath).isSymbolicLink()).toBe(true)
    expect(fs.readlinkSync(fixture.settingsPath)).toBe(originalLink)
    const targetSettings = JSON.parse(fs.readFileSync(targetPath, 'utf-8')) as {
      hooks?: Record<string, unknown>
    }
    expect(Object.keys(targetSettings.hooks ?? {}).sort()).toEqual(
      Object.keys(HOOK_SCRIPTS).sort()
    )
  })

  it('preserves a dangling Claude settings symlink and creates its target', async () => {
    const targetPath = path.join(fixture.storage, 'dotfiles', 'claude-settings.json')
    fs.mkdirSync(path.dirname(fixture.settingsPath), { recursive: true })
    fs.symlinkSync(targetPath, fixture.settingsPath)
    const originalLink = fs.readlinkSync(fixture.settingsPath)
    expect(fs.existsSync(targetPath)).toBe(false)
    const selfUpdate = await loadSelfUpdate()
    const { runner } = createRunner(selfUpdate)

    const result = selfUpdate.runSelfUpdate({
      root: fixture.root,
      runner,
      rebuildOnly: true
    })

    expect(result.reconciliation.status).toBe('success')
    expect(fs.lstatSync(fixture.settingsPath).isSymbolicLink()).toBe(true)
    expect(fs.readlinkSync(fixture.settingsPath)).toBe(originalLink)
    const targetSettings = JSON.parse(fs.readFileSync(targetPath, 'utf-8')) as {
      hooks?: Record<string, unknown>
    }
    expect(Object.keys(targetSettings.hooks ?? {}).sort()).toEqual(
      Object.keys(HOOK_SCRIPTS).sort()
    )
  })

  it('refuses to replace an existing read-only Claude settings file', async () => {
    const originalSettings = '{}\n'
    writeFile(fixture.settingsPath, originalSettings)
    fs.chmodSync(fixture.settingsPath, 0o444)
    const selfUpdate = await loadSelfUpdate()
    const { runner } = createRunner(selfUpdate)

    const result = selfUpdate.runSelfUpdate({
      root: fixture.root,
      runner,
      rebuildOnly: true
    })

    expect(result.status).toBe('failed')
    expect(result.reconciliation.status).toBe('failed')
    expect(result.reconciliation.error).toMatch(/EACCES|permission denied/i)
    expect(fs.readFileSync(fixture.settingsPath, 'utf-8')).toBe(originalSettings)
    expect(fs.statSync(fixture.settingsPath).mode & 0o777).toBe(0o444)
  })

  it('reapplies the existing settings mode independently of umask', async () => {
    writeFile(fixture.settingsPath, '{}\n')
    fs.chmodSync(fixture.settingsPath, 0o640)
    const selfUpdate = await loadSelfUpdate()
    const { runner } = createRunner(selfUpdate)
    const originalUmask = process.umask(0o077)
    try {
      const result = selfUpdate.runSelfUpdate({
        root: fixture.root,
        runner,
        rebuildOnly: true
      })
      expect(result.reconciliation.status).toBe('success')
    } finally {
      process.umask(originalUmask)
    }

    expect(fs.statSync(fixture.settingsPath).mode & 0o777).toBe(0o640)
  })

  it('reports foreign-checkout hooks as a conflict and leaves settings untouched', async () => {
    const foreignRoot = path.join(tempDir, 'foreign-checkout')
    const hooks = Object.fromEntries(
      Object.entries(HOOK_SCRIPTS).map(([event, script]) => [
        event,
        [{
          hooks: [{
            type: 'command',
            command: `node "${getHookScriptPath(foreignRoot, script)}"`,
            timeout: 15
          }]
        }]
      ])
    )
    const originalSettings = `${JSON.stringify({ hooks }, null, 2)}\n`
    writeFile(fixture.settingsPath, originalSettings)
    const selfUpdate = await loadSelfUpdate()
    const { runner } = createRunner(selfUpdate)

    const result = selfUpdate.runSelfUpdate({
      root: fixture.root,
      runner,
      rebuildOnly: true
    })

    expect(result.reconciliation).toMatchObject({
      status: 'conflict',
      conflictingHookRoots: [canonicalize(foreignRoot)],
      installedHooks: [],
      installedCommands: []
    })
    expect(fs.readFileSync(fixture.settingsPath, 'utf-8')).toBe(originalSettings)
    expect(
      fs.existsSync(path.join(path.dirname(fixture.settingsPath), 'commands'))
    ).toBe(false)
  })

  it('holds a rolled-back build until source changes', async () => {
    const sourceTime = new Date(Date.now() - 20_000)
    for (const sourcePath of sourceInputPaths(fixture.root)) {
      setTreeMtime(sourcePath, sourceTime)
    }
    writeRuntimeArtifacts(path.join(fixture.root, 'dist.prev'), 'previous build')
    setTreeMtime(path.join(fixture.root, 'dist.prev'), new Date(Date.now() - 60_000))
    setTreeMtime(path.join(fixture.root, 'dist'), new Date(Date.now() - 10_000))
    const selfUpdate = await loadSelfUpdate()
    const { runner, calls } = createRunner(selfUpdate)

    const rolledBack = selfUpdate.runSelfUpdate({
      root: fixture.root,
      runner,
      rollback: true
    })
    expect(rolledBack.rollback?.status).toBe('rolled-back')
    expect(rolledBack.hold.active).toBe(true)

    const held = selfUpdate.runSelfUpdate({ root: fixture.root, runner })
    expect(held.build.status).toBe('held')
    expect(held.hold.active).toBe(true)
    expect(pnpmCalls(calls).filter(call => call.args[0] === 'exec')).toHaveLength(0)

    writeFile(path.join(fixture.root, 'src', 'index.ts'), 'export const changed = true\n')
    const resumed = selfUpdate.runSelfUpdate({ root: fixture.root, runner })
    expect(resumed.hold.cleared).toBe(true)
    expect(resumed.build.status).toBe('rebuilt')
  })

  it('clears a rollback hold explicitly without running a build', async () => {
    writeRuntimeArtifacts(path.join(fixture.root, 'dist.prev'), 'previous build')
    const selfUpdate = await loadSelfUpdate()
    const { runner, calls } = createRunner(selfUpdate)
    selfUpdate.runSelfUpdate({ root: fixture.root, runner, rollback: true })

    const result = selfUpdate.runSelfUpdate({
      root: fixture.root,
      runner,
      clearHold: true
    })

    expect(result.hold.cleared).toBe(true)
    expect(result.hold.active).toBe(false)
    expect(readState().heldSourceFingerprint).toBeUndefined()
    expect(pnpmCalls(calls)).toHaveLength(0)
  })

  it('persists a rollback hold before swapping and clears it when the swap fails', async () => {
    writeRuntimeArtifacts(path.join(fixture.root, 'dist.prev'), 'previous build')
    const selfUpdate = await loadSelfUpdate()
    const { runner } = createRunner(selfUpdate)
    const distPath = path.join(fixture.root, 'dist')
    const stagingPath = path.join(fixture.root, 'dist.next')
    let holdExistedBeforeRename = false
    const originalRename = fs.renameSync.bind(fs)
    vi.spyOn(fs, 'renameSync').mockImplementation(((oldPath, newPath) => {
      if (String(oldPath) === distPath && String(newPath) === stagingPath) {
        holdExistedBeforeRename =
          typeof readState().heldSourceFingerprint === 'string'
        throw new Error('simulated rollback rename failure')
      }
      return originalRename(oldPath, newPath)
    }) as typeof fs.renameSync)

    const result = selfUpdate.runSelfUpdate({
      root: fixture.root,
      runner,
      rollback: true
    })

    expect(result.rollback?.status).toBe('failed')
    expect(holdExistedBeforeRename).toBe(true)
    expect(readState().heldSourceFingerprint).toBeUndefined()
  })

  it('does not let a pull or force bypass an unchanged rollback hold', async () => {
    writeRuntimeArtifacts(path.join(fixture.root, 'dist.prev'), 'previous build')
    const selfUpdate = await loadSelfUpdate()
    const { runner } = createRunner(selfUpdate)
    selfUpdate.runSelfUpdate({ root: fixture.root, runner, rollback: true })

    writeFile(path.join(fixture.seed, 'README.md'), 'documentation-only update\n')
    runProcess('git', ['add', 'README.md'], fixture.seed)
    runProcess('git', ['commit', '-m', 'documentation only'], fixture.seed)
    runProcess('git', ['push', 'origin', 'main'], fixture.seed)

    const result = selfUpdate.runSelfUpdate({
      root: fixture.root,
      runner,
      forcePull: true,
      forceRebuild: true
    })

    expect(result.pull).toMatchObject({
      status: 'skipped',
      skipReason: 'rollback-hold'
    })
    expect(result.hold.cleared).toBe(false)
    expect(result.hold.active).toBe(true)
    expect(result.build.status).toBe('held')
    expect(readState().heldSourceFingerprint).toEqual(expect.any(String))
  })

  it('uses one shared lock for all callers', async () => {
    writeFile(fixture.lockPath, `${process.pid}\n${Date.now()}`)
    const selfUpdate = await loadSelfUpdate()
    const { runner, calls } = createRunner(selfUpdate)

    const result = selfUpdate.runSelfUpdate({ root: fixture.root, runner })

    expect(result.status).toBe('skipped')
    expect(result.pull.skipReason).toBe('locked')
    expect(calls).toHaveLength(0)
  })

  it('namespaces fetch and build state by canonical checkout root', async () => {
    process.env.CC_MEMORIES_SETTING_AUTO_UPDATE_INTERVAL_HOURS = '24'
    const secondRoot = path.join(tempDir, 'checkout-two')
    runProcess('git', ['clone', fixture.remote, secondRoot])
    runProcess('git', ['config', 'user.name', 'Self Update Test'], secondRoot)
    runProcess('git', ['config', 'user.email', 'self-update@example.test'], secondRoot)
    writeRuntimeArtifacts(path.join(secondRoot, 'dist'), 'second build')
    makeDistFresh(secondRoot)
    const selfUpdate = await loadSelfUpdate()
    initializeSuccessfulBaseline(selfUpdate, secondRoot)

    const firstRunner = createRunner(selfUpdate)
    const first = selfUpdate.runSelfUpdate({
      root: fixture.root,
      runner: firstRunner.runner,
      forcePull: true
    })
    expect(first.pull.status).toBe('up-to-date')

    const secondRunner = createRunner(selfUpdate)
    const second = selfUpdate.runSelfUpdate({
      root: secondRoot,
      runner: secondRunner.runner
    })
    expect(second.pull.status).toBe('up-to-date')
    expect(gitCalls(secondRunner.calls, 'fetch')).toHaveLength(1)

    const stateFile = readStateFile()
    expect(Object.keys(stateFile.repositories).sort()).toEqual([
      canonicalize(fixture.root),
      canonicalize(secondRoot)
    ].sort())
    expect(readState(fixture.root).lastFetchAttemptAt).toEqual(expect.any(Number))
    expect(readState(secondRoot).lastFetchAttemptAt).toEqual(expect.any(Number))
  })

  it('builds the dashboard only when explicitly requested and without an install predicate', async () => {
    const selfUpdate = await loadSelfUpdate()
    const firstRunner = createRunner(selfUpdate)
    const automatic = selfUpdate.runSelfUpdate({
      root: fixture.root,
      runner: firstRunner.runner
    })
    expect(automatic.dashboard.status).toBe('not-needed')
    expect(pnpmCalls(firstRunner.calls)).toHaveLength(0)

    const dashboardRunner = createRunner(selfUpdate)
    const explicit = selfUpdate.runSelfUpdate({
      root: fixture.root,
      runner: dashboardRunner.runner,
      buildDashboard: true
    })
    expect(explicit.dashboard.status).toBe('success')
    expect(pnpmCalls(dashboardRunner.calls)).toEqual([
      { command: 'pnpm', args: ['run', 'dashboard:build'] }
    ])
  })
})
