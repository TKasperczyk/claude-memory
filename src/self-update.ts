#!/usr/bin/env -S npx tsx

import { loadConfig } from './lib/config.js'
import { runPendingMigrations, type DataMigrationsResult } from './lib/data-migrations.js'
import { closeLanceDB } from './lib/lancedb.js'
import {
  runSelfUpdate,
  type SelfUpdateOptions,
  type SelfUpdateResult
} from './lib/self-update.js'
import { isProcessEntrypoint } from './lib/shared.js'
import { toErrorMessage } from './lib/maintenance/runners/shared.js'

const USAGE = `Usage: pnpm run self-update [options]

Options:
  --dry-run       Inspect and report without fetching, installing, or building.
                  Crash recovery still restores dist from dist.prev.
  --rebuild-only  Disable the pull phase for this run.
  --pull          Attempt a fetch regardless of the configured interval.
                  This does not bypass rebuild-disabled or git safety guards.
  --force         Request a rebuild regardless of freshness or the auto-rebuild
                  setting. It never changes pull guards or a rollback hold.
  --rollback      Swap dist.prev back into dist and hold auto-rebuild until
                  source inputs change.
  --clear-hold    Clear a rollback hold without running the update pipeline.
  --dashboard     Also run the existing explicit dashboard build script.
  --json          Print the complete result as JSON.
  --help          Show this help.

Precedence:
  --clear-hold and --rollback are exclusive operations.
  --rebuild-only disables pulling and cannot be combined with --pull.
  --pull only bypasses the fetch interval; --force only changes rebuild scheduling.`

type CliOptions = {
  selfUpdate: SelfUpdateOptions
  json: boolean
  help: boolean
}

function parseArgs(args: string[]): CliOptions {
  const known = new Set([
    '--dry-run',
    '--rebuild-only',
    '--pull',
    '--force',
    '--rollback',
    '--clear-hold',
    '--dashboard',
    '--json',
    '--help'
  ])
  const unknown = args.filter(argument => !known.has(argument))
  if (unknown.length > 0) {
    throw new Error(`Unknown option${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`)
  }

  const has = (flag: string): boolean => args.includes(flag)
  const dryRun = has('--dry-run')
  const rebuildOnly = has('--rebuild-only')
  const forcePull = has('--pull')
  const forceRebuild = has('--force')
  const rollback = has('--rollback')
  const clearHold = has('--clear-hold')
  const buildDashboard = has('--dashboard')
  const exclusiveOperationFlags = [
    rebuildOnly && '--rebuild-only',
    forcePull && '--pull',
    forceRebuild && '--force',
    buildDashboard && '--dashboard'
  ].filter((flag): flag is string => Boolean(flag))

  if (rollback && clearHold) {
    throw new Error('--rollback and --clear-hold cannot be combined')
  }
  if ((rollback || clearHold) && exclusiveOperationFlags.length > 0) {
    throw new Error(
      `${rollback ? '--rollback' : '--clear-hold'} cannot be combined with ${exclusiveOperationFlags.join(', ')}`
    )
  }
  if (rebuildOnly && forcePull) {
    throw new Error('--rebuild-only and --pull cannot be combined')
  }

  return {
    selfUpdate: {
      trigger: 'cli',
      dryRun,
      rebuildOnly,
      forcePull,
      forceRebuild,
      rollback,
      clearHold,
      buildDashboard
    },
    json: has('--json'),
    help: has('--help')
  }
}

function formatResult(
  result: SelfUpdateResult,
  dryRun: boolean,
  migrations?: DataMigrationsResult
): string[] {
  const lines: string[] = []
  if (result.recovery.restored) {
    lines.push(
      'Recovery: restored missing dist from dist.prev'
      + (dryRun ? ' (required repair; dry-run does not suppress crash recovery)' : '')
    )
  }

  const reconciliationDetails = [
    result.reconciliation.installedHooks.length > 0
      ? `hooks=${result.reconciliation.installedHooks.join(',')}`
      : '',
    result.reconciliation.installedCommands.length > 0
      ? `commands=${result.reconciliation.installedCommands.join(',')}`
      : '',
    result.reconciliation.modifiedCommands.length > 0
      ? `modified-commands-preserved=${result.reconciliation.modifiedCommands.join(',')}`
      : '',
    result.reconciliation.conflictingHookRoots.length > 0
      ? `foreign-checkouts=${result.reconciliation.conflictingHookRoots.join(',')}`
      : ''
  ].filter(Boolean)
  lines.push(
    `Registration: ${result.reconciliation.status}`
    + (reconciliationDetails.length > 0 ? ` (${reconciliationDetails.join(' ')})` : '')
  )

  const pullDetails = [
    result.pull.skipReason ? `reason=${result.pull.skipReason}` : '',
    result.pull.ahead !== undefined ? `ahead=${result.pull.ahead}` : '',
    result.pull.behind !== undefined ? `behind=${result.pull.behind}` : ''
  ].filter(Boolean)
  lines.push(
    `Pull: ${result.pull.status}`
    + (pullDetails.length > 0 ? ` (${pullDetails.join(' ')})` : '')
  )

  const buildDetails = [
    result.build.stale ? 'stale' : 'fresh',
    result.build.forced ? 'forced' : ''
  ].filter(Boolean)
  lines.push(`Build: ${result.build.status} (${buildDetails.join(' ')})`)

  if (result.dependencies.status !== 'not-needed') {
    lines.push(`Dependencies: ${result.dependencies.status}`)
  }
  if (result.dashboard.status !== 'not-needed') {
    lines.push(`Dashboard: ${result.dashboard.status}`)
  }
  if (migrations) {
    lines.push(formatMigrationsLine(migrations))
  }
  if (result.rollback) {
    lines.push(
      `Rollback: ${result.rollback.status}`
      + (result.rollback.skipReason ? ` (reason=${result.rollback.skipReason})` : '')
    )
  }
  if (result.hold.active) {
    lines.push(
      `Rollback hold: active (${result.hold.fingerprint ?? 'unknown fingerprint'}); `
      + 'automatic rebuilds resume when source changes, or run with --clear-hold'
    )
  } else if (result.hold.cleared) {
    lines.push('Rollback hold: cleared')
  }

  for (const error of new Set([
    result.recovery.error,
    result.reconciliation.error,
    result.pull.error,
    result.dependencies.error,
    result.build.error,
    result.dashboard.error,
    result.rollback?.error,
    migrations?.error,
    result.error
  ])) {
    if (error) lines.push(`Error: ${error}`)
  }
  const overallStatus = result.status === 'failed' || migrations?.status === 'failed'
    ? 'failed'
    : result.status
  lines.push(`Result: ${overallStatus}${dryRun ? ' (dry run)' : ''}`)
  return lines
}

function formatMigrationsLine(migrations: DataMigrationsResult): string {
  switch (migrations.status) {
    case 'up-to-date':
      return 'Migrations: up-to-date'
    case 'would-run':
      return `Migrations: would-run (${migrations.pendingIds.length} pending: ${migrations.pendingIds.join(', ')})`
    case 'applied': {
      const totalUpdated = migrations.steps.reduce((sum, step) => sum + step.updated, 0)
      const parts = [
        `${migrations.steps.length} ran`,
        `${totalUpdated} updated`,
        ...(migrations.compacted ? ['compacted'] : [])
      ]
      return `Migrations: applied (${parts.join(', ')})`
    }
    case 'skipped':
      return `Migrations: skipped (reason=${migrations.skipReason ?? 'unknown'})`
    case 'failed':
      return 'Migrations: failed'
  }
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2))
  if (cli.help) {
    console.log(USAGE)
    return
  }

  const result = runSelfUpdate(cli.selfUpdate)
  let migrations: DataMigrationsResult | undefined
  const shouldRunMigrations = result.status !== 'failed'
    && !cli.selfUpdate.rollback
    && !cli.selfUpdate.clearHold

  if (shouldRunMigrations) {
    try {
      const config = loadConfig(process.cwd())
      migrations = await runPendingMigrations(config, {
        dryRun: cli.selfUpdate.dryRun ?? false
      })
    } catch (error) {
      migrations = {
        status: 'failed',
        collectionKey: 'unknown',
        pendingIds: [],
        steps: [],
        mutated: false,
        compacted: false,
        error: toErrorMessage(error)
      }
    } finally {
      await closeLanceDB()
    }
  }

  if (cli.json) {
    console.log(JSON.stringify(migrations ? { ...result, migrations } : result, null, 2))
  } else {
    for (const line of formatResult(result, cli.selfUpdate.dryRun ?? false, migrations)) {
      console.error(`[claude-memory] ${line}`)
    }
  }
  if (result.status === 'failed' || migrations?.status === 'failed') {
    process.exitCode = 2
  }
}

if (isProcessEntrypoint(import.meta.url)) {
  main().catch(error => {
    console.error(`[claude-memory] self-update failed: ${toErrorMessage(error)}`)
    console.error(USAGE)
    process.exitCode = 2
  })
}
