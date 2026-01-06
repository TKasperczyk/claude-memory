import { DEFAULT_CONFIG, SIMILARITY_THRESHOLDS, type Config } from './types.js'
import { findClaudeMdCandidates, findSkillCandidates } from './promotions.js'
import { buildRecordSnippet, truncateSnippet } from './shared.js'
import {
  runStaleCheck,
  runLowUsageDeprecation,
  runLowUsageCheck,
  runConsolidation,
  runGlobalPromotion,
  type MaintenanceAction,
  type MaintenanceRunResult
} from '../maintenance.js'

const CONSOLIDATION_SIMILARITY_PERCENT = Math.round(SIMILARITY_THRESHOLDS.CONSOLIDATION * 100)

export const MAINTENANCE_OPERATION_DEFINITIONS = [
  {
    key: 'stale-check',
    label: 'Stale Check',
    description: 'Find records unused for 90+ days',
    allowExecute: true
  },
  {
    key: 'low-usage-deprecation',
    label: 'Zero Usage Deprecation',
    description: 'Deprecate records with 10+ retrievals and zero usage',
    allowExecute: true
  },
  {
    key: 'low-usage',
    label: 'Low Usage',
    description: 'Deprecate records with <10% usefulness',
    allowExecute: true
  },
  {
    key: 'consolidation',
    label: 'Consolidation',
    description: `Merge duplicate records (>=${CONSOLIDATION_SIMILARITY_PERCENT}% similar)`,
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
  duration: number
  error?: string
}

export const MAINTENANCE_OPERATIONS: MaintenanceOperation[] =
  MAINTENANCE_OPERATION_DEFINITIONS.map(definition => definition.key) as MaintenanceOperation[]

export async function runMaintenanceOperation(
  operation: MaintenanceOperation,
  dryRun: boolean,
  config: Config = DEFAULT_CONFIG
): Promise<OperationResult> {
  const started = Date.now()

  try {
    const payload = await runOperation(operation, dryRun, config)
    return {
      operation,
      dryRun,
      actions: payload.actions,
      summary: payload.summary,
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
      duration: Date.now() - started,
      error: message
    }
  }
}

export async function runAllMaintenance(
  dryRun: boolean,
  config: Config = DEFAULT_CONFIG
): Promise<OperationResult[]> {
  const results: OperationResult[] = []
  for (const operation of MAINTENANCE_OPERATIONS) {
    const effectiveDryRun = operation === 'promotion-suggestions' ? true : dryRun
    results.push(await runMaintenanceOperation(operation, effectiveDryRun, config))
  }
  return results
}

async function runOperation(
  operation: MaintenanceOperation,
  dryRun: boolean,
  config: Config
): Promise<MaintenanceRunResult> {
  switch (operation) {
    case 'stale-check':
      return runStaleCheck(dryRun, config)
    case 'low-usage-deprecation':
      return runLowUsageDeprecation(dryRun, config)
    case 'low-usage':
      return runLowUsageCheck(dryRun, config)
    case 'consolidation':
      return runConsolidation(dryRun, config)
    case 'global-promotion':
      return runGlobalPromotion(dryRun, config)
    case 'promotion-suggestions':
      return runPromotionSuggestions(config)
  }
}

async function runPromotionSuggestions(config: Config): Promise<MaintenanceRunResult> {
  const actions: MaintenanceAction[] = []
  let skillCandidates = 0
  let claudeMdCandidates = 0
  let errors = 0

  try {
    const [skillCandidatesList, claudeCandidates] = await Promise.all([
      findSkillCandidates(config),
      findClaudeMdCandidates(config)
    ])

    skillCandidates = skillCandidatesList.length
    claudeMdCandidates = claudeCandidates.global.length
      + Object.values(claudeCandidates.byProject).reduce((total, group) => total + group.length, 0)

    for (const record of skillCandidatesList) {
      actions.push({
        type: 'suggestion',
        recordId: record.id,
        snippet: truncateSnippet(record.name || buildRecordSnippet(record)),
        reason: 'skill suggestion',
        details: {
          kind: 'skill',
          successCount: record.successCount ?? 0
        }
      })
    }

    for (const record of claudeCandidates.global) {
      actions.push({
        type: 'suggestion',
        recordId: record.id,
        snippet: truncateSnippet(record.what || buildRecordSnippet(record)),
        reason: 'CLAUDE.md suggestion (global)',
        details: { kind: 'claude-md', scope: 'global' }
      })
    }

    for (const [project, records] of Object.entries(claudeCandidates.byProject)) {
      for (const record of records) {
        actions.push({
          type: 'suggestion',
          recordId: record.id,
          snippet: truncateSnippet(record.what || buildRecordSnippet(record)),
          reason: `CLAUDE.md suggestion (${project})`,
          details: { kind: 'claude-md', scope: project }
        })
      }
    }
  } catch (error) {
    errors += 1
    const message = error instanceof Error ? error.message : String(error)
    return { actions, summary: { skillCandidates, claudeMdCandidates, errors }, error: message }
  }

  return { actions, summary: { skillCandidates, claudeMdCandidates, errors } }
}
