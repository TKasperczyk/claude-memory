#!/usr/bin/env -S npx tsx

import path from 'path'
import { fileURLToPath } from 'url'
import { loadConfig } from './lib/config.js'
import { initMilvus } from './lib/milvus.js'
import { resolveMaintenanceSettings } from './lib/settings.js'
import { runConflictResolution } from './lib/maintenance.js'
import {
  runConsolidation,
  runCrossTypeConsolidation,
  runGlobalPromotion,
  runLowUsageCheck,
  runLowUsageDeprecation,
  runPromotionSuggestions,
  runStaleCheck,
  runStaleUnusedDeprecation,
  runWarningSynthesis,
  type MaintenanceRunResult
} from './lib/maintenance/runners/index.js'

export {
  runStaleCheck,
  runStaleUnusedDeprecation,
  runLowUsageDeprecation,
  runLowUsageCheck,
  runConsolidation,
  runCrossTypeConsolidation,
  runConflictResolution,
  runGlobalPromotion,
  runWarningSynthesis
}

export type {
  MaintenanceAction,
  MaintenanceActionDetails,
  MaintenanceActionType,
  MaintenanceMergeRecord
} from '../shared/types.js'

export type { MaintenanceRunResult } from './lib/maintenance/runners/index.js'

async function main(): Promise<void> {
  const config = loadConfig(process.cwd())
  const dryRun = process.argv.slice(2).includes('--dry-run')
  const maintenanceSettings = resolveMaintenanceSettings()
  await initMilvus(config)

  console.error('[claude-memory] Maintenance started.')

  logMaintenanceResult('Stale check', await runStaleCheck(dryRun, config, maintenanceSettings), dryRun)
  logMaintenanceResult('Stale unused deprecation', await runStaleUnusedDeprecation(dryRun, config, maintenanceSettings), dryRun)
  logMaintenanceResult('Low usage deprecation', await runLowUsageDeprecation(dryRun, config, maintenanceSettings), dryRun)
  logMaintenanceResult('Low usage check', await runLowUsageCheck(dryRun, config, maintenanceSettings), dryRun)
  logMaintenanceResult('Consolidation', await runConsolidation(dryRun, config, maintenanceSettings), dryRun)
  logMaintenanceResult('Cross-type consolidation', await runCrossTypeConsolidation(dryRun, config, maintenanceSettings), dryRun)
  logMaintenanceResult('Conflict resolution', await runConflictResolution(dryRun, config, maintenanceSettings), dryRun)
  logMaintenanceResult('Global promotion', await runGlobalPromotion(dryRun, config, maintenanceSettings), dryRun)
  logMaintenanceResult('Warning synthesis', await runWarningSynthesis(dryRun, config, maintenanceSettings), dryRun)
  await runPromotionSuggestions(config, dryRun)

  if (dryRun) {
    console.error('[claude-memory] Maintenance complete (DRY RUN - no changes made)')
  } else {
    console.error('[claude-memory] Maintenance complete.')
  }
}

function logMaintenanceResult(label: string, result: MaintenanceRunResult, dryRun: boolean): void {
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
