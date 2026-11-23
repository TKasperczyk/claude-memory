import { createHash } from 'crypto'
import { JsonStore } from '../file-store.js'
import { asInteger, asStringArray, asTrimmedString, isPlainObject } from '../parsing.js'
import type { DiscoveryRecord } from '../types.js'
import { buildGeneralizationInput } from './prompts.js'

export interface CurrentnessNoChangeVerdict {
  memberIds: string[]
  durableContentHash: string
  checkedAt: number
  model: string
  policyVersion: string
}

export const CURRENTNESS_VERIFIER_POLICY_VERSION = 'currentness-verifier-v1'

type VerdictStoreOptions = {
  collection?: string
  baseDir?: string
  now?: number
  backoffDays: number
  deleteInvalid?: boolean
}

function getVerdictStore(baseDir?: string): JsonStore {
  return new JsonStore('currentness-verdicts', baseDir ? { baseDir } : {})
}

function normalizeMemberIds(records: DiscoveryRecord[]): string[] {
  return [...new Set(records.map(record => record.id).filter(Boolean))].sort()
}

export function buildCurrentnessVerdictKey(records: DiscoveryRecord[]): string {
  return buildVerdictKeyFromMemberIds(normalizeMemberIds(records))
}

function buildVerdictKeyFromMemberIds(memberIds: string[]): string {
  const payload = [CURRENTNESS_VERIFIER_POLICY_VERSION, ...memberIds].join('|')
  return createHash('sha256').update(payload).digest('hex')
}

export function buildCurrentnessDurableContentHash(records: DiscoveryRecord[]): string {
  const durableRecords = [...records]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(record => ({
      id: record.id,
      timestamp: record.timestamp ?? 0,
      record: buildGeneralizationInput(record)
    }))
  return createHash('sha256').update(stableSerialize(durableRecords)).digest('hex')
}

export function loadCurrentnessNoChangeVerdict(
  records: DiscoveryRecord[],
  options: VerdictStoreOptions
): CurrentnessNoChangeVerdict | null {
  const memberIds = normalizeMemberIds(records)
  if (memberIds.length < 2) return null

  const key = buildCurrentnessVerdictKey(records)
  const store = getVerdictStore(options.baseDir)
  const verdict = store.read<CurrentnessNoChangeVerdict>(key, {
    collection: options.collection,
    errorMessage: '[claude-memory] Failed to read currentness verdict:',
    coerce: coerceCurrentnessNoChangeVerdict,
    fallback: null
  })
  const invalid = (): null => {
    if (options.deleteInvalid) deleteVerdict(store, key, options.collection)
    return null
  }
  if (!verdict) return invalid()
  if (verdict.policyVersion !== CURRENTNESS_VERIFIER_POLICY_VERSION) return invalid()
  if (!sameStrings(verdict.memberIds, memberIds)) return invalid()
  if (verdict.durableContentHash !== buildCurrentnessDurableContentHash(records)) return invalid()

  const backoffMs = Math.max(1, options.backoffDays) * 24 * 60 * 60 * 1000
  if (verdict.checkedAt + backoffMs <= (options.now ?? Date.now())) return invalid()
  return verdict
}

export function saveCurrentnessNoChangeVerdict(
  records: DiscoveryRecord[],
  model: string,
  options: Omit<VerdictStoreOptions, 'backoffDays' | 'deleteInvalid'>
): CurrentnessNoChangeVerdict | null {
  const memberIds = normalizeMemberIds(records)
  const normalizedModel = model.trim()
  if (memberIds.length < 2 || !normalizedModel) return null

  const verdict: CurrentnessNoChangeVerdict = {
    memberIds,
    durableContentHash: buildCurrentnessDurableContentHash(records),
    checkedAt: options.now ?? Date.now(),
    model: normalizedModel,
    policyVersion: CURRENTNESS_VERIFIER_POLICY_VERSION
  }
  const key = buildCurrentnessVerdictKey(records)
  let failed = false
  getVerdictStore(options.baseDir).write(key, verdict, {
    collection: options.collection,
    ensureDir: true,
    pretty: 2,
    onError: error => {
      failed = true
      console.error('[claude-memory] Failed to write currentness verdict:', error)
    }
  })
  return failed ? null : verdict
}

export function cleanupCurrentnessNoChangeVerdicts(
  options: Omit<VerdictStoreOptions, 'deleteInvalid'>
): number {
  const store = getVerdictStore(options.baseDir)
  const now = options.now ?? Date.now()
  const backoffMs = Math.max(1, options.backoffDays) * 24 * 60 * 60 * 1000
  let deleted = 0

  for (const key of store.list({ collection: options.collection })) {
    const verdict = store.read<CurrentnessNoChangeVerdict>(key, {
      collection: options.collection,
      errorMessage: '[claude-memory] Failed to read currentness verdict during cleanup:',
      coerce: coerceCurrentnessNoChangeVerdict,
      fallback: null
    })
    const validKey = verdict
      ? buildVerdictKeyFromMemberIds(verdict.memberIds) === key
      : false
    const shouldDelete = !verdict
      || verdict.policyVersion !== CURRENTNESS_VERIFIER_POLICY_VERSION
      || !validKey
      || verdict.checkedAt + backoffMs <= now
    if (shouldDelete && deleteVerdict(store, key, options.collection)) deleted += 1
  }

  return deleted
}

function coerceCurrentnessNoChangeVerdict(value: unknown): CurrentnessNoChangeVerdict | null {
  if (!isPlainObject(value)) return null
  const memberIds = asStringArray(value.memberIds, { trim: true, filterEmpty: true, unique: true }).sort()
  const durableContentHash = asTrimmedString(value.durableContentHash)
  const checkedAt = asInteger(value.checkedAt)
  const model = asTrimmedString(value.model)
  const policyVersion = asTrimmedString(value.policyVersion)
  if (memberIds.length < 2 || !durableContentHash || checkedAt === null || !model || !policyVersion) {
    return null
  }
  return { memberIds, durableContentHash, checkedAt, model, policyVersion }
}

function sameStrings(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function stableSerialize(value: unknown): string {
  return JSON.stringify(canonicalize(value)) ?? 'null'
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(entry => canonicalize(entry))
  }
  if (!isPlainObject(value)) return value

  const normalized: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    const entry = value[key]
    if (entry !== undefined) normalized[key] = canonicalize(entry)
  }
  return normalized
}

function deleteVerdict(store: JsonStore, key: string, collection?: string): boolean {
  return store.delete(key, {
    collection,
    continueOnError: true,
    onError: error => console.error('[claude-memory] Failed to delete currentness verdict:', error)
  })
}
