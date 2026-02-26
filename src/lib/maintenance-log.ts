import { randomUUID } from 'crypto'
import {
  asBoolean,
  asInteger,
  asNumber,
  asRecordType,
  asString,
  asStringArray,
  asTrimmedString,
  isPlainObject
} from './parsing.js'
import { JsonStore, isDefaultCollection } from './file-store.js'
import { loadSettings } from './settings.js'
import type {
  MaintenanceAction,
  MaintenanceActionDetails,
  MaintenanceActionType,
  MaintenanceCandidateGroup,
  MaintenanceCandidateRecord,
  MaintenanceRun,
  MaintenanceRunSummary,
  MaintenanceTrigger,
  OperationResult
} from '../../shared/types.js'

export type { MaintenanceRun, MaintenanceRunSummary, MaintenanceTrigger } from '../../shared/types.js'

const maintenanceRunStore = new JsonStore('maintenance-runs')

function emptyMaintenanceRunSummary(): MaintenanceRunSummary {
  return {
    totalActions: 0,
    totalDeprecated: 0,
    totalUpdated: 0,
    totalMerged: 0,
    totalPromoted: 0,
    totalSuggestions: 0,
    operationsRun: 0,
    operationsFailed: 0
  }
}

function hasOperationError(result: OperationResult): boolean {
  return Boolean(asTrimmedString(result.error))
}

function sumOperationDurations(results: OperationResult[]): number {
  return results.reduce((total, result) => {
    const duration = Number.isFinite(result.duration) ? Math.max(0, Math.trunc(result.duration)) : 0
    return total + duration
  }, 0)
}

function normalizeOperations(operations: string[], results: OperationResult[]): string[] {
  const normalized = asStringArray(operations, { trim: true, filterEmpty: true, unique: true })
  if (normalized.length > 0) return normalized
  return asStringArray(results.map(result => result.operation), { trim: true, filterEmpty: true, unique: true })
}

function normalizeActionType(value: unknown): MaintenanceActionType | undefined {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (
      normalized === 'deprecate'
      || normalized === 'update'
      || normalized === 'merge'
      || normalized === 'promote'
      || normalized === 'suggestion'
    ) {
      return normalized as MaintenanceActionType
    }
  }
  return undefined
}

function normalizeTrigger(value: unknown): MaintenanceTrigger | undefined {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'cli' || normalized === 'dashboard' || normalized === 'auto') {
      return normalized as MaintenanceTrigger
    }
  }
  return undefined
}

export function aggregateResults(results: OperationResult[]): MaintenanceRunSummary {
  const summary = emptyMaintenanceRunSummary()

  for (const result of results) {
    summary.operationsRun += 1
    if (hasOperationError(result)) summary.operationsFailed += 1

    const actions = Array.isArray(result.actions) ? result.actions : []
    summary.totalActions += actions.length

    for (const action of actions) {
      switch (action.type) {
        case 'deprecate':
          summary.totalDeprecated += 1
          break
        case 'update':
          summary.totalUpdated += 1
          break
        case 'merge':
          summary.totalMerged += 1
          break
        case 'promote':
          summary.totalPromoted += 1
          break
        case 'suggestion':
          summary.totalSuggestions += 1
          break
      }
    }
  }

  return summary
}

export function buildMaintenanceRun(
  results: OperationResult[],
  opts: { dryRun: boolean; trigger: MaintenanceTrigger; operations: string[] }
): MaintenanceRun {
  const normalizedResults = Array.isArray(results) ? results : []
  const summary = aggregateResults(normalizedResults)

  return {
    runId: randomUUID(),
    timestamp: Date.now(),
    dryRun: opts.dryRun,
    trigger: opts.trigger,
    operations: normalizeOperations(opts.operations, normalizedResults),
    results: normalizedResults,
    summary,
    duration: sumOperationDurations(normalizedResults),
    hasErrors: summary.operationsFailed > 0
  }
}

export function cleanupOldMaintenanceRunLogs(collection?: string): void {
  const settings = loadSettings()
  const daysToKeep = settings.maintenanceRunRetentionDays
  const cutoff = Date.now() - Math.max(daysToKeep, 1) * 24 * 60 * 60 * 1000

  try {
    maintenanceRunStore.cleanupByAge({
      collection,
      cutoffMs: cutoff,
      includeLegacyForDefault: isDefaultCollection(collection)
    })
  } catch (error) {
    console.error('[claude-memory] Failed to clean up maintenance run logs:', error)
  }
}

function readMaintenanceRun(runId: string, collection?: string): MaintenanceRun | null {
  return maintenanceRunStore.read(runId, {
    collection,
    includeLegacyForDefault: isDefaultCollection(collection),
    errorMessage: '[claude-memory] Failed to read maintenance run log:',
    coerce: data => coerceMaintenanceRun(data, runId),
    fallback: null
  })
}

export function saveMaintenanceRun(run: MaintenanceRun, collection?: string): void {
  try {
    // Cleanup happens on save to avoid extra I/O when maintenance never runs.
    cleanupOldMaintenanceRunLogs(collection)
    maintenanceRunStore.write(run.runId, run, {
      collection,
      ensureDir: true,
      pretty: 2
    })
  } catch (error) {
    console.error('[claude-memory] Failed to write maintenance run log:', error)
  }
}

export function getMaintenanceRun(runId: string, collection?: string): MaintenanceRun | null {
  return readMaintenanceRun(runId, collection)
}

export function listMaintenanceRuns(collection?: string): MaintenanceRun[] {
  try {
    const ids = maintenanceRunStore.list({
      collection,
      includeLegacyForDefault: isDefaultCollection(collection)
    })
    const runs: MaintenanceRun[] = []

    for (const runId of ids) {
      const run = getMaintenanceRun(runId, collection)
      if (run) runs.push(run)
    }

    runs.sort((a, b) => b.timestamp - a.timestamp)
    return runs
  } catch (error) {
    console.error('[claude-memory] Failed to list maintenance runs:', error)
    return []
  }
}

export function getLastMaintenanceRun(collection?: string): MaintenanceRun | null {
  const runs = listMaintenanceRuns(collection)
  return runs[0] ?? null
}

export function deleteMaintenanceRun(runId: string, collection?: string): boolean {
  try {
    return maintenanceRunStore.delete(runId, {
      collection,
      includeLegacyForDefault: isDefaultCollection(collection)
    })
  } catch (error) {
    console.error('[claude-memory] Failed to delete maintenance run log:', error)
    throw error
  }
}

function coerceMaintenanceRun(value: unknown, runId: string): MaintenanceRun | null {
  if (!isPlainObject(value)) return null
  const record = value

  const results = coerceOperationResults(record.results)
  const summary = coerceMaintenanceRunSummary(record.summary, results)
  const duration = asInteger(record.duration)

  return {
    runId: asString(record.runId) ?? runId,
    timestamp: asInteger(record.timestamp) ?? Date.now(),
    dryRun: asBoolean(record.dryRun) ?? false,
    trigger: normalizeTrigger(record.trigger) ?? 'dashboard',
    operations: normalizeOperations(asStringArray(record.operations), results),
    results,
    summary,
    duration: duration === null ? sumOperationDurations(results) : Math.max(0, duration),
    hasErrors: asBoolean(record.hasErrors) ?? summary.operationsFailed > 0
  }
}

function coerceMaintenanceRunSummary(value: unknown, results: OperationResult[]): MaintenanceRunSummary {
  const fallback = aggregateResults(results)
  if (!isPlainObject(value)) return fallback

  return {
    totalActions: Math.max(0, asInteger(value.totalActions) ?? fallback.totalActions),
    totalDeprecated: Math.max(0, asInteger(value.totalDeprecated) ?? fallback.totalDeprecated),
    totalUpdated: Math.max(0, asInteger(value.totalUpdated) ?? fallback.totalUpdated),
    totalMerged: Math.max(0, asInteger(value.totalMerged) ?? fallback.totalMerged),
    totalPromoted: Math.max(0, asInteger(value.totalPromoted) ?? fallback.totalPromoted),
    totalSuggestions: Math.max(0, asInteger(value.totalSuggestions) ?? fallback.totalSuggestions),
    operationsRun: Math.max(0, asInteger(value.operationsRun) ?? fallback.operationsRun),
    operationsFailed: Math.max(0, asInteger(value.operationsFailed) ?? fallback.operationsFailed)
  }
}

function coerceOperationResults(value: unknown): OperationResult[] {
  if (!Array.isArray(value)) return []
  return value
    .map(entry => coerceOperationResult(entry))
    .filter((entry): entry is OperationResult => Boolean(entry))
}

function coerceOperationResult(value: unknown): OperationResult | null {
  if (!isPlainObject(value)) return null
  const record = value

  const operation = asTrimmedString(record.operation)
  if (!operation) return null

  const error = asTrimmedString(record.error)

  return {
    operation,
    dryRun: asBoolean(record.dryRun) ?? false,
    actions: coerceMaintenanceActions(record.actions),
    summary: coerceSummaryMap(record.summary),
    candidates: coerceCandidateGroups(record.candidates),
    duration: Math.max(0, asInteger(record.duration) ?? 0),
    ...(error ? { error } : {})
  }
}

function coerceMaintenanceActions(value: unknown): MaintenanceAction[] {
  if (!Array.isArray(value)) return []
  return value
    .map(entry => coerceMaintenanceAction(entry))
    .filter((entry): entry is MaintenanceAction => Boolean(entry))
}

function coerceMaintenanceAction(value: unknown): MaintenanceAction | null {
  if (!isPlainObject(value)) return null
  const record = value

  const type = normalizeActionType(record.type)
  const snippet = asTrimmedString(record.snippet)
  const reason = asTrimmedString(record.reason)
  if (!type || !snippet || !reason) return null

  const recordId = asTrimmedString(record.recordId)
  const details = coerceActionDetails(record.details)

  return {
    type,
    ...(recordId ? { recordId } : {}),
    snippet,
    reason,
    ...(details ? { details } : {})
  }
}

function coerceActionDetails(value: unknown): MaintenanceActionDetails | undefined {
  if (!isPlainObject(value)) return undefined
  const details: Record<string, unknown> = {}

  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'string' || typeof raw === 'boolean') {
      details[key] = raw
      continue
    }

    const numeric = asNumber(raw)
    if (numeric !== null) {
      details[key] = numeric
      continue
    }

    if (Array.isArray(raw)) {
      const ids = asStringArray(raw, { trim: true, filterEmpty: true, unique: true })
      if (ids.length > 0) {
        details[key] = ids
        continue
      }

      const objects = raw
        .map(entry => coerceActionDetailObject(entry))
        .filter((entry): entry is Record<string, string | number | boolean> => Boolean(entry))
      if (objects.length > 0) {
        details[key] = objects
        continue
      }
    }

    if (isPlainObject(raw)) {
      details[key] = raw
    }
  }

  return Object.keys(details).length > 0 ? details as MaintenanceActionDetails : undefined
}

function coerceActionDetailObject(value: unknown): Record<string, string | number | boolean> | null {
  if (!isPlainObject(value)) return null
  const entry: Record<string, string | number | boolean> = {}

  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'string' || typeof raw === 'boolean') {
      entry[key] = raw
      continue
    }
    const numeric = asNumber(raw)
    if (numeric !== null) {
      entry[key] = numeric
    }
  }

  return Object.keys(entry).length > 0 ? entry : null
}

function coerceSummaryMap(value: unknown): Record<string, number> {
  if (!isPlainObject(value)) return {}
  const summary: Record<string, number> = {}

  for (const [key, raw] of Object.entries(value)) {
    const parsed = asInteger(raw)
    if (parsed === null) continue
    summary[key] = parsed
  }

  return summary
}

function coerceCandidateGroups(value: unknown): MaintenanceCandidateGroup[] {
  if (!Array.isArray(value)) return []
  return value
    .map(entry => coerceCandidateGroup(entry))
    .filter((entry): entry is MaintenanceCandidateGroup => Boolean(entry))
}

function coerceCandidateGroup(value: unknown): MaintenanceCandidateGroup | null {
  if (!isPlainObject(value)) return null
  const record = value

  const id = asTrimmedString(record.id)
  const label = asTrimmedString(record.label)
  if (!id || !label) return null

  const reason = asTrimmedString(record.reason)
  const records = coerceCandidateRecords(record.records)

  return {
    id,
    label,
    ...(reason ? { reason } : {}),
    records
  }
}

function coerceCandidateRecords(value: unknown): MaintenanceCandidateRecord[] {
  if (!Array.isArray(value)) return []
  return value
    .map(entry => coerceCandidateRecord(entry))
    .filter((entry): entry is MaintenanceCandidateRecord => Boolean(entry))
}

function coerceCandidateRecord(value: unknown): MaintenanceCandidateRecord | null {
  if (!isPlainObject(value)) return null
  const record = value

  const id = asTrimmedString(record.id)
  const type = asRecordType(record.type)
  const snippet = asTrimmedString(record.snippet)
  const reason = asTrimmedString(record.reason)
  if (!id || !type || !snippet || !reason) return null

  const details = coerceCandidateDetails(record.details)

  return {
    id,
    type,
    snippet,
    reason,
    ...(details ? { details } : {})
  }
}

function coerceCandidateDetails(value: unknown): Record<string, number | string | boolean> | undefined {
  if (!isPlainObject(value)) return undefined
  const details: Record<string, number | string | boolean> = {}

  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'string' || typeof raw === 'boolean') {
      details[key] = raw
      continue
    }
    const numeric = asNumber(raw)
    if (numeric !== null) {
      details[key] = numeric
    }
  }

  return Object.keys(details).length > 0 ? details : undefined
}
