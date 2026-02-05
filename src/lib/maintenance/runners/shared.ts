import { buildRecordSnippet, truncateSnippet } from '../../shared.js'
import type { MemoryRecord } from '../../types.js'
import type {
  MaintenanceAction,
  MaintenanceActionDetails,
  MaintenanceActionType,
  MaintenanceCandidateGroup
} from '../../../../shared/types.js'
import type { MaintenanceRunResult } from './types.js'

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function buildActionFromRecord(input: {
  type: MaintenanceActionType
  record: MemoryRecord
  reason: string
  details?: MaintenanceActionDetails
}): MaintenanceAction {
  return buildAction({
    type: input.type,
    recordId: input.record.id,
    snippet: truncateSnippet(buildRecordSnippet(input.record)),
    reason: input.reason,
    details: input.details
  })
}

export function buildAction(input: {
  type: MaintenanceActionType
  recordId?: string
  snippet: string
  reason: string
  details?: MaintenanceActionDetails
}): MaintenanceAction {
  return {
    type: input.type,
    ...(input.recordId ? { recordId: input.recordId } : {}),
    snippet: input.snippet,
    reason: input.reason,
    ...(input.details ? { details: input.details } : {})
  }
}

export function buildResult(
  actions: MaintenanceAction[],
  summary: Record<string, number>,
  candidates: MaintenanceCandidateGroup[]
): MaintenanceRunResult {
  return { actions, summary, candidates }
}

export function buildErrorResult(
  actions: MaintenanceAction[],
  summary: Record<string, number>,
  candidates: MaintenanceCandidateGroup[],
  error: unknown
): MaintenanceRunResult {
  return {
    actions,
    summary,
    candidates,
    error: toErrorMessage(error)
  }
}

export async function applyActionWithDryRun(
  dryRun: boolean,
  actions: MaintenanceAction[],
  action: MaintenanceAction,
  apply: () => Promise<boolean>
): Promise<boolean> {
  if (dryRun) {
    actions.push(action)
    return true
  }

  const updated = await apply()
  if (updated) {
    actions.push(action)
    return true
  }

  return false
}

export function buildDeprecatedRecordsById(
  records: MemoryRecord[]
): (deprecatedIds: string[]) => { id: string; snippet: string | null }[] {
  const recordById = new Map(records.map(record => [record.id, record]))

  return (deprecatedIds: string[]) =>
    deprecatedIds.map(id => {
      const record = recordById.get(id)
      return {
        id,
        snippet: record ? truncateSnippet(buildRecordSnippet(record)) : null
      }
    })
}
