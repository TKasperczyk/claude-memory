import { DEFAULT_CONFIG, type Config } from './types.js'
import { findGitRoot } from './context.js'
import { buildPromotionDiffs } from './promotions.js'
import { buildRecordSnippet, truncateSnippet } from './shared.js'
import { resolveMaintenanceSettings, type MaintenanceSettings } from './settings.js'
import { runConflictResolution } from './maintenance.js'
import {
  runStaleCheck,
  runStaleUnusedDeprecation,
  runLowUsageDeprecation,
  runLowUsageCheck,
  runQualityDeprecation,
  runConsolidation,
  runCrossTypeConsolidation,
  runRelationDiscovery,
  runGlobalPromotion,
  runWarningSynthesis,
  type MaintenanceRunResult
} from './maintenance/runners/index.js'
import type {
  MaintenanceAction,
  MaintenanceOperationInfo,
  MaintenanceProgress,
  OperationResult
} from '../../shared/types.js'

export const MAINTENANCE_OPERATION_DEFINITIONS = [
  {
    key: 'stale-check',
    label: 'Stale Check',
    description: 'Find records unused for the configured number of days',
    allowExecute: true
  },
  {
    key: 'stale-unused-deprecation',
    label: 'Stale Unused Deprecation',
    description: 'Deprecate old records that have never been used',
    allowExecute: false
  },
  {
    key: 'low-usage-deprecation',
    label: 'Zero Usage Deprecation',
    description: 'Deprecate records with high retrievals and zero usage',
    allowExecute: false
  },
  {
    key: 'low-usage',
    label: 'Low Usage',
    description: 'Deprecate records below the configured usage ratio',
    allowExecute: false
  },
  {
    key: 'consolidation',
    label: 'Consolidation',
    description: 'Merge duplicate records using the configured similarity threshold',
    allowExecute: true
  },
  {
    key: 'cross-type-consolidation',
    label: 'Cross-Type Consolidation',
    description: 'Merge highly similar records across different types',
    allowExecute: true
  },
  {
    key: 'conflict-resolution',
    label: 'Conflict Resolution',
    description: 'Verify new memories against existing ones using LLM',
    allowExecute: true
  },
  {
    key: 'quality-deprecation',
    label: 'Quality Deprecation',
    description: 'Deprecate high-confidence extraction artifacts',
    allowExecute: true
  },
  {
    key: 'relation-discovery',
    label: 'Relation Discovery',
    description: 'Strengthen links between memories repeatedly injected together',
    allowExecute: true
  },
  {
    key: 'warning-synthesis',
    label: 'Warning Synthesis',
    description: 'Create warnings from repeated failure patterns',
    allowExecute: true
  },
  {
    key: 'global-promotion',
    label: 'Global Promotion',
    description: 'Elevate project-scoped to global',
    allowExecute: true
  },
  {
    key: 'promotion-suggestions',
    label: 'Promotion Suggestions',
    description: 'Generate CLAUDE.md and skill recommendations',
    allowExecute: false
  }
] as const satisfies MaintenanceOperationInfo[]

export type MaintenanceOperation = typeof MAINTENANCE_OPERATION_DEFINITIONS[number]['key']
export type MaintenanceOperationDefinition = typeof MAINTENANCE_OPERATION_DEFINITIONS[number]

export type { OperationResult } from '../../shared/types.js'

export const MAINTENANCE_OPERATIONS: MaintenanceOperation[] =
  MAINTENANCE_OPERATION_DEFINITIONS.map(definition => definition.key) as MaintenanceOperation[]

export const AUTO_MAINTENANCE_OPERATIONS: MaintenanceOperation[] = [
  'consolidation',
  'cross-type-consolidation',
  'conflict-resolution',
  'quality-deprecation',
  'relation-discovery',
  'warning-synthesis',
  'global-promotion',
  'stale-check'
]

export type MaintenanceProgressCallback = (progress: MaintenanceProgress) => void

export async function runMaintenanceOperation(
  operation: MaintenanceOperation,
  dryRun: boolean,
  config: Config = DEFAULT_CONFIG,
  settings?: MaintenanceSettings,
  onProgress?: MaintenanceProgressCallback
): Promise<OperationResult> {
  const started = Date.now()
  const maintenance = resolveMaintenanceSettings(settings)

  try {
    const payload = await runOperation(operation, dryRun, config, maintenance, onProgress)
    return {
      operation,
      dryRun,
      actions: payload.actions,
      summary: payload.summary,
      candidates: payload.candidates,
      duration: Date.now() - started,
      ...(payload.error ? { error: payload.error } : {})
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      operation,
      dryRun,
      actions: [],
      summary: {},
      candidates: [],
      duration: Date.now() - started,
      error: message
    }
  }
}

export async function runAllMaintenance(
  dryRun: boolean,
  config: Config = DEFAULT_CONFIG,
  settings?: MaintenanceSettings
): Promise<OperationResult[]> {
  const results: OperationResult[] = []
  const maintenance = resolveMaintenanceSettings(settings)
  for (const operation of AUTO_MAINTENANCE_OPERATIONS) {
    results.push(await runMaintenanceOperation(operation, dryRun, config, maintenance))
  }
  return results
}

async function runOperation(
  operation: MaintenanceOperation,
  dryRun: boolean,
  config: Config,
  settings: MaintenanceSettings,
  onProgress?: MaintenanceProgressCallback
): Promise<MaintenanceRunResult> {
  switch (operation) {
    case 'stale-check':
      return runStaleCheck(dryRun, config, settings)
    case 'stale-unused-deprecation':
      return runStaleUnusedDeprecation(dryRun, config, settings)
    case 'low-usage-deprecation':
      return runLowUsageDeprecation(dryRun, config, settings)
    case 'low-usage':
      return runLowUsageCheck(dryRun, config, settings)
    case 'quality-deprecation':
      return runQualityDeprecation(dryRun, config)
    case 'consolidation':
      return runConsolidation(dryRun, config, settings, onProgress)
    case 'cross-type-consolidation':
      return runCrossTypeConsolidation(dryRun, config, settings, onProgress)
    case 'conflict-resolution':
      return runConflictResolution(dryRun, config, settings)
    case 'relation-discovery':
      return runRelationDiscovery(dryRun, config)
    case 'warning-synthesis':
      return runWarningSynthesis(dryRun, config, settings)
    case 'global-promotion':
      return runGlobalPromotion(dryRun, config, settings)
    case 'promotion-suggestions':
      return runPromotionSuggestions(config)
  }
}

async function runPromotionSuggestions(config: Config): Promise<MaintenanceRunResult> {
  const actions: MaintenanceAction[] = []
  const candidates: MaintenanceRunResult['candidates'] = []
  let skillCandidates = 0
  let claudeMdCandidates = 0
  let errors = 0

  try {
    const root = findGitRoot(process.cwd()) ?? process.cwd()
    const { skillDiffs, claudeMdDiffs, skillCandidates: skillCount, claudeMdCandidates: claudeCount } =
      await buildPromotionDiffs(config, root)

    skillCandidates = skillCount
    claudeMdCandidates = claudeCount

    for (const diff of skillDiffs) {
      actions.push({
        type: 'suggestion',
        recordId: diff.record.id,
        snippet: truncateSnippet(diff.record.name || buildRecordSnippet(diff.record)),
        reason: 'skill suggestion',
        details: {
          kind: 'skill',
          action: diff.action,
          targetFile: diff.targetFile,
          diff: diff.diff,
          decisionReason: diff.decisionReason,
          successCount: diff.record.successCount ?? 0
        }
      })
    }

    for (const diff of claudeMdDiffs) {
      actions.push({
        type: 'suggestion',
        recordId: diff.record.id,
        snippet: truncateSnippet(diff.record.what || buildRecordSnippet(diff.record)),
        reason: 'CLAUDE.md suggestion',
        details: {
          kind: 'claude-md',
          action: diff.action,
          targetFile: diff.targetFile,
          diff: diff.diff,
          decisionReason: diff.decisionReason
        }
      })
    }
  } catch (error) {
    errors += 1
    const message = error instanceof Error ? error.message : String(error)
    return { actions, summary: { skillCandidates, claudeMdCandidates, errors }, candidates, error: message }
  }

  return { actions, summary: { skillCandidates, claudeMdCandidates, errors }, candidates }
}
