import { DEFAULT_CONFIG, type Config } from '../../types.js'
import { resolveMaintenanceSettings, type MaintenanceSettings } from '../../settings.js'
import { buildCandidateRecord } from '../../shared.js'
import { updateRecord } from '../../milvus.js'
import {
  checkGlobalPromotion,
  findGlobalCandidates,
  GLOBAL_PROMOTION_MIN_CONFIDENCE,
  isConfidenceSufficient,
  promoteToGlobal
} from '../index.js'
import type { MaintenanceAction, MaintenanceCandidateGroup } from '../../../../shared/types.js'
import { applyActionWithDryRun, buildActionFromRecord, buildErrorResult, buildResult } from './shared.js'
import type { MaintenanceRunResult } from './types.js'

export async function runGlobalPromotion(
  dryRun: boolean,
  config: Config = DEFAULT_CONFIG,
  settings?: MaintenanceSettings
): Promise<MaintenanceRunResult> {
  const maintenance = resolveMaintenanceSettings(settings)
  const actions: MaintenanceAction[] = []
  const candidateGroups: MaintenanceCandidateGroup[] = []
  let candidates = 0
  let checked = 0
  let promoted = 0
  let skippedRecent = 0
  let errors = 0

  try {
    const records = await findGlobalCandidates(config, maintenance)
    candidates = records.length

    if (records.length > 0) {
      const candidateRecords = records.map(record =>
        buildCandidateRecord(record, 'eligible for global promotion', { scope: record.scope ?? 'project' })
      )

      candidateGroups.push({
        id: 'global-promotion',
        label: 'Promotion candidates',
        records: candidateRecords
      })
    }

    const cutoff = Date.now() - maintenance.globalPromotionRecheckDays * 24 * 60 * 60 * 1000
    const eligible = records.filter(record => (record.lastGlobalCheck ?? 0) < cutoff)
    skippedRecent = candidates - eligible.length

    const batch = selectPromotionBatch(eligible, maintenance.globalPromotionBatchSize)

    for (const record of batch) {
      checked += 1
      const checkedAt = Date.now()

      try {
        const result = await checkGlobalPromotion(record, config)
        const confidenceOk = isConfidenceSufficient(result.confidence, GLOBAL_PROMOTION_MIN_CONFIDENCE)
        const detail = result.reason
          ? `confidence=${result.confidence} reason=${result.reason}`
          : `confidence=${result.confidence}`

        if (result.shouldPromote && confidenceOk) {
          const action = buildActionFromRecord({
            type: 'promote',
            record,
            reason: detail,
            details: { scope: record.scope ?? 'project' }
          })

          const applied = await applyActionWithDryRun(dryRun, actions, action, () => promoteToGlobal(record.id, config))
          if (applied) {
            promoted += 1
          }
        }

        if (!dryRun) {
          await updateRecord(record.id, { lastGlobalCheck: checkedAt }, config)
        }
      } catch {
        errors += 1
      }
    }
  } catch (error) {
    return buildErrorResult(actions, { candidates, checked, promoted, skippedRecent, errors }, candidateGroups, error)
  }

  return buildResult(actions, { candidates, checked, promoted, skippedRecent, errors }, candidateGroups)
}

function selectPromotionBatch<T>(records: T[], batchSize: number): T[] {
  if (records.length <= batchSize) return records
  const shuffled = [...records]
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled.slice(0, batchSize)
}
