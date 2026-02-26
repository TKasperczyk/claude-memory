#!/usr/bin/env -S npx tsx

import path from 'path'
import { fileURLToPath } from 'url'
import { loadConfig } from './lib/config.js'
import { initLanceDB } from './lib/lancedb.js'
import { resolveMaintenanceSettings } from './lib/settings.js'
import {
  MAINTENANCE_OPERATIONS,
  MAINTENANCE_OPERATION_DEFINITIONS,
  runMaintenanceOperation,
  type OperationResult
} from './lib/maintenance-api.js'
import { buildMaintenanceRun, saveMaintenanceRun } from './lib/maintenance-log.js'
import { runPromotionSuggestions as writePromotionSuggestions } from './lib/maintenance/runners/index.js'

export {
  runStaleCheck,
  runStaleUnusedDeprecation,
  runLowUsageDeprecation,
  runLowUsageCheck,
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
  await initLanceDB(config)

  console.error('[claude-memory] Maintenance started.')

  const results: OperationResult[] = []
  for (const operation of MAINTENANCE_OPERATIONS) {
    const result = await runMaintenanceOperation(operation, dryRun, config, maintenanceSettings)
    results.push(result)
    const label = MAINTENANCE_OPERATION_DEFINITIONS.find(definition => definition.key === operation)?.label ?? operation
    logMaintenanceResult(label, result, dryRun)
  }

  const run = buildMaintenanceRun(results, {
    dryRun,
    trigger: 'cli',
    operations: results.map(result => result.operation)
  })
  saveMaintenanceRun(run, config.lancedb.table)

  // The API-based loop captures promotion suggestion diffs for persistence,
  // but only the raw runner actually writes suggestion files to disk.
  await writePromotionSuggestions(config, dryRun)

  if (dryRun) {
    console.error('[claude-memory] Maintenance complete (DRY RUN - no changes made)')
  } else {
    console.error('[claude-memory] Maintenance complete.')
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

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
const isMainModule = fileURLToPath(import.meta.url) === entryPath
if (isMainModule) {
  main()
    .then(() => {
      process.exitCode = 0
    })
    .catch(error => {
      console.error('[claude-memory] maintenance failed:', error)
      process.exitCode = 2
    })
}
