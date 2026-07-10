import { createHash } from 'crypto'
import { JsonStore } from '../file-store.js'
import { asInteger, asStringArray, asTrimmedString, isPlainObject } from '../parsing.js'
import type { MemoryRecord } from '../types.js'
import { buildGeneralizationInput } from './prompts.js'

export type ConsolidationVerdictMode = 'same-type' | 'cross-type'

export interface ConsolidationNoMergeVerdict {
  mode: ConsolidationVerdictMode
  memberIds: string[]
  durableContentHash: string
  reason: string
  checkedAt: number
  model: string
  policyVersion: string
}

export const CONSOLIDATION_VERIFIER_POLICY_VERSION = 'consolidation-verifier-v1'

type VerdictStoreOptions = {
  collection?: string
  baseDir?: string
  now?: number
  backoffDays: number
  deleteInvalid?: boolean
}

const ORDER_INSENSITIVE_ID_ARRAY_KEYS = new Set(['sourceRecordIds'])

function getVerdictStore(baseDir?: string): JsonStore {
  return new JsonStore('consolidation-verdicts', baseDir ? { baseDir } : {})
}

function normalizeMemberIds(records: MemoryRecord[]): string[] {
  return [...new Set(records.map(record => record.id).filter(Boolean))].sort()
}

export function buildConsolidationVerdictKey(
  mode: ConsolidationVerdictMode,
  records: MemoryRecord[]
): string {
  return buildVerdictKeyFromMemberIds(mode, normalizeMemberIds(records))
}

function buildVerdictKeyFromMemberIds(mode: ConsolidationVerdictMode, memberIds: string[]): string {
  const payload = [
    CONSOLIDATION_VERIFIER_POLICY_VERSION,
    mode,
    ...memberIds
  ].join('|')
  return createHash('sha256').update(payload).digest('hex')
}

export function buildConsolidationDurableContentHash(records: MemoryRecord[]): string {
  const durableRecords = [...records]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(record => ({
      id: record.id,
      record: buildGeneralizationInput(record)
    }))
  return createHash('sha256').update(stableSerialize(durableRecords)).digest('hex')
}

export function loadConsolidationNoMergeVerdict(
  mode: ConsolidationVerdictMode,
  records: MemoryRecord[],
  options: VerdictStoreOptions
): ConsolidationNoMergeVerdict | null {
  const memberIds = normalizeMemberIds(records)
  if (memberIds.length < 2) return null

  const key = buildConsolidationVerdictKey(mode, records)
  const store = getVerdictStore(options.baseDir)
  const verdict = store.read<ConsolidationNoMergeVerdict>(key, {
    collection: options.collection,
    errorMessage: '[claude-memory] Failed to read consolidation verdict:',
    coerce: coerceConsolidationNoMergeVerdict,
    fallback: null
  })
  const invalid = (): null => {
    if (options.deleteInvalid) deleteVerdict(store, key, options.collection)
    return null
  }
  if (!verdict) return invalid()
  if (verdict.policyVersion !== CONSOLIDATION_VERIFIER_POLICY_VERSION) return invalid()
  if (verdict.mode !== mode) return invalid()
  if (!sameStrings(verdict.memberIds, memberIds)) return invalid()
  if (verdict.durableContentHash !== buildConsolidationDurableContentHash(records)) return invalid()

  const backoffMs = Math.max(1, options.backoffDays) * 24 * 60 * 60 * 1000
  if (verdict.checkedAt + backoffMs <= (options.now ?? Date.now())) return invalid()
  return verdict
}

export function cleanupConsolidationNoMergeVerdicts(
  options: Omit<VerdictStoreOptions, 'deleteInvalid'>
): number {
  const store = getVerdictStore(options.baseDir)
  const now = options.now ?? Date.now()
  const backoffMs = Math.max(1, options.backoffDays) * 24 * 60 * 60 * 1000
  let deleted = 0

  for (const key of store.list({ collection: options.collection })) {
    const verdict = store.read<ConsolidationNoMergeVerdict>(key, {
      collection: options.collection,
      errorMessage: '[claude-memory] Failed to read consolidation verdict during cleanup:',
      coerce: coerceConsolidationNoMergeVerdict,
      fallback: null
    })
    const validKey = verdict
      ? buildVerdictKeyFromMemberIds(verdict.mode, verdict.memberIds) === key
      : false
    const shouldDelete = !verdict
      || verdict.policyVersion !== CONSOLIDATION_VERIFIER_POLICY_VERSION
      || !validKey
      || verdict.checkedAt + backoffMs <= now
    if (shouldDelete && deleteVerdict(store, key, options.collection)) deleted += 1
  }

  return deleted
}

export function saveConsolidationNoMergeVerdict(
  mode: ConsolidationVerdictMode,
  records: MemoryRecord[],
  reason: string,
  model: string,
  options: Omit<VerdictStoreOptions, 'backoffDays' | 'deleteInvalid'>
): ConsolidationNoMergeVerdict | null {
  const memberIds = normalizeMemberIds(records)
  const normalizedReason = reason.trim()
  const normalizedModel = model.trim()
  if (memberIds.length < 2 || !normalizedReason || !normalizedModel) return null

  const verdict: ConsolidationNoMergeVerdict = {
    mode,
    memberIds,
    durableContentHash: buildConsolidationDurableContentHash(records),
    reason: normalizedReason,
    checkedAt: options.now ?? Date.now(),
    model: normalizedModel,
    policyVersion: CONSOLIDATION_VERIFIER_POLICY_VERSION
  }
  const key = buildConsolidationVerdictKey(mode, records)
  let failed = false
  getVerdictStore(options.baseDir).write(key, verdict, {
    collection: options.collection,
    ensureDir: true,
    pretty: 2,
    onError: error => {
      failed = true
      console.error('[claude-memory] Failed to write consolidation verdict:', error)
    }
  })
  return failed ? null : verdict
}

function coerceConsolidationNoMergeVerdict(value: unknown): ConsolidationNoMergeVerdict | null {
  if (!isPlainObject(value)) return null
  const mode = value.mode === 'same-type' || value.mode === 'cross-type' ? value.mode : null
  const memberIds = asStringArray(value.memberIds, { trim: true, filterEmpty: true, unique: true }).sort()
  const durableContentHash = asTrimmedString(value.durableContentHash)
  const reason = asTrimmedString(value.reason)
  const checkedAt = asInteger(value.checkedAt)
  const model = asTrimmedString(value.model)
  const policyVersion = asTrimmedString(value.policyVersion)
  if (!mode || memberIds.length < 2 || !durableContentHash || !reason || checkedAt === null || !model || !policyVersion) {
    return null
  }
  return { mode, memberIds, durableContentHash, reason, checkedAt, model, policyVersion }
}

function sameStrings(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function stableSerialize(value: unknown): string {
  return JSON.stringify(canonicalize(value)) ?? 'null'
}

function canonicalize(value: unknown, parentKey?: string): unknown {
  if (Array.isArray(value)) {
    const entries = value.map(entry => canonicalize(entry))
    if (parentKey && ORDER_INSENSITIVE_ID_ARRAY_KEYS.has(parentKey) && entries.every(entry => typeof entry === 'string')) {
      return [...entries].sort((a, b) => String(a).localeCompare(String(b)))
    }
    return entries
  }
  if (!isPlainObject(value)) return value

  const normalized: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    const entry = value[key]
    if (entry !== undefined) normalized[key] = canonicalize(entry, key)
  }
  return normalized
}

function deleteVerdict(store: JsonStore, key: string, collection?: string): boolean {
  return store.delete(key, {
    collection,
    continueOnError: true,
    onError: error => console.error('[claude-memory] Failed to delete consolidation verdict:', error)
  })
}
