#!/usr/bin/env node
/**
 * Post-session hook launcher - spawns worker as detached process for fast exit.
 *
 * This file also exports the core logic for testing.
 */

import fs, { appendFileSync } from 'fs'
import { spawn } from 'child_process'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { randomUUID } from 'crypto'
import { extractRecords } from '../lib/extract.js'
import { findGitRoot } from '../lib/context.js'
import { embedBatch } from '../lib/embed.js'
import { buildEmbeddingInput, escapeFilterValue, findSimilar, insertRecord, updateRecord, type FlushMode } from '../lib/lancedb.js'
import { markDeprecated } from '../lib/maintenance/operations.js'
import { resolveAttributionScope } from '../lib/scope-attribution.js'
import { loadSettings } from '../lib/settings.js'
import { isProcessEntrypoint } from '../lib/shared.js'
import { findStaticDocOverlap, loadStaticProjectDocs } from '../lib/static-docs.js'
import { parseTranscript, computeIncrementalStartIndex, sliceTranscript, type Transcript } from '../lib/transcript.js'
import { reconcileIncomingRecord } from '../lib/write-reconciliation.js'
import {
  DEFAULT_CONFIG,
  type Config,
  type ExtractionFailure,
  type MemoryRecord,
  type ExtractionHookInput,
  type ExtractionRecordOutcome,
  type InjectedMemoryEntry,
  type MemoryWriteHintEvent,
  type TokenUsage
} from '../lib/types.js'
import { canonicalizePath, CLAUDE_MEMORY_ROOT, DEBUG_LOG_FILE } from '../lib/paths.js'
import { loadConfig } from '../lib/config.js'
import { resetSessionInjectionLedger } from '../lib/session-tracking.js'
import { addTokenUsage } from '../lib/token-usage.js'
import type { ExtractionTimingStage } from '../lib/extraction-timings.js'
import { POST_SESSION_WORKER_SCRIPT } from '../lib/runtime-artifacts.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export type PostSessionTimingStage = ExtractionTimingStage

export type PostSessionTimings = Partial<Record<PostSessionTimingStage, number>>

export interface PostSessionDiagnostic {
  level: 'warn'
  stage: 'embedding'
  records?: number
  cause: string
}

export interface PostSessionResult {
  inserted: number
  updated: number
  skipped: number
  failed: number
  supersedesMissing?: number
  records: MemoryRecord[]
  recordOutcomes?: PostSessionRecordOutcome[]
  insertedIds: string[]
  updatedIds: string[]
  transcript?: Transcript
  reason?: 'clear' | 'no_transcript' | 'no_records' | 'too_short' | 'no_new_events' | 'wrong_event'
  tokenUsage?: TokenUsage
  extractionError?: ExtractionFailure
  extractedEventCount?: number
  isIncremental?: boolean
  hasRememberMarker?: boolean
  /** Helpful injected memory IDs rated during the merged extraction LLM call. */
  helpfulMemoryIds?: string[]
  /** True when usefulness rating already ran inside extractRecords (skips duplicate LLM call). */
  usefulnessRatedDuringExtraction?: boolean
  timings?: PostSessionTimings
  diagnostics?: PostSessionDiagnostic[]
}

export interface PostSessionRecordOutcome {
  id: string
  outcome: ExtractionRecordOutcome
  storedRecordId?: string
  dedupSimilarity?: number
  storeError?: string
}

/**
 * Core post-session hook logic. Exported for testing.
 *
 * Extracts records from transcript and stores them in LanceDB.
 */
export async function handlePostSession(
  input: ExtractionHookInput,
  config: Config = DEFAULT_CONFIG,
  options: {
    flush?: FlushMode
    recordAugmenter?: (record: MemoryRecord, transcript: Transcript) => MemoryRecord
    /** Memories injected during this session - used for change detection */
    injectedMemories?: InjectedMemoryEntry[]
    /** Event count from a prior extraction of this session -- enables incremental mode */
    previousExtractionEventCount?: number
    /** How many user turns to overlap for context (default: from settings) */
    contextOverlapTurns?: number
    /** Planned run ID for token-attribution correlation. */
    plannedRunId?: string
    /** Native memory_write calls captured outside the transcript. */
    memoryWriteHints?: MemoryWriteHintEvent[]
  } = {}
): Promise<PostSessionResult> {
  const timings: PostSessionTimings = {}

  // Accept both SessionEnd and PreCompact events
  if (input.hook_event_name !== 'SessionEnd' && input.hook_event_name !== 'PreCompact') {
    return {
      inserted: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      records: [],
      insertedIds: [],
      updatedIds: [],
      reason: 'wrong_event'
    }
  }

  // Skip extraction if session was cleared (only applies to SessionEnd)
  if (input.hook_event_name === 'SessionEnd' && input.reason === 'clear') {
    return {
      inserted: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      records: [],
      insertedIds: [],
      updatedIds: [],
      reason: 'clear'
    }
  }

  if (!input.transcript_path || !fs.existsSync(input.transcript_path)) {
    return {
      inserted: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      records: [],
      insertedIds: [],
      updatedIds: [],
      reason: 'no_transcript'
    }
  }

  const parseStart = Date.now()
  const fullTranscript = await parseTranscript(input.transcript_path)
  timings.parse = Date.now() - parseStart
  if (fullTranscript.parseErrors > 0) {
    console.error(`[claude-memory] Transcript parse warnings: ${fullTranscript.parseErrors}`)
  }

  const totalEventCount = fullTranscript.events.length
  const settings = loadSettings()
  const memoryWriteHints = settings.enableMemoryWriteHints
    ? options.memoryWriteHints?.filter(Boolean) ?? []
    : []
  const hasMemoryWriteHints = memoryWriteHints.length > 0

  // Incremental extraction: skip if no new events since last extraction
  const priorEventCount = options.previousExtractionEventCount
  let isIncremental = false
  let extractionTranscript = fullTranscript

  if (priorEventCount !== undefined && priorEventCount > 0) {
    if (totalEventCount <= priorEventCount && !hasMemoryWriteHints) {
      return {
        inserted: 0,
        updated: 0,
        skipped: 0,
        failed: 0,
        records: [],
        insertedIds: [],
        updatedIds: [],
        reason: 'no_new_events',
        transcript: fullTranscript,
        extractedEventCount: totalEventCount,
        timings
      }
    }

    const sliceStart = Date.now()
    const overlapTurns = options.contextOverlapTurns ?? settings.extractionContextOverlapTurns
    const extractionBoundary = Math.min(priorEventCount, totalEventCount)
    const startIndex = computeIncrementalStartIndex(fullTranscript.events, extractionBoundary, overlapTurns)
    extractionTranscript = sliceTranscript(fullTranscript, startIndex)
    timings.slice = Date.now() - sliceStart
    isIncremental = true
    console.error(
      `[claude-memory] Incremental extraction: ${Math.max(0, totalEventCount - priorEventCount)} new events` +
      `${hasMemoryWriteHints ? `, ${memoryWriteHints.length} memory_write hint(s)` : ''}, ` +
      `starting from event ${startIndex} (${overlapTurns}-turn overlap)`
    )
  }

  // Use extraction transcript for min-length check so we skip if only overlap, no real new content
  const transcript = extractionTranscript

  // Remember marker is detected during streaming parseTranscript() without reading the entire file into memory.
  const hasRememberMarker = Boolean(fullTranscript.hasRememberMarker)

  // Skip extraction for very short conversations (~4 chars per token)
  // unless user explicitly flagged content with /remember
  if (!hasRememberMarker && !hasMemoryWriteHints) {
    const minChars = settings.extractionMinTokens * 4
    if (minChars > 0) {
      const conversationChars = transcript.messages.reduce((sum, m) => sum + m.text.length, 0)
      if (conversationChars < minChars) {
        return {
          inserted: 0,
          updated: 0,
          skipped: 0,
          failed: 0,
          records: [],
          insertedIds: [],
          updatedIds: [],
          reason: 'too_short',
          transcript: fullTranscript,
          timings
        }
      }
    }
  }

  const gitRoot = findGitRoot(input.cwd)
  const attribution = resolveAttributionScope(input.cwd, gitRoot)
  const projectRoot = attribution.isCatchAll ? undefined : attribution.project
  const staticDocs = loadStaticProjectDocs(projectRoot, input.cwd)
  const llmStart = Date.now()
  const {
    records: extractedRecords,
    helpfulMemoryIds,
    usefulnessRated,
    tokenUsage,
    error
  } = await extractRecords(transcript, {
    sessionId: input.session_id,
    runId: options.plannedRunId,
    cwd: input.cwd,
    project: projectRoot,
    transcriptPath: input.transcript_path,
    injectedMemories: options.injectedMemories,
    memoryWriteHints,
    staticDocsDigest: staticDocs.digest || undefined,
    isIncremental,
    maxTranscriptChars: settings.maxTranscriptChars
  }, config)
  timings.llm = Date.now() - llmStart

  // Use fullTranscript for recordAugmenter (e.g. sourceExcerpt matching) -- it has more context
  const records = options.recordAugmenter
    ? extractedRecords.map(record => options.recordAugmenter!(record, fullTranscript))
    : extractedRecords

  if (records.length === 0) {
    return {
      inserted: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      records: [],
      insertedIds: [],
      updatedIds: [],
      reason: 'no_records',
      transcript: fullTranscript,
      extractedEventCount: totalEventCount,
      isIncremental: isIncremental || undefined,
      hasRememberMarker: hasRememberMarker || undefined,
      ...(usefulnessRated ? { helpfulMemoryIds, usefulnessRatedDuringExtraction: true } : {}),
      tokenUsage,
      extractionError: error,
      timings
    }
  }

  const embedStart = Date.now()
  const embeddingResult = await precomputeEmbeddings(records, config)
  timings.embed = Date.now() - embedStart
  const diagnostics: PostSessionDiagnostic[] = embeddingResult.error
    ? [{
        level: 'warn',
        stage: 'embedding',
        records: embeddingResult.targetCount,
        cause: embeddingResult.error
      }]
    : []

  let inserted = 0
  let updated = 0
  let skipped = 0
  let failed = 0
  let supersedesMissing = 0
  const insertedIds: string[] = []
  const updatedIds: string[] = []
  const recordOutcomes: PostSessionRecordOutcome[] = []

  const flushMode = options.flush ?? 'always'

  let skipUnembeddedRecords = Boolean(
    embeddingResult.error && isEmbeddingOutageError(embeddingResult.error)
  )
  let unembeddedFailureCause = embeddingResult.error

  const storeStart = Date.now()
  let totalTokenUsage = tokenUsage
  const useWriteReconciliation = settings.enableWriteReconciliation !== false
  const reconcileThreshold = settings.writeReconciliationThreshold ?? 0.70
  for (const record of records) {
    if (skipUnembeddedRecords && (!record.embedding || record.embedding.length === 0)) {
      failed += 1
      recordOutcomes.push(buildRecordOutcome(record, 'failed', {
        storeError: unembeddedFailureCause ?? 'embedding service unavailable'
      }))
      continue
    }
    try {
      // Tier-0 static doc dedup: skip non-/remember records already verbatim-covered in CLAUDE.md/AGENTS.md.
      if (!hasRememberMarker && staticDocs.entries.length > 0) {
        const staticOverlap = findStaticDocOverlap(record, staticDocs, 0.80, 6)
        if (staticOverlap) {
          skipped += 1
          recordOutcomes.push(buildRecordOutcome(record, 'skipped'))
          console.error(`[claude-memory] Skipped record already covered by Tier-0 doc ${staticOverlap.matchedLabel} (overlap=${staticOverlap.overlapRatio})`)
          continue
        }
      }

      const dedupFilter = record.supersedes
        ? `id <> '${escapeFilterValue(record.supersedes)}'`
        : undefined
      const searchThreshold = useWriteReconciliation
        ? Math.min(reconcileThreshold, settings.extractionDedupThreshold)
        : settings.extractionDedupThreshold
      const searchLimit = useWriteReconciliation ? 5 : 1
      const matches = await findSimilar(
        record,
        searchThreshold,
        searchLimit,
        config,
        dedupFilter,
        useWriteReconciliation ? { crossType: true, includeSharedScopes: true } : undefined
      )

      if (matches.length > 0) {
        const topMatch = matches[0]
        const sameTypeMatch = matches.find(m => m.record.type === record.type)
        const deterministicUpdates = sameTypeMatch ? buildUpdates(sameTypeMatch.record, record) : null

        // Fast-path 1: truly identical same-type duplicate -> NOOP without LLM spend
        const coreIdentical = Boolean(sameTypeMatch && hasIdenticalCoreStatement(sameTypeMatch.record, record))
        if (sameTypeMatch && coreIdentical && deterministicUpdates && Object.keys(deterministicUpdates).length === 0 && sameTypeMatch.similarity >= searchThreshold) {
          skipped += 1
          const outcome = buildRecordOutcome(record, 'skipped', {
            storedRecordId: sameTypeMatch.record.id,
            dedupSimilarity: sameTypeMatch.similarity
          })
          recordOutcomes.push(outcome)
          await applySupersedesWithOutcome(outcome, record, sameTypeMatch.record.id, config, (count) => { supersedesMissing += count }, () => { failed += 1 })
          continue
        }

        // Fast-path 2: high-similarity pure empty-field enrichment on identical core statement -> UPDATE without LLM spend
        const isPureEnrichment = Boolean(
          sameTypeMatch
          && coreIdentical
          && sameTypeMatch.similarity >= settings.extractionDedupThreshold
          && deterministicUpdates
          && Object.keys(deterministicUpdates).length > 0
        )

        if (!isPureEnrichment && useWriteReconciliation) {
          const decision = await reconcileIncomingRecord(record, matches, config, {
            sessionId: input.session_id,
            runId: options.plannedRunId
          })

          if (decision) {
            if (decision.tokenUsage) {
              totalTokenUsage = addTokenUsage(totalTokenUsage, decision.tokenUsage)
            }
            if (decision.action === 'NOOP' && decision.targetRecord) {
              skipped += 1
              const outcome = buildRecordOutcome(record, 'skipped', {
                storedRecordId: decision.targetRecord.id,
                dedupSimilarity: decision.targetSimilarity
              })
              recordOutcomes.push(outcome)
              await applySupersedesWithOutcome(outcome, record, decision.targetRecord.id, config, (count) => { supersedesMissing += count }, () => { failed += 1 })
              continue
            }

            if (decision.action === 'UPDATE' && decision.targetRecord) {
              const target = decision.targetRecord
              const baseUpdates = target.type === record.type ? buildUpdates(target, record) : {}
              const substantiveUpdates = {
                ...baseUpdates,
                ...(decision.mergedUpdates ?? {})
              } as Partial<MemoryRecord>
              if (Object.keys(substantiveUpdates).length === 0) {
                skipped += 1
                const outcome = buildRecordOutcome(record, 'skipped', {
                  storedRecordId: target.id,
                  dedupSimilarity: decision.targetSimilarity
                })
                recordOutcomes.push(outcome)
                await applySupersedesWithOutcome(outcome, record, target.id, config, (count) => { supersedesMissing += count }, () => { failed += 1 })
                continue
              }
              const mergedUpdates = {
                ...substantiveUpdates,
                lastUsed: Date.now()
              } as Partial<MemoryRecord>
              const stored = await updateRecord(target.id, mergedUpdates, config, { flush: flushMode })
              if (!stored) {
                failed += 1
                recordOutcomes.push({ id: record.id, outcome: 'failed', storeError: 'record disappeared during update' })
                continue
              }
              updated += 1
              updatedIds.push(target.id)
              const outcome = buildRecordOutcome(record, 'updated', {
                storedRecordId: target.id,
                dedupSimilarity: decision.targetSimilarity
              })
              recordOutcomes.push(outcome)
              await applySupersedesWithOutcome(outcome, record, target.id, config, (count) => { supersedesMissing += count }, () => { failed += 1 })
              continue
            }

            if (decision.action === 'SUPERSEDE' && decision.targetRecord) {
              const prepared = applyUsageCounters({
                ...record,
                supersedes: record.supersedes ?? decision.targetRecord.id
              })
              await insertRecord(prepared, config, { flush: flushMode })
              inserted += 1
              insertedIds.push(prepared.id)
              const outcome = buildRecordOutcome(prepared, 'inserted', {
                storedRecordId: prepared.id,
                dedupSimilarity: decision.targetSimilarity
              })
              recordOutcomes.push(outcome)
              await applySupersedesWithOutcome(outcome, prepared, prepared.id, config, (count) => { supersedesMissing += count }, () => { failed += 1 })
              if (record.supersedes && record.supersedes !== decision.targetRecord.id) {
                try {
                  const deprecatedNeighbor = await markDeprecated(decision.targetRecord.id, config, {
                    supersedingRecordId: prepared.id,
                    reason: `write-reconcile:superseded-by:${prepared.id}`
                  })
                  if (!deprecatedNeighbor) {
                    supersedesMissing += 1
                  }
                } catch (deprecateError) {
                  console.error(`[claude-memory] Failed to deprecate reconciled neighbor ${decision.targetRecord.id}:`, deprecateError)
                }
              }
              continue
            }

            // decision.action === 'ADD': fall through to insertRecord below
          } else if (sameTypeMatch && sameTypeMatch.similarity >= settings.extractionDedupThreshold) {
            // Fallback to threshold dedup if reconciliation LLM is unavailable
            const existing = sameTypeMatch.record
            const updates = buildUpdates(existing, record)
            if (Object.keys(updates).length > 0) {
              const stored = await updateRecord(existing.id, updates, config, { flush: flushMode })
              if (!stored) {
                failed += 1
                recordOutcomes.push({ id: record.id, outcome: 'failed', storeError: 'record disappeared during update' })
                continue
              }
              updated += 1
              updatedIds.push(existing.id)
              const outcome = buildRecordOutcome(record, 'updated', {
                storedRecordId: existing.id,
                dedupSimilarity: sameTypeMatch.similarity
              })
              recordOutcomes.push(outcome)
              await applySupersedesWithOutcome(outcome, record, existing.id, config, (count) => { supersedesMissing += count }, () => { failed += 1 })
              continue
            }
            skipped += 1
            const outcome = buildRecordOutcome(record, 'skipped', {
              storedRecordId: existing.id,
              dedupSimilarity: sameTypeMatch.similarity
            })
            recordOutcomes.push(outcome)
            await applySupersedesWithOutcome(outcome, record, existing.id, config, (count) => { supersedesMissing += count }, () => { failed += 1 })
            continue
          }
        } else if (sameTypeMatch && (isPureEnrichment || !useWriteReconciliation)) {
          const existing = sameTypeMatch.record
          const updates = buildUpdates(existing, record)
          if (Object.keys(updates).length > 0) {
            const stored = await updateRecord(existing.id, updates, config, { flush: flushMode })
            if (!stored) {
              failed += 1
              recordOutcomes.push({
                id: record.id,
                outcome: 'failed',
                storeError: 'record disappeared during update'
              })
              console.error(`[claude-memory] Failed to store record ${record.id ?? record.type}: record disappeared during update`)
              continue
            }
            updated += 1
            updatedIds.push(existing.id)
            const outcome = buildRecordOutcome(record, 'updated', {
              storedRecordId: existing.id,
              dedupSimilarity: sameTypeMatch.similarity
            })
            recordOutcomes.push(outcome)
            await applySupersedesWithOutcome(outcome, record, existing.id, config, (count) => { supersedesMissing += count }, () => { failed += 1 })
          } else {
            skipped += 1
            const outcome = buildRecordOutcome(record, 'skipped', {
              storedRecordId: existing.id,
              dedupSimilarity: sameTypeMatch.similarity
            })
            recordOutcomes.push(outcome)
            await applySupersedesWithOutcome(outcome, record, existing.id, config, (count) => { supersedesMissing += count }, () => { failed += 1 })
          }
          continue
        }
        // If no same-type match and write reconciliation disabled, skip only if topMatch >= threshold
        if (!useWriteReconciliation && topMatch.similarity >= settings.extractionDedupThreshold) {
          skipped += 1
          recordOutcomes.push(buildRecordOutcome(record, 'skipped', {
            storedRecordId: topMatch.record.id,
            dedupSimilarity: topMatch.similarity
          }))
          continue
        }
      }

      const prepared = applyUsageCounters(record)
      await insertRecord(prepared, config, { flush: flushMode })
      inserted += 1
      insertedIds.push(prepared.id)
      const outcome = buildRecordOutcome(prepared, 'inserted', { storedRecordId: prepared.id })
      recordOutcomes.push(outcome)
      await applySupersedesWithOutcome(outcome, prepared, prepared.id, config, (count) => { supersedesMissing += count }, () => { failed += 1 })
    } catch (error) {
      const storeError = sanitizeStoreError(error)
      failed += 1
      recordOutcomes.push(buildRecordOutcome(record, 'failed', {
        storeError
      }))
      console.error(`[claude-memory] Failed to store record ${record.id ?? record.type}:`, error)
      if (
        embeddingResult.error
        && (!record.embedding || record.embedding.length === 0)
        && isEmbeddingOutageError(storeError)
      ) {
        skipUnembeddedRecords = true
        unembeddedFailureCause = storeError
      }
    }
  }

  timings.store = Date.now() - storeStart

  return {
    inserted, updated, skipped, failed, supersedesMissing, records, recordOutcomes, insertedIds, updatedIds,
    transcript: fullTranscript, tokenUsage: totalTokenUsage, extractionError: error,
    extractedEventCount: totalEventCount,
    isIncremental: isIncremental || undefined,
    hasRememberMarker: hasRememberMarker || undefined,
    ...(usefulnessRated ? { helpfulMemoryIds, usefulnessRatedDuringExtraction: true } : {}),
    timings,
    diagnostics: diagnostics.length > 0 ? diagnostics : undefined
  }
}

function sameStringList(a: string[] | undefined, b: string[] | undefined): boolean {
  const left = a ?? []
  const right = b ?? []
  return left.length === right.length && left.every((item, idx) => item === right[idx])
}

function hasIdenticalCoreStatement(existing: MemoryRecord, incoming: MemoryRecord): boolean {
  if (existing.type !== incoming.type) return false
  switch (existing.type) {
    case 'discovery': {
      const inc = incoming as typeof existing
      return existing.what === inc.what
        && existing.where === inc.where
        && (!inc.evidence || existing.evidence === inc.evidence)
    }
    case 'command': {
      const inc = incoming as typeof existing
      return existing.command === inc.command
        && existing.outcome === inc.outcome
        && (!inc.resolution || existing.resolution === inc.resolution)
    }
    case 'error': {
      const inc = incoming as typeof existing
      return existing.errorText === inc.errorText
        && existing.resolution === inc.resolution
        && (!inc.cause || existing.cause === inc.cause)
    }
    case 'procedure': {
      const inc = incoming as typeof existing
      return existing.name === inc.name && sameStringList(existing.steps, inc.steps)
    }
    case 'warning': {
      const inc = incoming as typeof existing
      return existing.avoid === inc.avoid
        && existing.useInstead === inc.useInstead
        && existing.severity === inc.severity
        && (!inc.reason || existing.reason === inc.reason)
    }
  }
}

function buildRecordOutcome(
  record: MemoryRecord,
  outcome: ExtractionRecordOutcome,
  options: {
    storedRecordId?: string
    dedupSimilarity?: number
    storeError?: string
  } = {}
): PostSessionRecordOutcome {
  return {
    id: record.id,
    outcome,
    ...(options.storedRecordId ? { storedRecordId: options.storedRecordId } : {}),
    ...(typeof options.dedupSimilarity === 'number' ? { dedupSimilarity: roundSimilarity(options.dedupSimilarity) } : {}),
    ...(options.storeError ? { storeError: options.storeError } : {})
  }
}

async function applySupersedesWithOutcome(
  outcome: PostSessionRecordOutcome,
  record: MemoryRecord,
  storedId: string,
  config: Config,
  addSupersedesMissing: (count: number) => void,
  incrementFailed: () => void
): Promise<void> {
  try {
    addSupersedesMissing(await applySupersedesDeprecation(record, storedId, config))
  } catch (error) {
    incrementFailed()
    outcome.storeError = sanitizeStoreError(error)
    console.error(`[claude-memory] Failed to store record ${record.id ?? record.type}:`, error)
  }
}

function sanitizeStoreError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.split('\n')[0].slice(0, 200)
}

function isEmbeddingOutageError(message: string): boolean {
  return /timed out|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|fetch failed|\b50[234]\b/i.test(message)
}

function roundSimilarity(similarity: number): number {
  return Number(similarity.toFixed(3))
}

async function applySupersedesDeprecation(
  record: MemoryRecord,
  storedId: string,
  config: Config
): Promise<number> {
  if (!record.supersedes || record.supersedes === storedId) return 0

  const applied = await markDeprecated(record.supersedes, config, {
    supersedingRecordId: storedId,
    reason: `extraction:superseded-by:${storedId}`
  })
  if (applied) return 0

  console.error(`[claude-memory] supersedes target missing: ${record.supersedes}`)
  return 1
}

async function precomputeEmbeddings(
  records: MemoryRecord[],
  config: Config
): Promise<{ targetCount: number; error?: string }> {
  const inputs: string[] = []
  const targets: MemoryRecord[] = []

  for (const record of records) {
    if (record.embedding && record.embedding.length > 0) continue
    inputs.push(buildEmbeddingInput(record))
    targets.push(record)
  }

  if (inputs.length === 0) return { targetCount: 0 }

  try {
    const embeddings = await embedBatch(inputs, config)
    if (embeddings.length !== targets.length) {
      throw new Error(`Embedding batch size mismatch: expected ${targets.length}, got ${embeddings.length}`)
    }
    embeddings.forEach((embedding, index) => {
      targets[index].embedding = embedding
    })
    return { targetCount: targets.length }
  } catch (error) {
    console.error('[claude-memory] Failed to precompute embeddings:', error)
    return { targetCount: targets.length, error: sanitizeStoreError(error) }
  }
}

export function buildUpdates(existing: MemoryRecord, incoming: MemoryRecord): Partial<MemoryRecord> {
  const updates: Partial<MemoryRecord> = {}

  const { successDelta, failureDelta } = deriveUsageDelta(incoming)
  if (successDelta !== 0) {
    updates.successCount = (existing.successCount ?? 0) + successDelta
  }
  if (failureDelta !== 0) {
    updates.failureCount = (existing.failureCount ?? 0) + failureDelta
  }

  if (incoming.scope === 'global' && existing.scope !== 'global') {
    updates.scope = 'global'
  }

  const isSharedScope = existing.scope === 'environment' || existing.scope === 'global'
  if (!isSharedScope && !existing.project && incoming.project) updates.project = incoming.project
  if (!existing.sourceSessionId && incoming.sourceSessionId) updates.sourceSessionId = incoming.sourceSessionId
  if (!existing.sourceExcerpt && incoming.sourceExcerpt) updates.sourceExcerpt = incoming.sourceExcerpt
  if (incoming.supersedes && incoming.supersedes !== existing.id && existing.supersedes !== incoming.supersedes) {
    updates.supersedes = incoming.supersedes
  }

  if (existing.type === 'command' && incoming.type === 'command') {
    const commandUpdates = updates as Partial<typeof existing>
    const contextUpdates: Partial<typeof existing.context> = {}
    if (!isSharedScope && incoming.context.project) contextUpdates.project = incoming.context.project
    if (incoming.context.cwd) contextUpdates.cwd = incoming.context.cwd
    if (incoming.context.intent) contextUpdates.intent = incoming.context.intent
    if (Object.keys(contextUpdates).length > 0) {
      commandUpdates.context = { ...existing.context, ...contextUpdates }
    }
    if (!existing.truncatedOutput && incoming.truncatedOutput) commandUpdates.truncatedOutput = incoming.truncatedOutput
    if (!existing.resolution && incoming.resolution) commandUpdates.resolution = incoming.resolution
  }

  if (existing.type === 'error' && incoming.type === 'error') {
    const errorUpdates = updates as Partial<typeof existing>
    const contextUpdates: Partial<typeof existing.context> = {}
    if (incoming.context.file) contextUpdates.file = incoming.context.file
    if (incoming.context.tool) contextUpdates.tool = incoming.context.tool
    if (Object.keys(contextUpdates).length > 0) {
      errorUpdates.context = { ...existing.context, ...contextUpdates }
    }
    if (!existing.cause && incoming.cause) errorUpdates.cause = incoming.cause
  }

  if (existing.type === 'procedure' && incoming.type === 'procedure') {
    const procedureUpdates = updates as Partial<typeof existing>
    const contextUpdates: Partial<typeof existing.context> = {}
    if (!isSharedScope && incoming.context.project) contextUpdates.project = incoming.context.project
    if (Object.keys(contextUpdates).length > 0) {
      procedureUpdates.context = { ...existing.context, ...contextUpdates }
    }
    if (!existing.verification && incoming.verification) procedureUpdates.verification = incoming.verification
    if (!existing.prerequisites && incoming.prerequisites) procedureUpdates.prerequisites = incoming.prerequisites
  }

  if (existing.type === 'discovery' && incoming.type === 'discovery') {
    const discoveryUpdates = updates as Partial<typeof existing>
    if (!existing.where && incoming.where) discoveryUpdates.where = incoming.where
    if (!existing.evidence && incoming.evidence) discoveryUpdates.evidence = incoming.evidence
  }

  // Only bump lastUsed on verified success or substantive field updates (not pure failure-only bumps).
  const hasSubstantiveUpdate = Object.keys(updates).some(key => key !== 'failureCount')
  if (hasSubstantiveUpdate) {
    updates.lastUsed = Date.now()
  }

  return updates
}

export function applyUsageCounters(record: MemoryRecord): MemoryRecord {
  const { successDelta, failureDelta } = deriveUsageDelta(record)
  return {
    ...record,
    successCount: (record.successCount ?? 0) + successDelta,
    failureCount: (record.failureCount ?? 0) + failureDelta,
    lastUsed: Date.now()
  }
}

export function deriveUsageDelta(record: MemoryRecord): { successDelta: number; failureDelta: number } {
  if (record.type === 'command') {
    if (record.outcome === 'success') return { successDelta: 1, failureDelta: 0 }
    if (record.outcome === 'failure') return { successDelta: 0, failureDelta: 1 }
    return { successDelta: 0, failureDelta: 1 }
  }

  if (record.type === 'error') {
    return { successDelta: 0, failureDelta: 1 }
  }

  return { successDelta: 0, failureDelta: 0 }
}

const DEBUG = process.env.CLAUDE_MEMORY_DEBUG === '1'

function debugLog(msg: string): void {
  if (!DEBUG) return
  const ts = new Date().toISOString()
  const line = `[launcher] ${ts} ${msg}\n`
  console.error(line.trim())
  try {
    appendFileSync(DEBUG_LOG_FILE, line)
  } catch {
    // ignore
  }
}

/**
 * Launcher main - spawns worker as detached process and exits immediately.
 *
 * Writes stdin to a temp file and passes the path to the worker.
 * This completely decouples the launcher from data transfer so Claude Code
 * doesn't wait for the stdin fd to close.
 */
function launcherMain(): void {
  const startTime = Date.now()
  debugLog(`START pid=${process.pid}`)

  // Read stdin synchronously (it's small, ~300 bytes)
  let input = ''
  const BUFSIZE = 1024
  const buf = Buffer.alloc(BUFSIZE)
  let bytesRead: number

  try {
    while ((bytesRead = fs.readSync(0, buf, 0, BUFSIZE, null)) > 0) {
      input += buf.toString('utf8', 0, bytesRead)
    }
  } catch (e: unknown) {
    // EOF or error - that's fine
    if ((e as NodeJS.ErrnoException).code !== 'EOF' && (e as NodeJS.ErrnoException).code !== 'EAGAIN') {
      debugLog(`stdin read error: ${e}`)
    }
  }

  debugLog(`Read stdin: ${input.length} bytes in ${Date.now() - startTime}ms`)

  if (!input.trim()) {
    debugLog('Empty input, exiting')
    return
  }

  // Immediately reset the compaction-scoped injection ledger on PreCompact so
  // any prompt submitted right after compaction starts fresh without racing the worker.
  try {
    const parsed = JSON.parse(input) as { hook_event_name?: unknown; session_id?: unknown; cwd?: unknown }
    if (parsed.hook_event_name === 'PreCompact' && typeof parsed.session_id === 'string' && parsed.session_id) {
      const cwd = typeof parsed.cwd === 'string' ? parsed.cwd : ''
      const configRoot = (cwd ? findGitRoot(cwd) : undefined) ?? (cwd ? canonicalizePath(cwd) : process.cwd())
      const config = loadConfig(configRoot)
      resetSessionInjectionLedger(parsed.session_id, config.lancedb.table)
      debugLog(`Reset compaction injection ledger for session=${parsed.session_id}`)
    }
  } catch {
    // Non-fatal: worker will also reset ledger on PreCompact.
  }

  // Write to temp file
  const tempFile = join(CLAUDE_MEMORY_ROOT, `hook-input-${process.pid}-${Date.now()}-${randomUUID()}.json`)
  try {
    fs.mkdirSync(dirname(tempFile), { recursive: true })
    fs.writeFileSync(tempFile, input, { flag: 'wx' })
    debugLog(`Wrote temp file: ${tempFile}`)
  } catch (e) {
    debugLog(`Failed to write temp file: ${e}`)
    return
  }

  const cleanupTempFile = (): void => {
    try {
      fs.unlinkSync(tempFile)
      debugLog(`Cleaned up temp file after spawn failure: ${tempFile}`)
    } catch {
      // ignore
    }
  }

  // Determine worker path
  const workerPath = __filename.endsWith('.ts')
    ? join(__dirname, 'post-session-worker.ts')
    : join(__dirname, POST_SESSION_WORKER_SCRIPT)
  const usesTsWorker = workerPath.endsWith('.ts')

  debugLog(`Spawning worker: ${workerPath}`)

  // Spawn worker with temp file path as argument
  // Stdin/stdout stay ignored; stderr goes to a regular file fd so worker diagnostics survive.
  const command = usesTsWorker ? 'npx' : 'node'
  const args = usesTsWorker ? ['tsx', workerPath, tempFile] : [workerPath, tempFile]
  let stderrFd: number | undefined
  let stderrStdio: 'ignore' | number = 'ignore'

  try {
    fs.mkdirSync(dirname(DEBUG_LOG_FILE), { recursive: true })
    stderrFd = fs.openSync(DEBUG_LOG_FILE, 'a')
    stderrStdio = stderrFd
  } catch (error) {
    debugLog(`Failed to open worker stderr log: ${error}`)
  }

  let child: ReturnType<typeof spawn> | null = null
  try {
    child = spawn(command, args, {
      detached: true,
      stdio: ['ignore', 'ignore', stderrStdio]
    })
  } finally {
    if (stderrFd !== undefined) {
      try {
        fs.closeSync(stderrFd)
      } catch (error) {
        debugLog(`Failed to close parent worker stderr fd: ${error}`)
      }
    }
  }

  if (!child) return

  child.on('error', error => {
    debugLog(`Worker spawn failed: ${error}`)
    console.error('[claude-memory] Failed to spawn post-session worker:', error)
    cleanupTempFile()
    process.exitCode = 2
  })

  debugLog(`Worker spawned pid=${child.pid}, took ${Date.now() - startTime}ms`)

  child.unref()

  debugLog(`EXIT after ${Date.now() - startTime}ms`)
}

// Only run launcher when executed directly (not imported)
if (isProcessEntrypoint(import.meta.url)) {
  try {
    launcherMain()
    process.exitCode = 0
  } catch (error) {
    console.error('[claude-memory] post-session launcher failed:', error)
    process.exitCode = 2
  }
}
