import { DEFAULT_CONFIG, type Config } from './types.js'
import { findGitRoot } from './context.js'
import { buildPromotionDiffs } from './promotions.js'
import { buildRecordSnippet, truncateSnippet } from './shared.js'
import { loadSettings, type MaintenanceSettings } from './settings.js'
import {
  runStaleCheck,
  runLowUsageDeprecation,
  runLowUsageCheck,
  runConsolidation,
  runConflictResolution,
  runGlobalPromotion,
  runWarningSynthesis,
  type MaintenanceAction,
  type MaintenanceRunResult
} from '../maintenance.js'

export const MAINTENANCE_OPERATION_DEFINITIONS = [
  {
    key: 'stale-check',
    label: 'Stale Check',
    description: 'Find records unused for the configured number of days',
    allowExecute: true
  },
  {
    key: 'low-usage-deprecation',
    label: 'Zero Usage Deprecation',
    description: 'Deprecate records with high retrievals and zero usage',
    allowExecute: true
  },
  {
    key: 'low-usage',
    label: 'Low Usage',
    description: 'Deprecate records below the configured usage ratio',
    allowExecute: true
  },
  {
    key: 'consolidation',
    label: 'Consolidation',
    description: 'Merge duplicate records using the configured similarity threshold',
    allowExecute: true
  },
  {
    key: 'conflict-resolution',
    label: 'Conflict Resolution',
    description: 'Verify new memories against existing ones using LLM',
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
] as const

export type MaintenanceOperation = typeof MAINTENANCE_OPERATION_DEFINITIONS[number]['key']
export type MaintenanceOperationDefinition = typeof MAINTENANCE_OPERATION_DEFINITIONS[number]

export interface OperationResult {
  operation: string
  dryRun: boolean
  actions: MaintenanceAction[]
  summary: Record<string, number>
  candidates: MaintenanceRunResult['candidates']
  duration: number
  error?: string
}

export const MAINTENANCE_OPERATIONS: MaintenanceOperation[] =
  MAINTENANCE_OPERATION_DEFINITIONS.map(definition => definition.key) as MaintenanceOperation[]

function resolveMaintenanceSettings(settings?: MaintenanceSettings): MaintenanceSettings {
  return settings ?? loadSettings()
}

export async function runMaintenanceOperation(
  operation: MaintenanceOperation,
  dryRun: boolean,
  config: Config = DEFAULT_CONFIG,
  settings?: MaintenanceSettings
): Promise<OperationResult> {
  const started = Date.now()
  const maintenance = resolveMaintenanceSettings(settings)

  try {
    const payload = await runOperation(operation, dryRun, config, maintenance)
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
  for (const operation of MAINTENANCE_OPERATIONS) {
    const effectiveDryRun = operation === 'promotion-suggestions' ? true : dryRun
    results.push(await runMaintenanceOperation(operation, effectiveDryRun, config, maintenance))
  }
  return results
}

async function runOperation(
  operation: MaintenanceOperation,
  dryRun: boolean,
  config: Config,
  settings: MaintenanceSettings
): Promise<MaintenanceRunResult> {
  switch (operation) {
    case 'stale-check':
      return runStaleCheck(dryRun, config, settings)
    case 'low-usage-deprecation':
      return runLowUsageDeprecation(dryRun, config, settings)
    case 'low-usage':
      return runLowUsageCheck(dryRun, config, settings)
    case 'consolidation':
      return runConsolidation(dryRun, config, settings)
    case 'conflict-resolution':
      return runConflictResolution(dryRun, config, settings)
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
