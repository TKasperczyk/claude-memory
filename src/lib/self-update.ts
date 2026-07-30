import fs from 'fs'
import { spawnSync } from 'child_process'
import { createHash } from 'crypto'
import path from 'path'
import { findGitRoot } from './context.js'
import {
  getRegisteredClaudeMemoryHookRoots,
  getInstallationStatus,
  installCommands,
  installHooks,
  type HookEvent
} from './installer.js'
import { readJsonFile, readJsonFileSafe, writeJsonFile } from './json.js'
import { acquireFileLock } from './lock.js'
import { createLogger } from './logger.js'
import { asInteger, asString, isPlainObject } from './parsing.js'
import {
  canonicalizePath,
  CLAUDE_SETTINGS_PATH,
  PROJECT_ROOT,
  SELF_UPDATE_LOCK_PATH,
  SELF_UPDATE_STATE_PATH
} from './paths.js'
import { loadSettings } from './settings.js'
import {
  DIST_DIRECTORY,
  getBuildStampPath,
  getDistPath,
  getMissingDistArtifacts
} from './runtime-artifacts.js'
import { truncateWithTail } from './shared.js'
import { toErrorMessage } from './maintenance/runners/shared.js'

const logger = createLogger('self-update')

const STATE_HISTORY_LIMIT = 20
const LOCK_STALE_MS = 15 * 60 * 1000
const GIT_TIMEOUT_MS = 60_000
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000
const COMMAND_MAX_BUFFER_BYTES = 10 * 1024 * 1024
const COMMAND_ERROR_MAX_CHARS = 8_000
const COMMAND_ERROR_TAIL_CHARS = 2_000

const STAGING_DIST_DIRECTORY = 'dist.next'
const PREVIOUS_DIST_DIRECTORY = 'dist.prev'
const SAVED_PREVIOUS_DIST_DIRECTORY = 'dist.prev.saved'
const SOURCE_INPUTS = ['src', 'shared', 'tsconfig.json', 'package.json'] as const
const INSTALL_FIXED_INPUTS = ['pnpm-lock.yaml', 'pnpm-workspace.yaml'] as const
const INSTALL_WALK_EXCLUDED_DIRECTORIES = new Set([
  '.git',
  '.pnpm-store',
  'node_modules',
  DIST_DIRECTORY,
  STAGING_DIST_DIRECTORY,
  PREVIOUS_DIST_DIRECTORY,
  SAVED_PREVIOUS_DIST_DIRECTORY
])

export type SelfUpdateTrigger = 'auto' | 'cli'

export type SelfUpdateSkipReason =
  | 'locked'
  | 'disabled'
  | 'interval'
  | 'rebuild-disabled'
  | 'no-git'
  | 'git-root-mismatch'
  | 'detached-head'
  | 'no-upstream'
  | 'dirty-tree'
  | 'local-commits'
  | 'not-fast-forwardable'
  | 'non-default-branch'
  | 'rollback-hold'
  | 'no-previous-build'

export type SelfUpdateCommandOptions = {
  cwd: string
  timeoutMs: number
  env?: NodeJS.ProcessEnv
}

export type SelfUpdateCommandResult = {
  ok: boolean
  stdout: string
  stderr: string
  exitCode: number | null
  error?: string
}

export type SelfUpdateCommandRunner = (
  command: string,
  args: string[],
  options: SelfUpdateCommandOptions
) => SelfUpdateCommandResult

type SelfUpdatePhaseStatus =
  | 'not-needed'
  | 'disabled'
  | 'interval'
  | 'skipped'
  | 'up-to-date'
  | 'would-run'
  | 'success'
  | 'conflict'
  | 'failed'

export type SelfUpdateResult = {
  trigger: SelfUpdateTrigger
  startedAt: number
  completedAt: number
  root: string
  status: 'completed' | 'skipped' | 'failed'
  recovery: {
    restored: boolean
    error?: string
  }
  reconciliation: {
    status: SelfUpdatePhaseStatus
    missingHooks: HookEvent[]
    installedHooks: HookEvent[]
    missingCommands: string[]
    installedCommands: string[]
    modifiedCommands: string[]
    conflictingHookRoots: string[]
    error?: string
  }
  pull: {
    status: SelfUpdatePhaseStatus | 'fetch-failed' | 'pulled'
    skipReason?: SelfUpdateSkipReason
    ahead?: number
    behind?: number
    fromCommit?: string
    toCommit?: string
    error?: string
  }
  dependencies: {
    status: SelfUpdatePhaseStatus
    error?: string
  }
  build: {
    status: SelfUpdatePhaseStatus | 'held' | 'rebuilt'
    stale: boolean
    forced: boolean
    sourceFingerprint?: string
    error?: string
  }
  dashboard: {
    status: SelfUpdatePhaseStatus
    error?: string
  }
  rollback?: {
    status: SelfUpdatePhaseStatus | 'rolled-back'
    skipReason?: SelfUpdateSkipReason
    error?: string
  }
  hold: {
    active: boolean
    cleared: boolean
    fingerprint?: string
  }
  error?: string
}

export type SelfUpdateOptions = {
  trigger?: SelfUpdateTrigger
  root?: string
  dryRun?: boolean
  rebuildOnly?: boolean
  forcePull?: boolean
  forceRebuild?: boolean
  rollback?: boolean
  clearHold?: boolean
  buildDashboard?: boolean
  runner?: SelfUpdateCommandRunner
}

export type BuildState = {
  stale: boolean
  sourceFingerprint: string
  installInputsFingerprint: string
}

export type RollbackBuildResult = {
  status: 'would-run' | 'rolled-back' | 'skipped' | 'failed'
  skipReason?: SelfUpdateSkipReason
  error?: string
}

type SelfUpdateState = {
  lastFetchAttemptAt?: number
  installedInputsFingerprint?: string
  heldSourceFingerprint?: string
  pendingBuild?: {
    targetCommit: string
    createdAt: number
  }
  history: SelfUpdateResult[]
}

type SelfUpdateStateFile = {
  repositories: Record<string, SelfUpdateState>
}

type BuildStamp = {
  commit: string | null
  builtAt: number
  trigger: SelfUpdateTrigger
  node: string
  sourceFingerprint: string
  installInputsFingerprint: string
}

type TreeEntry = {
  absolutePath: string
  relativePath: string
  kind: 'directory' | 'file' | 'symlink'
}

type SourceState = {
  missingInput: boolean
  fingerprint: string
}

type GitContext = {
  branch: string
  upstream: string
  remote: string
  remoteBranch: string
  head: string
}

type RecoveryResult = {
  restored: boolean
  error?: string
}

type SwapResult = {
  ok: boolean
  error?: string
}

export function executeSelfUpdateCommand(
  command: string,
  args: string[],
  options: SelfUpdateCommandOptions
): SelfUpdateCommandResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf-8',
    timeout: options.timeoutMs,
    maxBuffer: COMMAND_MAX_BUFFER_BYTES,
    stdio: ['ignore', 'pipe', 'pipe']
  })

  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  const error = result.error instanceof Error ? result.error.message : undefined
  return {
    ok: !result.error && result.status === 0,
    stdout,
    stderr,
    exitCode: result.status,
    ...(error ? { error } : {})
  }
}

export function inspectBuildState(root: string): BuildState {
  const validatedRoot = validatePackageRoot(root)
  const sourceState = inspectSourceState(validatedRoot)
  const distPath = getDistPath(validatedRoot)
  const installInputsFingerprint = computeInstallInputsFingerprint(validatedRoot)
  const buildStamp = loadBuildStamp(validatedRoot)
  const missingDistArtifacts = getMissingDistArtifacts(validatedRoot)

  return {
    stale: sourceState.missingInput
      || !fs.existsSync(distPath)
      || missingDistArtifacts.length > 0
      || buildStamp === null
      || buildStamp.sourceFingerprint !== sourceState.fingerprint
      || buildStamp.installInputsFingerprint !== installInputsFingerprint,
    sourceFingerprint: sourceState.fingerprint,
    installInputsFingerprint
  }
}

export function rollbackBuild(root: string, dryRun: boolean = false): RollbackBuildResult {
  const validatedRoot = validatePackageRoot(root)
  const distPath = getDistPath(validatedRoot)
  const previousPath = getDistPath(validatedRoot, PREVIOUS_DIST_DIRECTORY)
  const stagingPath = getDistPath(validatedRoot, STAGING_DIST_DIRECTORY)

  if (!fs.existsSync(previousPath)) {
    return { status: 'skipped', skipReason: 'no-previous-build' }
  }
  if (dryRun) return { status: 'would-run' }

  if (!fs.existsSync(distPath)) {
    try {
      fs.renameSync(previousPath, distPath)
      return { status: 'rolled-back' }
    } catch (error) {
      return { status: 'failed', error: toErrorMessage(error) }
    }
  }

  try {
    fs.rmSync(stagingPath, { recursive: true, force: true })
  } catch (error) {
    return { status: 'failed', error: toErrorMessage(error) }
  }
  let movedCurrent = false
  let installedPrevious = false
  try {
    fs.renameSync(distPath, stagingPath)
    movedCurrent = true
    fs.renameSync(previousPath, distPath)
    installedPrevious = true
    fs.renameSync(stagingPath, previousPath)
    return { status: 'rolled-back' }
  } catch (error) {
    const originalError = toErrorMessage(error)
    try {
      if (installedPrevious && fs.existsSync(distPath) && !fs.existsSync(previousPath)) {
        fs.renameSync(distPath, previousPath)
      }
      if (movedCurrent && fs.existsSync(stagingPath) && !fs.existsSync(distPath)) {
        fs.renameSync(stagingPath, distPath)
      }
    } catch (restoreError) {
      return {
        status: 'failed',
        error: `${originalError}; failed to restore original build: ${toErrorMessage(restoreError)}`
      }
    }
    return { status: 'failed', error: originalError }
  }
}

export function runSelfUpdate(options: SelfUpdateOptions = {}): SelfUpdateResult {
  const trigger = options.trigger ?? 'cli'
  const startedAt = Date.now()
  const requestedRoot = options.root ?? PROJECT_ROOT
  let root: string
  try {
    root = validatePackageRoot(requestedRoot)
  } catch (error) {
    return failedResult(trigger, startedAt, path.resolve(requestedRoot), toErrorMessage(error))
  }

  const runner = options.runner ?? executeSelfUpdateCommand
  const dryRun = options.dryRun ?? false
  const result = createResult(trigger, startedAt, root)
  let lockHandle: ReturnType<typeof acquireFileLock>
  try {
    lockHandle = acquireFileLock(SELF_UPDATE_LOCK_PATH, {
      staleAfterMs: LOCK_STALE_MS,
      staleStrategy: 'pid',
      ensureDir: true,
      proceedOnError: false,
      write: { data: () => `${process.pid}\n${Date.now()}` }
    })
  } catch (error) {
    result.status = 'failed'
    result.error = `Failed to acquire self-update lock: ${toErrorMessage(error)}`
    result.completedAt = Date.now()
    return result
  }

  if (!lockHandle) {
    result.status = 'skipped'
    result.pull.status = 'skipped'
    result.pull.skipReason = 'locked'
    result.completedAt = Date.now()
    return result
  }

  const state = loadSelfUpdateState(root)
  try {
    result.recovery = recoverMissingBuild(root)
    if (result.recovery.error) {
      result.status = 'failed'
      result.error = result.recovery.error
      return finishResult(result, root, state, dryRun)
    }

    result.reconciliation = reconcileInstallation(root, dryRun)

    let buildState = inspectBuildState(root)
    applyBuildState(result, buildState, options.forceRebuild ?? false)
    resolveRollbackHold(result, state, buildState.sourceFingerprint, dryRun)

    if (options.clearHold) {
      if (state.heldSourceFingerprint) {
        result.hold.active = true
        result.hold.fingerprint = state.heldSourceFingerprint
        if (!dryRun) {
          delete state.heldSourceFingerprint
          result.hold.active = false
          result.hold.cleared = true
        }
      }
      return finishResult(result, root, state, dryRun)
    }

    if (options.rollback) {
      resolveRollbackHold(result, state, buildState.sourceFingerprint, dryRun)
      const rollbackCanRun = result.recovery.restored
        || fs.existsSync(getDistPath(root, PREVIOUS_DIST_DIRECTORY))
      if (!dryRun && rollbackCanRun) {
        state.heldSourceFingerprint = buildState.sourceFingerprint
        result.hold.active = true
        result.hold.fingerprint = buildState.sourceFingerprint
        saveSelfUpdateState(root, state)
      }
      const rollback = result.recovery.restored
        ? { status: 'rolled-back' as const }
        : rollbackBuild(root, dryRun)
      result.rollback = rollback
      if (rollback.status === 'rolled-back') {
        result.hold.active = true
        result.hold.fingerprint = buildState.sourceFingerprint
      } else if (rollback.status === 'failed' || rollback.status === 'skipped') {
        if (rollback.status === 'failed') result.status = 'failed'
        if (!dryRun) {
          delete state.heldSourceFingerprint
          result.hold.active = false
          saveSelfUpdateState(root, state)
        }
      }
      return finishResult(result, root, state, dryRun)
    }

    const settings = loadSettings()
    result.pull = runPullPhase({
      root,
      runner,
      state,
      dryRun,
      trigger,
      rollbackHoldActive: result.hold.active,
      rebuildOnly: options.rebuildOnly ?? false,
      forcePull: options.forcePull ?? false,
      autoRebuildEnabled: settings.autoRebuildEnabled,
      intervalHours: settings.autoUpdateIntervalHours
    })

    if (result.pull.status === 'failed') {
      result.status = 'failed'
      return finishResult(result, root, state, dryRun)
    }

    buildState = inspectBuildState(root)
    applyBuildState(result, buildState, options.forceRebuild ?? false)
    resolveRollbackHold(result, state, buildState.sourceFingerprint, dryRun)

    const pulled = result.pull.status === 'pulled'
    const forceRebuild = options.forceRebuild ?? false
    const dependencyDrift =
      state.installedInputsFingerprint !== buildState.installInputsFingerprint
    const pendingBuild = state.pendingBuild
    const holdBlocksBuild = result.hold.active
    const rebuildEnabled = settings.autoRebuildEnabled || forceRebuild || pulled
    if (
      !dryRun
      && pendingBuild
      && rebuildEnabled
      && !revisionContainsTarget(root, runner, 'HEAD', pendingBuild.targetCommit)
    ) {
      result.status = 'failed'
      result.build.status = 'failed'
      result.build.error = pendingTargetNotReachedError(pendingBuild.targetCommit)
      return finishResult(result, root, state, dryRun)
    }
    const shouldBuild = rebuildEnabled
      && !holdBlocksBuild
      && (pulled || forceRebuild || buildState.stale || dependencyDrift || pendingBuild !== undefined)
    const shouldBuildDashboard = options.buildDashboard ?? false

    if (
      holdBlocksBuild
      && (pulled || forceRebuild || buildState.stale || dependencyDrift || pendingBuild !== undefined)
    ) {
      result.build.status = 'held'
    } else if (!rebuildEnabled) {
      result.build.status = 'disabled'
    } else if (!shouldBuild) {
      result.build.status = 'up-to-date'
    }

    if (shouldBuild) {
      result.dependencies = ensureDependencies(
        root,
        runner,
        state,
        buildState.installInputsFingerprint,
        dryRun
      )
      if (result.dependencies.status === 'failed') {
        result.status = 'failed'
        return finishResult(result, root, state, dryRun)
      }
    }

    if (shouldBuild) {
      const buildCommit = getCurrentCommit(root, runner)
      if (
        !dryRun
        && pendingBuild
        && (
          !buildCommit
          || !revisionContainsTarget(root, runner, buildCommit, pendingBuild.targetCommit)
        )
      ) {
        result.status = 'failed'
        result.build.status = 'failed'
        result.build.error = pendingTargetNotReachedError(pendingBuild.targetCommit)
        return finishResult(result, root, state, dryRun)
      }
      result.build = buildProject({
        root,
        runner,
        dryRun,
        trigger,
        forced: forceRebuild,
        buildState,
        commit: buildCommit
      })
      if (result.build.status === 'failed') {
        result.status = 'failed'
      } else if (result.build.status === 'rebuilt' && !dryRun) {
        const completedPendingBuild = state.pendingBuild
        if (
          completedPendingBuild
          && (
            !buildCommit
            || !revisionContainsTarget(
              root,
              runner,
              buildCommit,
              completedPendingBuild.targetCommit
            )
          )
        ) {
          result.status = 'failed'
          result.build.status = 'failed'
          result.build.error = pendingTargetNotReachedError(completedPendingBuild.targetCommit)
        } else {
          delete state.pendingBuild
          if (state.heldSourceFingerprint) {
            delete state.heldSourceFingerprint
            result.hold.active = false
            result.hold.cleared = true
          }
          saveSelfUpdateState(root, state)
        }
      }
    }

    if (shouldBuildDashboard && result.status !== 'failed') {
      result.dashboard = buildDashboard(root, runner, dryRun)
      if (result.dashboard.status === 'failed') {
        result.status = 'failed'
      }
    }

    if (
      result.reconciliation.status === 'failed'
      || result.pull.status === 'fetch-failed'
    ) {
      result.status = 'failed'
    }
    return finishResult(result, root, state, dryRun)
  } catch (error) {
    result.status = 'failed'
    result.error = toErrorMessage(error)
    logger.error('Self-update failed', error)
    return finishResult(result, root, state, dryRun)
  } finally {
    lockHandle.release()
  }
}

function validatePackageRoot(root: string): string {
  const resolvedRoot = canonicalizePath(root)
  if (resolvedRoot === path.parse(resolvedRoot).root) {
    throw new Error('Refusing to use the filesystem root as the repository root')
  }

  const packagePath = path.join(resolvedRoot, 'package.json')
  const packageJson = readJsonFile<Record<string, unknown>>(packagePath, { fallback: null })
  if (!packageJson || packageJson.name !== 'claude-memory') {
    throw new Error(`Refusing to update unrecognized package root: ${resolvedRoot}`)
  }
  return resolvedRoot
}

function inspectSourceState(root: string): SourceState {
  const missingInput = SOURCE_INPUTS.some(input =>
    !fs.existsSync(path.join(root, input))
  )
  const entries = SOURCE_INPUTS.flatMap(input =>
    collectTreeEntries(root, path.join(root, input))
  )
  return {
    missingInput,
    fingerprint: fingerprintEntries(entries)
  }
}

function loadBuildStamp(root: string): BuildStamp | null {
  return readJsonFile<BuildStamp>(getBuildStampPath(root), {
    fallback: null,
    onError: () => {},
    coerce: coerceBuildStamp
  })
}

function coerceBuildStamp(value: unknown): BuildStamp | null {
  if (!isPlainObject(value)) return null
  const commit = value.commit === null ? null : asString(value.commit)
  const builtAt = asInteger(value.builtAt)
  const trigger = value.trigger === 'auto' || value.trigger === 'cli'
    ? value.trigger
    : undefined
  const node = asString(value.node)
  const sourceFingerprint = asString(value.sourceFingerprint)
  const installInputsFingerprint = asString(value.installInputsFingerprint)
  if (
    commit === undefined
    || builtAt === null
    || !trigger
    || !node
    || !sourceFingerprint
    || !installInputsFingerprint
  ) {
    return null
  }
  return {
    commit,
    builtAt,
    trigger,
    node,
    sourceFingerprint,
    installInputsFingerprint
  }
}

function collectTreeEntries(
  repositoryRoot: string,
  targetPath: string,
  excludedDirectoryNames: ReadonlySet<string> = new Set()
): TreeEntry[] {
  if (!fs.existsSync(targetPath)) return []

  const entries: TreeEntry[] = []
  const visit = (absolutePath: string): void => {
    const stats = fs.lstatSync(absolutePath)
    const relativePath = path.relative(repositoryRoot, absolutePath) || '.'
    const kind: TreeEntry['kind'] = stats.isSymbolicLink()
      ? 'symlink'
      : stats.isDirectory()
        ? 'directory'
        : 'file'
    entries.push({ absolutePath, relativePath, kind })

    if (kind !== 'directory') return
    const children = fs.readdirSync(absolutePath, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))
    for (const child of children) {
      if (child.isDirectory() && excludedDirectoryNames.has(child.name)) continue
      visit(path.join(absolutePath, child.name))
    }
  }

  visit(targetPath)
  return entries
}

function fingerprintEntries(entries: TreeEntry[]): string {
  const hash = createHash('sha256')
  for (const entry of [...entries].sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    hash.update(entry.kind)
    hash.update('\0')
    hash.update(entry.relativePath)
    hash.update('\0')
    if (entry.kind === 'file') {
      hash.update(fs.readFileSync(entry.absolutePath))
    } else if (entry.kind === 'symlink') {
      hash.update(fs.readlinkSync(entry.absolutePath))
    }
    hash.update('\0')
  }
  return hash.digest('hex')
}

function computeInstallInputsFingerprint(root: string): string {
  const repositoryEntries = collectTreeEntries(root, root, INSTALL_WALK_EXCLUDED_DIRECTORIES)
  const packageEntries = repositoryEntries.filter(entry =>
    entry.kind === 'file' && path.basename(entry.absolutePath) === 'package.json'
  )
  const fixedEntries = INSTALL_FIXED_INPUTS.flatMap(input =>
    collectTreeEntries(root, path.join(root, input))
  )
  return fingerprintEntries([...packageEntries, ...fixedEntries])
}

function loadSelfUpdateState(root: string): SelfUpdateState {
  return loadSelfUpdateStateFile(root).repositories[root] ?? { history: [] }
}

function loadSelfUpdateStateFile(root: string): SelfUpdateStateFile {
  return readJsonFileSafe<SelfUpdateStateFile>(SELF_UPDATE_STATE_PATH, {
    fallback: { repositories: {} },
    errorMessage: '[claude-memory] Failed to load self-update state:',
    coerce: value => {
      const namespaced = coerceSelfUpdateStateFile(value)
      if (namespaced) return namespaced
      const legacy = coerceSelfUpdateState(value)
      return legacy ? { repositories: { [root]: legacy } } : null
    }
  }) ?? { repositories: {} }
}

function coerceSelfUpdateStateFile(value: unknown): SelfUpdateStateFile | null {
  if (!isPlainObject(value) || !isPlainObject(value.repositories)) return null
  const repositories: Record<string, SelfUpdateState> = {}
  for (const [root, candidate] of Object.entries(value.repositories)) {
    const state = coerceSelfUpdateState(candidate)
    if (state) repositories[root] = state
  }
  return { repositories }
}

function coerceSelfUpdateState(value: unknown): SelfUpdateState | null {
  if (!isPlainObject(value)) return null
  const history = Array.isArray(value.history)
    ? value.history.filter(isPlainObject).slice(-STATE_HISTORY_LIMIT) as unknown as SelfUpdateResult[]
    : []
  const lastFetchAttemptAt = asInteger(value.lastFetchAttemptAt)
  const installedInputsFingerprint = asString(value.installedInputsFingerprint)
  const heldSourceFingerprint = asString(value.heldSourceFingerprint)
  const pendingCandidate = isPlainObject(value.pendingBuild)
    ? value.pendingBuild
    : null
  const pendingTargetCommit = pendingCandidate
    ? asString(pendingCandidate.targetCommit)
    : undefined
  const pendingCreatedAt = pendingCandidate
    ? asInteger(pendingCandidate.createdAt)
    : null
  const pendingBuild = pendingTargetCommit && pendingCreatedAt !== null
    ? {
        targetCommit: pendingTargetCommit,
        createdAt: pendingCreatedAt
      }
    : undefined
  return {
    ...(lastFetchAttemptAt !== null
      ? { lastFetchAttemptAt }
      : {}),
    ...(installedInputsFingerprint
      ? { installedInputsFingerprint }
      : {}),
    ...(heldSourceFingerprint
      ? { heldSourceFingerprint }
      : {}),
    ...(pendingBuild ? { pendingBuild } : {}),
    history
  }
}

function saveSelfUpdateState(root: string, state: SelfUpdateState): void {
  const stateFile = loadSelfUpdateStateFile(root)
  stateFile.repositories[root] = {
    ...state,
    history: state.history.slice(-STATE_HISTORY_LIMIT)
  }
  writeJsonFile(SELF_UPDATE_STATE_PATH, stateFile, {
    ensureDir: true,
    pretty: 2
  })
}

function createResult(trigger: SelfUpdateTrigger, startedAt: number, root: string): SelfUpdateResult {
  return {
    trigger,
    startedAt,
    completedAt: startedAt,
    root,
    status: 'completed',
    recovery: { restored: false },
    reconciliation: {
      status: 'not-needed',
      missingHooks: [],
      installedHooks: [],
      missingCommands: [],
      installedCommands: [],
      modifiedCommands: [],
      conflictingHookRoots: []
    },
    pull: { status: 'not-needed' },
    dependencies: { status: 'not-needed' },
    build: {
      status: 'not-needed',
      stale: false,
      forced: false
    },
    dashboard: { status: 'not-needed' },
    hold: { active: false, cleared: false }
  }
}

function failedResult(
  trigger: SelfUpdateTrigger,
  startedAt: number,
  root: string,
  error: string
): SelfUpdateResult {
  const result = createResult(trigger, startedAt, root)
  result.completedAt = Date.now()
  result.status = 'failed'
  result.error = error
  return result
}

function finishResult(
  result: SelfUpdateResult,
  root: string,
  state: SelfUpdateState,
  dryRun: boolean
): SelfUpdateResult {
  result.completedAt = Date.now()
  if (result.status === 'failed' && !result.error) {
    result.error = result.recovery.error
      ?? result.reconciliation.error
      ?? result.pull.error
      ?? result.dependencies.error
      ?? result.build.error
      ?? result.dashboard.error
      ?? result.rollback?.error
      ?? 'Self-update failed'
  }
  if (!dryRun) {
    state.history = [...state.history, result].slice(-STATE_HISTORY_LIMIT)
    try {
      saveSelfUpdateState(root, state)
    } catch (error) {
      result.status = 'failed'
      result.error = `Failed to persist self-update state: ${toErrorMessage(error)}`
      logger.error('Failed to persist self-update state', error)
    }
  }
  return result
}

function recoverMissingBuild(root: string): RecoveryResult {
  const distPath = getDistPath(root)
  const previousPath = getDistPath(root, PREVIOUS_DIST_DIRECTORY)
  const savedPreviousPath = getDistPath(root, SAVED_PREVIOUS_DIST_DIRECTORY)
  let restored = false
  try {
    if (!fs.existsSync(distPath) && fs.existsSync(previousPath)) {
      fs.renameSync(previousPath, distPath)
      restored = true
      logger.warn('Recovered missing dist directory from dist.prev')
    }
    if (fs.existsSync(savedPreviousPath)) {
      if (!fs.existsSync(previousPath)) {
        if (fs.existsSync(distPath)) {
          fs.renameSync(savedPreviousPath, previousPath)
        } else {
          fs.renameSync(savedPreviousPath, distPath)
          restored = true
        }
      } else if (fs.existsSync(distPath)) {
        fs.rmSync(savedPreviousPath, { recursive: true, force: true })
      }
    }
    return { restored }
  } catch (error) {
    return { restored, error: toErrorMessage(error) }
  }
}

function reconcileInstallation(root: string, dryRun: boolean): SelfUpdateResult['reconciliation'] {
  const result: SelfUpdateResult['reconciliation'] = {
    status: 'up-to-date',
    missingHooks: [],
    installedHooks: [],
    missingCommands: [],
    installedCommands: [],
    modifiedCommands: [],
    conflictingHookRoots: []
  }
  try {
    result.conflictingHookRoots = getRegisteredClaudeMemoryHookRoots(CLAUDE_SETTINGS_PATH)
      .filter(registeredRoot => registeredRoot !== root)
    if (result.conflictingHookRoots.length > 0) {
      result.status = 'conflict'
      return result
    }

    const status = getInstallationStatus(CLAUDE_SETTINGS_PATH, root)
    result.missingHooks = Object.entries(status.hooks)
      .filter(([, hook]) => !hook.installed)
      .map(([event]) => event as HookEvent)
    result.missingCommands = Object.entries(status.commands)
      .filter(([, command]) => !command.installed && !command.modified)
      .map(([name]) => name)
    result.modifiedCommands = Object.entries(status.commands)
      .filter(([, command]) => command.modified)
      .map(([name]) => name)

    if (result.missingHooks.length === 0 && result.missingCommands.length === 0) {
      return result
    }
    if (dryRun) {
      result.status = 'would-run'
      return result
    }
    if (result.missingHooks.length > 0) {
      installHooks(CLAUDE_SETTINGS_PATH, root, result.missingHooks)
      result.installedHooks = [...result.missingHooks]
    }
    if (result.missingCommands.length > 0) {
      installCommands(CLAUDE_SETTINGS_PATH, result.missingCommands)
      result.installedCommands = [...result.missingCommands]
    }
    result.status = 'success'
    return result
  } catch (error) {
    return { ...result, status: 'failed', error: toErrorMessage(error) }
  }
}

function runPullPhase(options: {
  root: string
  runner: SelfUpdateCommandRunner
  state: SelfUpdateState
  dryRun: boolean
  trigger: SelfUpdateTrigger
  rollbackHoldActive: boolean
  rebuildOnly: boolean
  forcePull: boolean
  autoRebuildEnabled: boolean
  intervalHours: number
}): SelfUpdateResult['pull'] {
  const pendingBuild = options.state.pendingBuild
  if (options.rebuildOnly) {
    return { status: 'disabled', skipReason: 'disabled' }
  }
  if (!options.autoRebuildEnabled) {
    return { status: 'skipped', skipReason: 'rebuild-disabled' }
  }
  if (options.rollbackHoldActive) {
    return { status: 'skipped', skipReason: 'rollback-hold' }
  }
  if (!pendingBuild && !options.forcePull && options.intervalHours <= 0) {
    return { status: 'disabled', skipReason: 'disabled' }
  }

  const intervalMs = options.intervalHours * 60 * 60 * 1000
  if (
    !pendingBuild
    && !options.forcePull
    && options.state.lastFetchAttemptAt !== undefined
    && Date.now() - options.state.lastFetchAttemptAt < intervalMs
  ) {
    return { status: 'interval', skipReason: 'interval' }
  }

  const gitContext = inspectGitContext(options.root, options.runner)
  if ('skipReason' in gitContext) {
    return { status: 'skipped', skipReason: gitContext.skipReason, error: gitContext.error }
  }
  if (
    options.trigger === 'auto'
    && !isOriginDefaultBranch(gitContext, options.root, options.runner)
  ) {
    return { status: 'skipped', skipReason: 'non-default-branch' }
  }

  const status = runGit(options.runner, options.root, ['status', '--porcelain=v1'])
  if (!status.ok) {
    return { status: 'skipped', skipReason: 'no-git', error: formatCommandFailure(status) }
  }
  if (status.stdout.trim()) {
    return { status: 'skipped', skipReason: 'dirty-tree' }
  }
  if (pendingBuild) {
    return advanceHeadToPendingTarget({
      root: options.root,
      runner: options.runner,
      targetCommit: pendingBuild.targetCommit,
      mergeRevision: pendingBuild.targetCommit,
      fromCommit: gitContext.head,
      dryRun: options.dryRun
    })
  }
  if (options.dryRun) {
    return { status: 'would-run', fromCommit: gitContext.head }
  }

  const fetch = runGit(options.runner, options.root, [
    'fetch',
    '--no-tags',
    gitContext.remote,
    gitContext.remoteBranch
  ])
  options.state.lastFetchAttemptAt = Date.now()
  saveSelfUpdateState(options.root, options.state)
  if (!fetch.ok) {
    return { status: 'fetch-failed', error: formatCommandFailure(fetch) }
  }

  const counts = runGit(options.runner, options.root, [
    'rev-list',
    '--left-right',
    '--count',
    `HEAD...${gitContext.upstream}`
  ])
  if (!counts.ok) {
    return { status: 'fetch-failed', error: formatCommandFailure(counts) }
  }
  const parsedCounts = parseAheadBehind(counts.stdout)
  if (!parsedCounts) {
    return { status: 'fetch-failed', error: `Unexpected ahead/behind output: ${counts.stdout.trim()}` }
  }
  const { ahead, behind } = parsedCounts
  if (ahead > 0) {
    return { status: 'skipped', skipReason: 'local-commits', ahead, behind }
  }
  if (behind === 0) {
    return { status: 'up-to-date', ahead, behind, fromCommit: gitContext.head, toCommit: gitContext.head }
  }

  const targetCommit = getRevisionCommit(
    options.root,
    options.runner,
    gitContext.upstream
  )
  if (!targetCommit) {
    return {
      status: 'fetch-failed',
      ahead,
      behind,
      error: `Could not resolve ${gitContext.upstream} after fetch`
    }
  }
  options.state.pendingBuild = {
    targetCommit,
    createdAt: Date.now()
  }
  saveSelfUpdateState(options.root, options.state)

  return advanceHeadToPendingTarget({
    root: options.root,
    runner: options.runner,
    targetCommit,
    mergeRevision: gitContext.upstream,
    fromCommit: gitContext.head,
    dryRun: false,
    ahead,
    behind
  })
}

function advanceHeadToPendingTarget(options: {
  root: string
  runner: SelfUpdateCommandRunner
  targetCommit: string
  mergeRevision: string
  fromCommit: string
  dryRun: boolean
  ahead?: number
  behind?: number
}): SelfUpdateResult['pull'] {
  const counts = {
    ...(options.ahead !== undefined ? { ahead: options.ahead } : {}),
    ...(options.behind !== undefined ? { behind: options.behind } : {})
  }
  const resolvedTarget = getRevisionCommit(
    options.root,
    options.runner,
    `${options.targetCommit}^{commit}`
  )
  if (!resolvedTarget) {
    return {
      status: 'failed',
      ...counts,
      fromCommit: options.fromCommit,
      error: `Pending build target is unavailable: ${options.targetCommit}`
    }
  }
  if (
    revisionContainsTarget(
      options.root,
      options.runner,
      options.fromCommit,
      options.targetCommit
    )
  ) {
    return {
      status: 'up-to-date',
      ...counts,
      fromCommit: options.fromCommit,
      toCommit: options.fromCommit
    }
  }
  if (options.dryRun) {
    return {
      status: 'would-run',
      ...counts,
      fromCommit: options.fromCommit,
      toCommit: resolvedTarget
    }
  }

  const merge = runGit(
    options.runner,
    options.root,
    ['merge', '--ff-only', options.mergeRevision]
  )
  if (!merge.ok) {
    return {
      status: 'failed',
      skipReason: 'not-fast-forwardable',
      ...counts,
      fromCommit: options.fromCommit,
      toCommit: resolvedTarget,
      error: formatCommandFailure(merge)
    }
  }

  const newHead = getCurrentCommit(options.root, options.runner)
  if (
    !newHead
    || !revisionContainsTarget(
      options.root,
      options.runner,
      newHead,
      options.targetCommit
    )
  ) {
    return {
      status: 'failed',
      ...counts,
      fromCommit: options.fromCommit,
      ...(newHead ? { toCommit: newHead } : {}),
      error: pendingTargetNotReachedError(options.targetCommit)
    }
  }
  return {
    status: 'pulled',
    ...counts,
    fromCommit: options.fromCommit,
    toCommit: newHead
  }
}

function inspectGitContext(
  root: string,
  runner: SelfUpdateCommandRunner
): GitContext | { skipReason: SelfUpdateSkipReason; error?: string } {
  const discoveredRoot = findGitRoot(root)
  if (!discoveredRoot) return { skipReason: 'no-git' }

  if (canonicalizePath(discoveredRoot) !== root) {
    return { skipReason: 'git-root-mismatch' }
  }

  const branchResult = runGit(runner, root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  if (!branchResult.ok || !branchResult.stdout.trim()) {
    return { skipReason: 'detached-head' }
  }
  const branch = branchResult.stdout.trim()
  const upstreamResult = runGit(runner, root, [
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{u}'
  ])
  const remoteResult = runGit(runner, root, ['config', '--get', `branch.${branch}.remote`])
  const mergeRefResult = runGit(runner, root, ['config', '--get', `branch.${branch}.merge`])
  if (!upstreamResult.ok || !remoteResult.ok || !mergeRefResult.ok) {
    return { skipReason: 'no-upstream' }
  }
  const upstream = upstreamResult.stdout.trim()
  const remote = remoteResult.stdout.trim()
  const mergeRef = mergeRefResult.stdout.trim()
  if (!upstream || !remote || remote === '.' || !mergeRef.startsWith('refs/heads/')) {
    return { skipReason: 'no-upstream' }
  }
  const head = getCurrentCommit(root, runner)
  if (!head) return { skipReason: 'no-git' }

  return {
    branch,
    upstream,
    remote,
    remoteBranch: mergeRef.slice('refs/heads/'.length),
    head
  }
}

function isOriginDefaultBranch(
  context: GitContext,
  root: string,
  runner: SelfUpdateCommandRunner
): boolean {
  if (
    context.remote !== 'origin'
    || context.remoteBranch !== context.branch
    || context.upstream !== `origin/${context.branch}`
  ) {
    return false
  }

  const originHead = runGit(runner, root, [
    'symbolic-ref',
    '--quiet',
    '--short',
    'refs/remotes/origin/HEAD'
  ])
  return originHead.ok && originHead.stdout.trim() === `origin/${context.branch}`
}

function parseAheadBehind(output: string): { ahead: number; behind: number } | null {
  const [aheadRaw, behindRaw] = output.trim().split(/\s+/)
  const ahead = Number.parseInt(aheadRaw, 10)
  const behind = Number.parseInt(behindRaw, 10)
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return null
  return { ahead, behind }
}

function runGit(
  runner: SelfUpdateCommandRunner,
  root: string,
  args: string[]
): SelfUpdateCommandResult {
  return runner('git', args, {
    cwd: root,
    timeoutMs: GIT_TIMEOUT_MS,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_MERGE_AUTOEDIT: 'no'
    }
  })
}

function getCurrentCommit(root: string, runner: SelfUpdateCommandRunner): string | undefined {
  return getRevisionCommit(root, runner, 'HEAD')
}

function getRevisionCommit(
  root: string,
  runner: SelfUpdateCommandRunner,
  revision: string
): string | undefined {
  const result = runGit(runner, root, ['rev-parse', revision])
  return result.ok && result.stdout.trim() ? result.stdout.trim() : undefined
}

function revisionContainsTarget(
  root: string,
  runner: SelfUpdateCommandRunner,
  revision: string,
  targetCommit: string
): boolean {
  return runGit(
    runner,
    root,
    ['merge-base', '--is-ancestor', targetCommit, revision]
  ).ok
}

function pendingTargetNotReachedError(targetCommit: string): string {
  return `Refusing to build before pending target is reachable from HEAD: ${targetCommit}`
}

function ensureDependencies(
  root: string,
  runner: SelfUpdateCommandRunner,
  state: SelfUpdateState,
  fingerprint: string,
  dryRun: boolean
): SelfUpdateResult['dependencies'] {
  if (state.installedInputsFingerprint === fingerprint) {
    return { status: 'up-to-date' }
  }
  if (dryRun) return { status: 'would-run' }

  logger.info('Installing dependencies')
  const install = runner('pnpm', ['install', '--frozen-lockfile'], {
    cwd: root,
    timeoutMs: COMMAND_TIMEOUT_MS,
    env: process.env
  })
  if (!install.ok) {
    return { status: 'failed', error: formatCommandFailure(install) }
  }

  state.installedInputsFingerprint = fingerprint
  saveSelfUpdateState(root, state)
  return { status: 'success' }
}

function buildProject(options: {
  root: string
  runner: SelfUpdateCommandRunner
  dryRun: boolean
  trigger: SelfUpdateTrigger
  forced: boolean
  buildState: BuildState
  commit?: string
}): SelfUpdateResult['build'] {
  const base: SelfUpdateResult['build'] = {
    status: options.dryRun ? 'would-run' : 'not-needed',
    stale: options.buildState.stale,
    forced: options.forced,
    sourceFingerprint: options.buildState.sourceFingerprint
  }
  if (options.dryRun) return base

  const stagingPath = getDistPath(options.root, STAGING_DIST_DIRECTORY)
  try {
    fs.rmSync(stagingPath, { recursive: true, force: true })
  } catch (error) {
    return { ...base, status: 'failed', error: toErrorMessage(error) }
  }
  logger.info('Building staged dist directory')
  const build = options.runner('pnpm', [
    'exec',
    'tsc',
    '-p',
    'tsconfig.json',
    '--outDir',
    STAGING_DIST_DIRECTORY
  ], {
    cwd: options.root,
    timeoutMs: COMMAND_TIMEOUT_MS,
    env: process.env
  })
  if (!build.ok) {
    fs.rmSync(stagingPath, { recursive: true, force: true })
    return { ...base, status: 'failed', error: formatCommandFailure(build) }
  }
  if (!fs.existsSync(stagingPath)) {
    return { ...base, status: 'failed', error: 'Build completed without creating dist.next' }
  }

  const missingArtifacts = getMissingDistArtifacts(options.root, STAGING_DIST_DIRECTORY)
  if (missingArtifacts.length > 0) {
    fs.rmSync(stagingPath, { recursive: true, force: true })
    return {
      ...base,
      status: 'failed',
      error: `Staged build is missing required artifacts: ${missingArtifacts.join(', ')}`
    }
  }

  const completedSourceState = inspectSourceState(options.root)
  const completedInstallInputsFingerprint = computeInstallInputsFingerprint(options.root)
  if (
    completedSourceState.fingerprint !== options.buildState.sourceFingerprint
    || completedInstallInputsFingerprint !== options.buildState.installInputsFingerprint
  ) {
    fs.rmSync(stagingPath, { recursive: true, force: true })
    return {
      ...base,
      status: 'failed',
      error: 'Build inputs changed during compilation; refusing to install staged output'
    }
  }

  try {
    writeJsonFile(getBuildStampPath(options.root, STAGING_DIST_DIRECTORY), {
      commit: options.commit ?? null,
      builtAt: Date.now(),
      trigger: options.trigger,
      node: process.version,
      sourceFingerprint: completedSourceState.fingerprint,
      installInputsFingerprint: completedInstallInputsFingerprint
    }, {
      ensureDir: true,
      pretty: 2
    })
  } catch (error) {
    fs.rmSync(stagingPath, { recursive: true, force: true })
    return { ...base, status: 'failed', error: toErrorMessage(error) }
  }

  const swap = swapStagedBuild(options.root)
  if (!swap.ok) {
    const distPath = getDistPath(options.root)
    if (fs.existsSync(distPath)) {
      fs.rmSync(stagingPath, { recursive: true, force: true })
    }
    return { ...base, status: 'failed', error: swap.error }
  }
  logger.info('Staged build installed')
  return { ...base, status: 'rebuilt' }
}

function swapStagedBuild(root: string): SwapResult {
  const distPath = getDistPath(root)
  const previousPath = getDistPath(root, PREVIOUS_DIST_DIRECTORY)
  const savedPreviousPath = getDistPath(root, SAVED_PREVIOUS_DIST_DIRECTORY)
  const stagingPath = getDistPath(root, STAGING_DIST_DIRECTORY)

  if (fs.existsSync(savedPreviousPath)) {
    return {
      ok: false,
      error: 'Refusing to swap while an unrecovered dist.prev.saved directory exists'
    }
  }

  let savedPrevious = false
  let movedCurrent = false
  try {
    if (fs.existsSync(distPath) && fs.existsSync(previousPath)) {
      fs.renameSync(previousPath, savedPreviousPath)
      savedPrevious = true
    }
    if (fs.existsSync(distPath)) {
      try {
        fs.renameSync(distPath, previousPath)
        movedCurrent = true
      } catch (error) {
        const moveError = toErrorMessage(error)
        if (savedPrevious) {
          try {
            fs.renameSync(savedPreviousPath, previousPath)
          } catch (restoreError) {
            return {
              ok: false,
              error: `${moveError}; failed to restore prior rollback build: ${toErrorMessage(restoreError)}`
            }
          }
        }
        return { ok: false, error: moveError }
      }
    }
    try {
      fs.renameSync(stagingPath, distPath)
      if (savedPrevious) {
        try {
          fs.rmSync(savedPreviousPath, { recursive: true, force: true })
        } catch (error) {
          logger.warn('Could not remove superseded rollback build', error)
        }
      }
      return { ok: true }
    } catch (error) {
      const swapError = toErrorMessage(error)
      try {
        if (movedCurrent && fs.existsSync(previousPath) && !fs.existsSync(distPath)) {
          fs.renameSync(previousPath, distPath)
        }
        if (savedPrevious && fs.existsSync(savedPreviousPath) && !fs.existsSync(previousPath)) {
          fs.renameSync(savedPreviousPath, previousPath)
        }
      } catch (rollbackError) {
        return {
          ok: false,
          error: `${swapError}; immediate rollback failed: ${toErrorMessage(rollbackError)}`
        }
      }
      return { ok: false, error: swapError }
    }
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) }
  }
}

function buildDashboard(
  root: string,
  runner: SelfUpdateCommandRunner,
  dryRun: boolean
): SelfUpdateResult['dashboard'] {
  if (dryRun) return { status: 'would-run' }
  logger.info('Building dashboard by explicit CLI request')
  const result = runner('pnpm', ['run', 'dashboard:build'], {
    cwd: root,
    timeoutMs: COMMAND_TIMEOUT_MS,
    env: process.env
  })
  return result.ok
    ? { status: 'success' }
    : { status: 'failed', error: formatCommandFailure(result) }
}

function resolveRollbackHold(
  result: SelfUpdateResult,
  state: SelfUpdateState,
  sourceFingerprint: string,
  dryRun: boolean
): void {
  if (!state.heldSourceFingerprint) return
  result.hold.fingerprint = state.heldSourceFingerprint
  if (state.heldSourceFingerprint === sourceFingerprint) {
    result.hold.active = true
    return
  }

  result.hold.active = false
  result.hold.cleared = true
  if (!dryRun) {
    delete state.heldSourceFingerprint
  }
}

function applyBuildState(
  result: SelfUpdateResult,
  buildState: BuildState,
  forced: boolean
): void {
  result.build = {
    ...result.build,
    stale: buildState.stale,
    forced,
    sourceFingerprint: buildState.sourceFingerprint
  }
}

function formatCommandFailure(result: SelfUpdateCommandResult): string {
  const combined = [result.error, result.stderr.trim(), result.stdout.trim()]
    .filter((value): value is string => Boolean(value))
    .join('\n')
  const fallback = result.exitCode === null
    ? 'Command failed'
    : `Command exited with status ${result.exitCode}`
  return truncateWithTail(
    combined || fallback,
    COMMAND_ERROR_MAX_CHARS,
    COMMAND_ERROR_TAIL_CHARS
  )
}
