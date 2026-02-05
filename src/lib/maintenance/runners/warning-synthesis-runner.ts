import { DEFAULT_CONFIG, type Config } from '../../types.js'
import { resolveMaintenanceSettings, type MaintenanceSettings } from '../../settings.js'
import { runWarningSynthesis as runWarningSynthesisInternal } from '../index.js'
import { buildErrorResult, buildResult } from './shared.js'
import type { MaintenanceRunResult } from './types.js'

export async function runWarningSynthesis(
  dryRun: boolean,
  config: Config = DEFAULT_CONFIG,
  settings?: MaintenanceSettings
): Promise<MaintenanceRunResult> {
  const maintenance = resolveMaintenanceSettings(settings)
  try {
    const result = await runWarningSynthesisInternal(dryRun, config, maintenance)
    return buildResult(result.actions, result.summary, result.candidates)
  } catch (error) {
    return buildErrorResult([], {}, [], error)
  }
}
