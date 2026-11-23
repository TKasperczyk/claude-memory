#!/usr/bin/env -S npx tsx

import { loadConfig } from './lib/config.js'
import { runPendingMigrations, type DataMigrationsResult } from './lib/data-migrations.js'
import { closeLanceDB, initLanceDB } from './lib/lancedb.js'
import { isProcessEntrypoint } from './lib/shared.js'
import { resolveMaintenanceSettings } from './lib/settings.js'
import {
  AUTO_MAINTENANCE_OPERATIONS,
  MAINTENANCE_OPERATION_DEFINITIONS,
  compactTableSafely,
  runMaintenanceOperation,
  type OperationResult
} from './lib/maintenance-api.js'
import { buildMaintenanceRun, saveMaintenanceRun } from './lib/maintenance-log.js'

export {
  runStaleCheck,
  runStaleUnusedDeprecation,
  runLowUsageDeprecation,
  runLowUsageCheck,
  runQualityDeprecation,
  runConsolidation,
  runCrossTypeConsolidation,
  runGlobalPromotion,
  runWarningSynthesis
} from './lib/maintenance/runners/index.js'
export { runConflictResolution } from './lib/maintenance.js'

export type {
  MaintenanceAction,
  MaintenanceActionDetails,
  MaintenanceActionType,
  MaintenanceMergeRecord
} from '../shared/types.js'

async function main(): Promise<void> {
  const config = loadConfig(process.cwd())
  const dryRun = process.argv.slice(2).includes('--dry-run')
  const maintenanceSettings = resolveMaintenanceSettings()

  try {
    const migrationResult = await runPendingMigrations(config, { dryRun })
    logMigrationResult(migrationResult, dryRun)
    if (migrationResult.status === 'failed') {
      throw new Error(migrationResult.error ?? 'Data migrations failed')
    }

    await initLanceDB(config)

    console.error('[claude-memory] Maintenance started.')

    const results: OperationResult[] = []
    for (const operation of AUTO_MAINTENANCE_OPERATIONS) {
      const result = await runMaintenanceOperation(operation, dryRun, config, maintenanceSettings)
      results.push(result)
      const label = MAINTENANCE_OPERATION_DEFINITIONS.find(definition => definition.key === operation)?.label ?? operation
      logMaintenanceResult(label, result, dryRun)
    }
    if (!dryRun) await compactTableSafely(config)

    const run = buildMaintenanceRun(results, {
      dryRun,
      trigger: 'cli',
      operations: results.map(result => result.operation)
    })
    saveMaintenanceRun(run, config.lancedb.table)

    if (dryRun) {
      console.error('[claude-memory] Maintenance complete (DRY RUN - no changes made)')
    } else {
      console.error('[claude-memory] Maintenance complete.')
    }
  } finally {
    await closeLanceDB()
  }
}

function logMigrationResult(result: DataMigrationsResult, dryRun: boolean): void {
  const prefix = dryRun ? '[DRY RUN] ' : ''
  const settingsMigration = result.settingsMigration
  if (settingsMigration?.status === 'migrated') {
    console.error(
      `[claude-memory] Settings migrated v${settingsMigration.fromVersion ?? 1}->v${settingsMigration.toVersion}: `
      + `${settingsMigration.droppedKeys.length} dropped, ${settingsMigration.keptKeys.length} kept`
      + (settingsMigration.backupPath ? ` (backup: ${settingsMigration.backupPath})` : '')
    )
  } else if (settingsMigration?.status === 'would-run') {
    console.error(
      `[claude-memory] ${prefix}Pending settings migration v${settingsMigration.fromVersion ?? 1}->v${settingsMigration.toVersion}: `
      + `${settingsMigration.droppedKeys.length} to drop, ${settingsMigration.keptKeys.length} to keep`
    )
  } else if (settingsMigration?.status === 'skipped') {
    console.error(
      `[claude-memory] Settings migration skipped (${settingsMigration.skipReason ?? 'unknown'})`
      + (settingsMigration.error ? `: ${settingsMigration.error}` : '')
    )
  }

  if (result.status === 'applied') {
    for (const step of result.steps) {
      console.error(`[claude-memory] Migration ${step.id}: scanned=${step.scanned} updated=${step.updated}`)
    }
    if (result.compacted) {
      console.error('[claude-memory] Post-migration table compaction complete.')
    }
  } else if (result.status === 'would-run' && result.pendingIds.length > 0) {
    console.error(`[claude-memory] ${prefix}Pending data migrations (${result.pendingIds.length}): ${result.pendingIds.join(', ')}`)
  } else if (result.status === 'skipped' && result.skipReason === 'locked') {
    console.error('[claude-memory] Data migrations skipped (locked by another process).')
  } else if (result.status === 'failed') {
    console.error(`[claude-memory] Data migrations failed: ${result.error ?? 'unknown error'}`)
  }
}

function logMaintenanceResult(label: string, result: OperationResult, dryRun: boolean): void {
  const prefix = dryRun ? '[DRY RUN] ' : ''
  for (const action of result.actions) {
    const recordId = action.recordId ? ` ${action.recordId}` : ''
    console.error(`[claude-memory] ${prefix}${action.type}${recordId} ${action.snippet} (${action.reason})`)
  }

  if (result.error) {
    console.error(`[claude-memory] ${label} error: ${result.error}`)
  }
  if (Object.keys(result.summary).length > 0) {
    console.error(`[claude-memory] ${label} summary: ${formatSummary(result.summary)}`)
  }
}

function formatSummary(summary: Record<string, number>): string {
  return Object.entries(summary)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ')
}

if (isProcessEntrypoint(import.meta.url)) {
  main()
    .then(() => {
      process.exitCode = 0
    })
    .catch(error => {
      console.error('[claude-memory] maintenance failed:', error)
      process.exitCode = 2
    })
}
