import { DEFAULT_CONFIG, type Config } from '../../types.js'
import { resolveMaintenanceSettings, type MaintenanceSettings } from '../../settings.js'
import { buildCandidateRecord } from '../../shared.js'
import { checkValidity, findLowUsageHighRetrieval, findLowUsageRecords, findStaleRecords, findStaleUnusedRecords } from '../scans.js'
import { markDeprecated } from '../operations.js'
import type { MaintenanceAction, MaintenanceCandidateGroup } from '../../../../shared/types.js'
import { applyActionWithDryRun, buildActionFromRecord, buildErrorResult, buildResult } from './shared.js'
import type { MaintenanceRunResult } from './types.js'

const DAY_MS = 24 * 60 * 60 * 1000

export async function runStaleCheck(
  dryRun: boolean,
  config: Config = DEFAULT_CONFIG,
  settings?: MaintenanceSettings
): Promise<MaintenanceRunResult> {
  const maintenance = resolveMaintenanceSettings(settings)
  const actions: MaintenanceAction[] = []
  const candidateGroups: MaintenanceCandidateGroup[] = []
  let checked = 0
  let deprecated = 0
  let errors = 0

  try {
    const records = await findStaleRecords(config, maintenance)
    checked = records.length

    if (records.length > 0) {
      const candidateRecords = records.map(record => {
        const lastUsed = record.lastUsed ?? record.timestamp ?? 0
        const ageDays = lastUsed ? Math.floor((Date.now() - lastUsed) / DAY_MS) : 0
        const reason = ageDays > 0 ? `last used ${ageDays}d ago` : 'stale record'
        return buildCandidateRecord(record, reason, { ageDays })
      })

      candidateGroups.push({
        id: 'stale-candidates',
        label: 'Stale records',
        records: candidateRecords
      })
    }

    for (const record of records) {
      try {
        const validity = await checkValidity(record, maintenance)
        if (validity.valid) continue

        const reason = validity.reason ?? 'invalid'
        const action = buildActionFromRecord({
          type: 'deprecate',
          record,
          reason,
          details: { validityReason: reason }
        })

        const applied = await applyActionWithDryRun(
          dryRun,
          actions,
          action,
          () => markDeprecated(record.id, config, { reason: `stale-check:${reason}` })
        )
        if (applied) {
          deprecated += 1
        }
      } catch {
        errors += 1
      }
    }
  } catch (error) {
    return buildErrorResult(actions, { checked, deprecated, errors }, candidateGroups, error)
  }

  return buildResult(actions, { checked, deprecated, errors }, candidateGroups)
}

export async function runLowUsageDeprecation(
  dryRun: boolean,
  config: Config = DEFAULT_CONFIG,
  settings?: MaintenanceSettings
): Promise<MaintenanceRunResult> {
  const maintenance = resolveMaintenanceSettings(settings)
  const actions: MaintenanceAction[] = []
  const candidateGroups: MaintenanceCandidateGroup[] = []
  let candidates = 0
  let deprecated = 0
  let errors = 0

  try {
    const records = await findLowUsageHighRetrieval(config, maintenance)
    candidates = records.length

    if (records.length > 0) {
      const candidateRecords = records.map(record => {
        const retrievalCount = record.retrievalCount ?? 0
        const usageCount = record.usageCount ?? 0
        const reason = `zero-usage:${retrievalCount} retrievals`
        return buildCandidateRecord(record, reason, { retrievalCount, usageCount })
      })

      candidateGroups.push({
        id: 'low-usage-zero',
        label: 'Zero usage candidates',
        records: candidateRecords
      })
    }

    for (const record of records) {
      const retrievalCount = record.retrievalCount ?? 0
      const usageCount = record.usageCount ?? 0
      const reason = `zero-usage:${retrievalCount} retrievals`
      const action = buildActionFromRecord({
        type: 'deprecate',
        record,
        reason,
        details: { retrievalCount, usageCount }
      })

      try {
        const applied = await applyActionWithDryRun(
          dryRun,
          actions,
          action,
          () => markDeprecated(record.id, config, { reason: 'low-usage-zero' })
        )
        if (applied) {
          deprecated += 1
        }
      } catch {
        errors += 1
      }
    }
  } catch (error) {
    return buildErrorResult(actions, { candidates, deprecated, errors }, candidateGroups, error)
  }

  return buildResult(actions, { candidates, deprecated, errors }, candidateGroups)
}

/**
 * Deprecate old memories that have never been used.
 * These are memories that were extracted but never proved useful.
 */
export async function runStaleUnusedDeprecation(
  dryRun: boolean,
  config: Config = DEFAULT_CONFIG,
  settings?: MaintenanceSettings
): Promise<MaintenanceRunResult> {
  const maintenance = resolveMaintenanceSettings(settings)
  const actions: MaintenanceAction[] = []
  const candidateGroups: MaintenanceCandidateGroup[] = []
  let candidates = 0
  let deprecated = 0
  let errors = 0

  try {
    const records = await findStaleUnusedRecords(config, maintenance)
    candidates = records.length

    if (records.length > 0) {
      const candidateRecords = records.map(record => {
        const ageInDays = Math.floor((Date.now() - (record.timestamp ?? 0)) / DAY_MS)
        const reason = `stale-unused:${ageInDays} days old, never used`
        return buildCandidateRecord(record, reason, { ageInDays, usageCount: 0 })
      })

      candidateGroups.push({
        id: 'stale-unused',
        label: 'Stale unused candidates',
        records: candidateRecords
      })
    }

    for (const record of records) {
      const ageInDays = Math.floor((Date.now() - (record.timestamp ?? 0)) / DAY_MS)
      const reason = `stale-unused:${ageInDays} days old, never used`
      const action = buildActionFromRecord({
        type: 'deprecate',
        record,
        reason,
        details: { ageInDays, usageCount: 0 }
      })

      try {
        const applied = await applyActionWithDryRun(
          dryRun,
          actions,
          action,
          () => markDeprecated(record.id, config, { reason: 'stale-unused' })
        )
        if (applied) {
          deprecated += 1
        }
      } catch {
        errors += 1
      }
    }
  } catch (error) {
    return buildErrorResult(actions, { candidates, deprecated, errors }, candidateGroups, error)
  }

  return buildResult(actions, { candidates, deprecated, errors }, candidateGroups)
}

export async function runLowUsageCheck(
  dryRun: boolean,
  config: Config = DEFAULT_CONFIG,
  settings?: MaintenanceSettings
): Promise<MaintenanceRunResult> {
  const maintenance = resolveMaintenanceSettings(settings)
  const actions: MaintenanceAction[] = []
  const candidateGroups: MaintenanceCandidateGroup[] = []
  let candidates = 0
  let deprecated = 0
  let errors = 0

  try {
    const records = await findLowUsageRecords(config, maintenance)
    candidates = records.length

    if (records.length > 0) {
      const candidateRecords = records.map(record => {
        const retrievalCount = record.retrievalCount ?? 1
        const usageCount = record.usageCount ?? 0
        const ratio = usageCount / Math.max(retrievalCount, 1)
        const reason = `low-usage:${Math.round(ratio * 100)}% over ${retrievalCount} retrievals`
        return buildCandidateRecord(record, reason, { retrievalCount, usageCount, ratio })
      })

      candidateGroups.push({
        id: 'low-usage-ratio',
        label: 'Low usage candidates',
        records: candidateRecords
      })
    }

    for (const record of records) {
      const retrievalCount = record.retrievalCount ?? 1
      const usageCount = record.usageCount ?? 0
      const ratio = usageCount / Math.max(retrievalCount, 1)
      const reason = `low-usage:${Math.round(ratio * 100)}% over ${retrievalCount} retrievals`
      const action = buildActionFromRecord({
        type: 'deprecate',
        record,
        reason,
        details: { retrievalCount, usageCount, ratio }
      })

      try {
        const applied = await applyActionWithDryRun(
          dryRun,
          actions,
          action,
          () => markDeprecated(record.id, config, { reason: 'low-usage-ratio' })
        )
        if (applied) {
          deprecated += 1
        }
      } catch {
        errors += 1
      }
    }
  } catch (error) {
    return buildErrorResult(actions, { candidates, deprecated, errors }, candidateGroups, error)
  }

  return buildResult(actions, { candidates, deprecated, errors }, candidateGroups)
}
