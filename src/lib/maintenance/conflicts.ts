import { CLAUDE_CODE_SYSTEM_PROMPT } from '../anthropic.js'
import { createLogger } from '../logger.js'
import {
  DEFAULT_CONFIG,
  type Config,
  type MemoryRecord
} from '../types.js'
import { batchUpdateRecords, buildFilter, findSimilar, queryRecords, updateRecord, vectorSearchSimilar } from '../lancedb.js'
import { resolveMaintenanceSettings, type MaintenanceSettings } from '../settings.js'
import { isPlainObject, isToolUseBlock, type ToolUseBlock } from '../parsing.js'
import {
  buildCandidateRecord,
  buildExactText,
  buildRecordSnippet,
  normalizeExactText,
  truncateSnippet
} from '../shared.js'
import type { MaintenanceCandidateGroup } from '../../../shared/types.js'
import {
  CONFLICT_ADJUDICATION_MAX_TOKENS,
  CONFLICT_ADJUDICATION_PROMPT,
  CONFLICT_ADJUDICATION_TOOL,
  CONFLICT_ADJUDICATION_TOOL_NAME,
  CONTRADICTION_MAX_TOKENS,
  CONTRADICTION_PROMPT,
  buildGeneralizationInput,
  extractJsonObject,
  extractResponseText,
  getAnthropicClient
} from './prompts.js'
import { filterContradictionMerge, markDeprecated } from './operations.js'
import { QUERY_PAGE_SIZE, fetchRecords, isValidEmbedding } from './scans.js'

const logger = createLogger('maintenance')

export interface ContradictionPair {
  newer: MemoryRecord
  older: MemoryRecord
  similarity: number
}

interface ContradictionResult {
  verdict: 'keep_newer' | 'keep_older' | 'keep_both' | 'merge'
  reason?: string
  mergedRecord?: Partial<MemoryRecord>
}

interface ConflictPair {
  newRecord: MemoryRecord
  existingRecord: MemoryRecord
}

async function findNewConflicts(
  config: Config = DEFAULT_CONFIG,
  settings?: MaintenanceSettings
): Promise<ConflictPair[]> {
  const maintenance = resolveMaintenanceSettings(settings)
  const pairs: ConflictPair[] = []
  const filter = 'deprecated = false AND last_conflict_check = 0'
  const unchecked = await fetchRecords(filter, config, true)
  // Track pairs we've already seen to avoid duplicates (A vs B and B vs A)
  const seenPairs = new Set<string>()

  for (const record of unchecked) {
    // Compare against ALL non-deprecated records, not just established ones
    // This allows detecting conflicts within the same batch of new records
    const matches = await findSimilar(
      record,
      maintenance.conflictSimilarityThreshold,
      5,
      config
      // No establishedFilter - compare against all records
    )
    for (const match of matches) {
      // Create canonical pair key to avoid duplicates
      const pairKey = [record.id, match.record.id].sort().join(':')
      if (seenPairs.has(pairKey)) continue
      seenPairs.add(pairKey)

      pairs.push({ newRecord: record, existingRecord: match.record })
    }
  }

  return pairs
}

/**
 * Find contradiction pairs: semantically similar records of same type/project
 * but with different content (newer likely supersedes older).
 *
 * Unlike consolidation which finds near-duplicates (high text similarity),
 * this finds records that cover the same topic but say different things.
 */
export async function findContradictionPairs(
  config: Config = DEFAULT_CONFIG,
  settings?: MaintenanceSettings
): Promise<ContradictionPair[]> {
  const maintenance = resolveMaintenanceSettings(settings)
  const pairLimit = maintenance.contradictionBatchSize
  const pairs: ContradictionPair[] = []
  const processedIds = new Set<string>()
  let offset = 0

  while (true) {
    const batch = await queryRecords(
      {
        filter: 'deprecated = false',
        limit: QUERY_PAGE_SIZE,
        offset,
        includeEmbeddings: true
      },
      config
    )

    if (batch.length === 0) break

    for (const record of batch) {
      if (processedIds.has(record.id)) continue
      if (!isValidEmbedding(record.embedding)) continue

      const recordText = normalizeExactText(buildExactText(record))
      if (!recordText) continue

      // Find semantically similar records of same type/project
      const matches = await vectorSearchSimilar(
        record.embedding,
        {
          filter: buildContradictionFilter(record),
          limit: maintenance.contradictionSearchLimit,
          similarityThreshold: maintenance.contradictionSimilarityThreshold
        },
        config
      )

      for (const match of matches) {
        const candidate = match.record
        if (processedIds.has(candidate.id)) continue
        if (candidate.deprecated) continue

        const candidateText = normalizeExactText(buildExactText(candidate))
        if (!candidateText) continue

        // Skip if texts are too similar (that's consolidation territory)
        if (isExactTextSimilar(recordText, candidateText, maintenance.consolidationTextSimilarityRatio)) continue

        // Determine which is newer
        const recordTime = record.timestamp ?? 0
        const candidateTime = candidate.timestamp ?? 0

        if (recordTime > candidateTime) {
          pairs.push({ newer: record, older: candidate, similarity: match.similarity })
          if (pairs.length >= pairLimit) return pairs
        } else if (candidateTime > recordTime) {
          pairs.push({ newer: candidate, older: record, similarity: match.similarity })
          if (pairs.length >= pairLimit) return pairs
        }
        // If same timestamp, skip (ambiguous)

        // Mark the older one as processed to avoid duplicate pairs
        const olderId = recordTime > candidateTime ? candidate.id : record.id
        processedIds.add(olderId)
      }

      processedIds.add(record.id)
      if (pairs.length >= pairLimit) return pairs
    }

    if (batch.length < QUERY_PAGE_SIZE) break
    offset += batch.length
  }

  return pairs
}

/**
 * Resolve a contradiction by deprecating the older record.
 * The newer record is assumed to supersede it.
 */
async function resolveContradiction(
  pair: ContradictionPair,
  config: Config = DEFAULT_CONFIG
): Promise<boolean> {
  return markDeprecated(pair.older.id, config)
}

export async function checkContradiction(
  pair: ContradictionPair,
  config: Config
): Promise<ContradictionResult> {
  const client = await getAnthropicClient()
  if (!client) {
    throw new Error('No authentication available for contradiction check. Set ANTHROPIC_API_KEY or run kira login.')
  }

  const payload = JSON.stringify(buildContradictionInput(pair), null, 2)

  const response = await client.messages.create({
    model: config.extraction.model,
    max_tokens: Math.min(CONTRADICTION_MAX_TOKENS, config.extraction.maxTokens),
    temperature: 0,
    system: [
      { type: 'text', text: CLAUDE_CODE_SYSTEM_PROMPT },
      { type: 'text', text: CONTRADICTION_PROMPT }
    ],
    messages: [{ role: 'user', content: `Records:\n${payload}` }]
  })

  const rawText = extractResponseText(response.content)
  return parseContradictionResponse(rawText)
}

async function resolveContradictionWithLLM(
  pair: ContradictionPair,
  result: ContradictionResult,
  config: Config = DEFAULT_CONFIG
): Promise<{ action: ContradictionResult['verdict']; recordId?: string }> {
  switch (result.verdict) {
    case 'keep_newer': {
      const updated = await markDeprecated(pair.older.id, config)
      return updated ? { action: 'keep_newer', recordId: pair.older.id } : { action: 'keep_both' }
    }
    case 'keep_older': {
      const updated = await markDeprecated(pair.newer.id, config)
      return updated ? { action: 'keep_older', recordId: pair.newer.id } : { action: 'keep_both' }
    }
    case 'merge': {
      const mergedUpdates = result.mergedRecord
        ? filterContradictionMerge(pair.newer, result.mergedRecord)
        : {}

      if (Object.keys(mergedUpdates).length > 0) {
        const updates: Partial<MemoryRecord> = { ...mergedUpdates }
        if (pair.newer.timestamp) {
          updates.timestamp = pair.newer.timestamp
        }
        const updated = await updateRecord(pair.newer.id, updates, config)
        if (!updated) return { action: 'keep_both' }
      }

      const deprecated = await markDeprecated(pair.older.id, config)
      return deprecated ? { action: 'merge', recordId: pair.older.id } : { action: 'keep_both' }
    }
    case 'keep_both':
    default:
      return { action: 'keep_both' }
  }
}

async function resolveConflictWithLLM(
  pair: ConflictPair,
  config: Config
): Promise<{ verdict: 'supersedes' | 'variant' | 'hallucination'; reason: string }> {
  const client = await getAnthropicClient()
  if (!client) {
    throw new Error('No authentication available for conflict adjudication. Set ANTHROPIC_API_KEY or run kira login.')
  }

  const payload = JSON.stringify(buildConflictAdjudicationInput(pair), null, 2)

  const response = await client.messages.create({
    model: config.extraction.model,
    max_tokens: Math.min(CONFLICT_ADJUDICATION_MAX_TOKENS, config.extraction.maxTokens),
    temperature: 0,
    system: [
      { type: 'text', text: CLAUDE_CODE_SYSTEM_PROMPT },
      { type: 'text', text: CONFLICT_ADJUDICATION_PROMPT }
    ],
    messages: [{ role: 'user', content: `Records:\n${payload}` }],
    tools: [CONFLICT_ADJUDICATION_TOOL],
    tool_choice: { type: 'tool', name: CONFLICT_ADJUDICATION_TOOL_NAME }
  })

  const toolInput = response.content.find((block): block is ToolUseBlock =>
    isToolUseBlock(block) && block.name === CONFLICT_ADJUDICATION_TOOL_NAME
  )?.input

  if (!toolInput) {
    throw new Error('Conflict adjudication tool call missing in response.')
  }

  const verdict = coerceConflictVerdict(toolInput)
  if (!verdict) {
    throw new Error('Conflict adjudication response invalid or incomplete.')
  }

  return verdict
}

type ConflictMaintenanceAction = {
  type: 'deprecate'
  recordId?: string
  snippet: string
  reason: string
  details?: Record<string, unknown>
}

export async function runConflictResolution(
  dryRun: boolean,
  config: Config = DEFAULT_CONFIG,
  settings?: MaintenanceSettings
): Promise<{
  actions: ConflictMaintenanceAction[]
  summary: Record<string, number>
  candidates: MaintenanceCandidateGroup[]
  error?: string
}> {
  const maintenance = resolveMaintenanceSettings(settings)
  const actions: ConflictMaintenanceAction[] = []
  const candidateGroups: MaintenanceCandidateGroup[] = []
  let candidates = 0
  let pairs = 0
  let checked = 0
  let deprecatedExisting = 0
  let deprecatedNew = 0
  let variants = 0
  let processed = 0
  let errors = 0

  try {
    const mode = dryRun ? 'preview' : 'execute'
    logger.info(`Starting conflict resolution (${mode})`)

    logger.info('Fetching unchecked records...')
    // Include embeddings - needed for batchUpdateRecords to rebuild rows without re-embedding
    const unchecked = await fetchRecords('deprecated = false AND last_conflict_check = 0', config, true)
    candidates = unchecked.length
    logger.info(`Found ${candidates} unchecked records`)

    if (unchecked.length > 0) {
      const records = unchecked.map(record => buildCandidateRecord(record, 'new, never conflict-checked'))
      candidateGroups.push({
        id: 'conflict-candidates',
        label: 'New records',
        records
      })
    }

    logger.info('Finding conflict pairs (similarity search)...')
    const searchStart = Date.now()
    const conflictPairs = await findNewConflicts(config, maintenance)
    pairs = conflictPairs.length
    const searchDuration = Date.now() - searchStart
    logger.info(`Found ${pairs} conflict pairs in ${searchDuration}ms (threshold: ${maintenance.conflictSimilarityThreshold})`)

    const deprecatedNewIds = new Set<string>()
    const failedNewIds = new Set<string>()
    // Stage actions per candidate so errors don't cause partial deprecations.
    let currentNewId: string | null = null
    let pendingActions: ConflictMaintenanceAction[] = []
    let pendingVariants = 0
    let pendingFailed = false

    const resetPending = (newId: string) => {
      currentNewId = newId
      pendingActions = []
      pendingVariants = 0
      pendingFailed = false
    }

    const flushPending = async () => {
      if (!currentNewId) return
      if (pendingFailed) {
        pendingActions = []
        pendingVariants = 0
        return
      }

      if (dryRun) {
        actions.push(...pendingActions)
        for (const action of pendingActions) {
          if (!action.recordId) continue
          if (action.recordId === currentNewId) {
            deprecatedNew += 1
          } else {
            deprecatedExisting += 1
          }
        }
        variants += pendingVariants
        return
      }

      for (const action of pendingActions) {
        if (!action.recordId) continue
        const updatedRecord = await markDeprecated(action.recordId, config)
        if (updatedRecord) {
          actions.push(action)
          if (action.recordId === currentNewId) {
            deprecatedNew += 1
          } else {
            deprecatedExisting += 1
          }
        }
      }
      variants += pendingVariants
    }

    if (pairs > 0) {
      logger.info(`Adjudicating ${pairs} pairs via LLM (batch size: ${maintenance.conflictCheckBatchSize})...`)
    }
    const adjudicationStart = Date.now()

    for (let i = 0; i < conflictPairs.length; i += maintenance.conflictCheckBatchSize) {
      const batch = conflictPairs.slice(i, i + maintenance.conflictCheckBatchSize)

      for (const pair of batch) {
        const newId = pair.newRecord.id
        if (currentNewId && newId !== currentNewId) {
          await flushPending()
          resetPending(newId)
        } else if (!currentNewId) {
          resetPending(newId)
        }

        if (deprecatedNewIds.has(newId) || failedNewIds.has(newId)) continue

        try {
          const verdict = await resolveConflictWithLLM(pair, config)
          checked += 1

          // Log progress every 5 pairs or at the end
          if (checked % 5 === 0 || checked === pairs) {
            const elapsed = Date.now() - adjudicationStart
            const avgMs = Math.round(elapsed / checked)
            const remaining = pairs - checked
            const etaMs = remaining * avgMs
            const etaSec = Math.round(etaMs / 1000)
            logger.info(`Adjudicated ${checked}/${pairs} pairs (${avgMs}ms/pair, ~${etaSec}s remaining)`)
          }

          if (verdict.verdict === 'supersedes') {
            const action: ConflictMaintenanceAction = {
              type: 'deprecate',
              recordId: pair.existingRecord.id,
              snippet: truncateSnippet(buildRecordSnippet(pair.existingRecord)),
              reason: verdict.reason,
              details: {
                verdict: verdict.verdict,
                candidateId: newId,
                existingId: pair.existingRecord.id
              }
            }

            pendingActions.push(action)
          } else if (verdict.verdict === 'hallucination') {
            const action: ConflictMaintenanceAction = {
              type: 'deprecate',
              recordId: newId,
              snippet: truncateSnippet(buildRecordSnippet(pair.newRecord)),
              reason: verdict.reason,
              details: {
                verdict: verdict.verdict,
                candidateId: newId,
                existingId: pair.existingRecord.id
              }
            }

            pendingActions = [action]
            pendingVariants = 0
            deprecatedNewIds.add(newId)
          } else {
            pendingVariants += 1
          }
        } catch {
          errors += 1
          failedNewIds.add(newId)
          pendingActions = []
          pendingVariants = 0
          pendingFailed = true
        }
      }
    }

    await flushPending()

    if (checked > 0) {
      const adjudicationDuration = Date.now() - adjudicationStart
      logger.info(`Adjudication complete in ${Math.round(adjudicationDuration / 1000)}s`)
      logger.info(`Verdicts: ${deprecatedExisting} supersedes, ${deprecatedNew} hallucinations, ${variants} variants`)
    }

    const recordsToMark = unchecked.filter(r => !deprecatedNewIds.has(r.id) && !failedNewIds.has(r.id))
    if (recordsToMark.length > 0) {
      if (dryRun) {
        processed = recordsToMark.length
      } else {
        logger.info(`Marking ${recordsToMark.length} records as conflict-checked (batch)...`)
        const checkedAt = Date.now()
        const batchResult = await batchUpdateRecords(recordsToMark, { lastConflictCheck: checkedAt }, config)
        processed = batchResult.updated
        if (batchResult.failed > 0) {
          logger.warn(`Failed to mark ${batchResult.failed} records`)
        }
      }
    }

    logger.info(`Conflict resolution complete: ${processed} records processed, ${errors} errors`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error('Conflict resolution failed', error)
    return {
      actions,
      summary: { candidates, pairs, checked, deprecatedExisting, deprecatedNew, variants, processed, errors },
      candidates: candidateGroups,
      error: message
    }
  }

  return {
    actions,
    summary: { candidates, pairs, checked, deprecatedExisting, deprecatedNew, variants, processed, errors },
    candidates: candidateGroups
  }
}

function buildContradictionFilter(record: MemoryRecord): string {
  // For contradictions, we DO want to filter by project since
  // the same command can legitimately have different outcomes in different projects.
  // Don't include global scope bypass (includeGlobal: false).
  return buildFilter({
    project: record.project,
    type: record.type,
    excludeId: record.id,
    excludeDeprecated: true
  }) ?? 'deprecated = false'
}

function buildContradictionInput(pair: ContradictionPair): Record<string, unknown> {
  return {
    similarity: pair.similarity,
    newer: {
      id: pair.newer.id,
      timestamp: pair.newer.timestamp,
      record: buildGeneralizationInput(pair.newer)
    },
    older: {
      id: pair.older.id,
      timestamp: pair.older.timestamp,
      record: buildGeneralizationInput(pair.older)
    }
  }
}

function buildConflictAdjudicationInput(pair: ConflictPair): Record<string, unknown> {
  return {
    existing: {
      id: pair.existingRecord.id,
      timestamp: pair.existingRecord.timestamp,
      record: buildGeneralizationInput(pair.existingRecord)
    },
    candidate: {
      id: pair.newRecord.id,
      timestamp: pair.newRecord.timestamp,
      record: buildGeneralizationInput(pair.newRecord)
    }
  }
}

function parseContradictionResponse(rawText: string): ContradictionResult {
  const parsed = extractJsonObject(rawText)
  if (!isPlainObject(parsed)) {
    return { verdict: 'keep_both', reason: 'invalid-json' }
  }

  const verdict = parseVerdict(parsed.verdict)
  const reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : undefined

  if (verdict === 'merge') {
    if (!isPlainObject(parsed.merged)) {
      return { verdict: 'keep_both', reason: reason ? `${reason} (missing merged)` : 'missing-merged' }
    }
    return {
      verdict: 'merge',
      mergedRecord: parsed.merged as Partial<MemoryRecord>,
      ...(reason ? { reason } : {})
    }
  }

  return {
    verdict,
    ...(reason ? { reason } : {})
  }
}

function coerceConflictVerdict(
  value: unknown
): { verdict: 'supersedes' | 'variant' | 'hallucination'; reason: string } | null {
  if (!isPlainObject(value)) return null
  const verdict = value.verdict
  const reason = typeof value.reason === 'string' ? value.reason.trim() : ''

  if (verdict !== 'supersedes' && verdict !== 'variant' && verdict !== 'hallucination') {
    return null
  }
  if (!reason) return null

  return { verdict, reason }
}

function parseVerdict(value: unknown): ContradictionResult['verdict'] {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_')
    if (normalized === 'keep_newer' || normalized === 'keep_older' || normalized === 'keep_both' || normalized === 'merge') {
      return normalized
    }
  }
  return 'keep_both'
}

function isExactTextSimilar(seed: string, candidate: string, ratio: number): boolean {
  if (!seed || !candidate) return false
  if (seed === candidate) return true
  if (seed.includes(candidate) || candidate.includes(seed)) return true

  const maxLength = Math.max(seed.length, candidate.length)
  const threshold = Math.floor(maxLength * ratio)
  if (threshold === 0) return false
  if (Math.abs(seed.length - candidate.length) > threshold) return false

  return levenshteinDistance(seed, candidate, threshold) <= threshold
}

function levenshteinDistance(a: string, b: string, maxDistance?: number): number {
  if (a === b) return 0
  const aLength = a.length
  const bLength = b.length

  if (aLength === 0) return bLength
  if (bLength === 0) return aLength
  if (maxDistance !== undefined && Math.abs(aLength - bLength) > maxDistance) {
    return maxDistance + 1
  }

  let prev = new Array<number>(bLength + 1)
  let curr = new Array<number>(bLength + 1)

  for (let j = 0; j <= bLength; j += 1) {
    prev[j] = j
  }

  for (let i = 1; i <= aLength; i += 1) {
    curr[0] = i
    let rowMin = curr[0]
    const aChar = a.charCodeAt(i - 1)

    for (let j = 1; j <= bLength; j += 1) {
      const cost = aChar === b.charCodeAt(j - 1) ? 0 : 1
      const deletion = prev[j] + 1
      const insertion = curr[j - 1] + 1
      const substitution = prev[j - 1] + cost
      const value = Math.min(deletion, insertion, substitution)
      curr[j] = value
      if (value < rowMin) rowMin = value
    }

    if (maxDistance !== undefined && rowMin > maxDistance) {
      return maxDistance + 1
    }

    const swap = prev
    prev = curr
    curr = swap
  }

  return prev[bLength]
}
