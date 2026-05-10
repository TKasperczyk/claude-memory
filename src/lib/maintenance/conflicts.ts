import { CLAUDE_CODE_SYSTEM_PROMPT } from '../anthropic.js'
import { createLogger } from '../logger.js'
import {
  DEFAULT_CONFIG,
  type Config,
  type MemoryRecord
} from '../types.js'
import { batchUpdateRecords, findSimilar } from '../lancedb.js'
import { resolveMaintenanceSettings, type MaintenanceSettings } from '../settings.js'
import { isPlainObject, isToolUseBlock, type ToolUseBlock } from '../parsing.js'
import {
  buildCandidateRecord,
  buildRecordSnippet,
  truncateSnippet
} from '../shared.js'
import type { MaintenanceCandidateGroup } from '../../../shared/types.js'
import {
  CONFLICT_ADJUDICATION_MAX_TOKENS,
  CONFLICT_ADJUDICATION_PROMPT,
  CONFLICT_ADJUDICATION_TOOL,
  CONFLICT_ADJUDICATION_TOOL_NAME,
  buildGeneralizationInput,
  getAnthropicClient
} from './prompts.js'
import { markDeprecated } from './operations.js'
import { fetchRecords } from './scans.js'

const logger = createLogger('maintenance')

interface ConflictPair {
  newRecord: MemoryRecord
  existingRecord: MemoryRecord
}

type ConflictVerdict = {
  verdict: 'deprecate_existing' | 'deprecate_candidate' | 'keep_both'
  reason: string
  supersedingRecordId?: string
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

async function resolveConflictWithLLM(
  pair: ConflictPair,
  config: Config
): Promise<ConflictVerdict> {
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
  let keptBoth = 0
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
    let pendingKeptBoth = 0
    let pendingFailed = false

    const resetPending = (newId: string) => {
      currentNewId = newId
      pendingActions = []
      pendingKeptBoth = 0
      pendingFailed = false
    }

    const flushPending = async () => {
      if (!currentNewId) return
      if (pendingFailed) {
        pendingActions = []
        pendingKeptBoth = 0
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
        keptBoth += pendingKeptBoth
        return
      }

      let writeFailed = false
      for (const action of pendingActions) {
        if (!action.recordId) continue
        const supersedingRecordId = typeof action.details?.supersedingRecordId === 'string'
          ? action.details.supersedingRecordId
          : undefined
        const reason = supersedingRecordId
          ? `conflict-resolution:superseded-by:${supersedingRecordId}`
          : `conflict-resolution:${String(action.details?.verdict ?? 'deprecate')}`
        let updatedRecord = false
        try {
          updatedRecord = await markDeprecated(
            action.recordId,
            config,
            supersedingRecordId ? { supersedingRecordId, reason } : { reason }
          )
        } catch (error) {
          errors += 1
          failedNewIds.add(currentNewId)
          const message = error instanceof Error ? error.message : String(error)
          logger.warn(`Skipping conflict action for ${action.recordId}: ${message}`)
          writeFailed = true
          break
        }
        if (updatedRecord) {
          actions.push(action)
          if (action.recordId === currentNewId) {
            deprecatedNew += 1
          } else {
            deprecatedExisting += 1
          }
        }
      }
      if (!writeFailed) {
        keptBoth += pendingKeptBoth
      }
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
          const verdict = normalizeConflictVerdictForPair(
            await resolveConflictWithLLM(pair, config),
            pair
          )
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

          if (verdict.verdict === 'deprecate_existing') {
            const supersedingRecordId = resolveConflictSupersedingRecordId(
              verdict,
              pair.existingRecord.id,
              pair.newRecord.id
            )
            const action: ConflictMaintenanceAction = {
              type: 'deprecate',
              recordId: pair.existingRecord.id,
              snippet: truncateSnippet(buildRecordSnippet(pair.existingRecord)),
              reason: verdict.reason,
              details: {
                verdict: verdict.verdict,
                candidateId: newId,
                existingId: pair.existingRecord.id,
                supersedingRecordId
              }
            }

            pendingActions.push(action)
          } else if (verdict.verdict === 'deprecate_candidate') {
            const supersedingRecordId = resolveConflictSupersedingRecordId(
              verdict,
              pair.newRecord.id,
              pair.existingRecord.id
            )
            const action: ConflictMaintenanceAction = {
              type: 'deprecate',
              recordId: newId,
              snippet: truncateSnippet(buildRecordSnippet(pair.newRecord)),
              reason: verdict.reason,
              details: {
                verdict: verdict.verdict,
                candidateId: newId,
                existingId: pair.existingRecord.id,
                supersedingRecordId
              }
            }

            pendingActions = [action]
            pendingKeptBoth = 0
            deprecatedNewIds.add(newId)
          } else {
            pendingKeptBoth += 1
          }
        } catch {
          errors += 1
          failedNewIds.add(newId)
          pendingActions = []
          pendingKeptBoth = 0
          pendingFailed = true
        }
      }
    }

    await flushPending()

    if (checked > 0) {
      const adjudicationDuration = Date.now() - adjudicationStart
      logger.info(`Adjudication complete in ${Math.round(adjudicationDuration / 1000)}s`)
      logger.info(`Verdicts: ${deprecatedExisting} deprecate_existing, ${deprecatedNew} deprecate_candidate, ${keptBoth} keep_both`)
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
      summary: { candidates, pairs, checked, deprecatedExisting, deprecatedNew, keptBoth, processed, errors },
      candidates: candidateGroups,
      error: message
    }
  }

  return {
    actions,
    summary: { candidates, pairs, checked, deprecatedExisting, deprecatedNew, keptBoth, processed, errors },
    candidates: candidateGroups
  }
}

function resolveConflictSupersedingRecordId(
  verdict: ConflictVerdict,
  deprecatedId: string,
  defaultSupersedingId: string
): string | undefined {
  const candidate = verdict.supersedingRecordId?.trim()
  if (candidate && candidate !== deprecatedId) return candidate
  return defaultSupersedingId
}

function normalizeConflictVerdictForPair(
  verdict: ConflictVerdict,
  pair: ConflictPair
): ConflictVerdict {
  const candidateTime = pair.newRecord.timestamp ?? 0
  const existingTime = pair.existingRecord.timestamp ?? 0
  if (
    verdict.verdict === 'deprecate_existing'
    && candidateTime > 0
    && existingTime > 0
    && candidateTime < existingTime
  ) {
    return {
      verdict: 'keep_both',
      reason: `${verdict.reason} Kept both because the candidate is older than the existing record, so deprecating the existing record would require stronger evidence.`
    }
  }
  return verdict
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

function coerceConflictVerdict(
  value: unknown
): ConflictVerdict | null {
  if (!isPlainObject(value)) return null
  const verdict = value.verdict
  const reason = typeof value.reason === 'string' ? value.reason.trim() : ''
  const supersedingRecordId = typeof value.supersedingRecordId === 'string'
    ? value.supersedingRecordId.trim()
    : ''

  if (verdict !== 'deprecate_existing' && verdict !== 'deprecate_candidate' && verdict !== 'keep_both') {
    return null
  }
  if (!reason) return null

  return {
    verdict,
    reason,
    ...(supersedingRecordId ? { supersedingRecordId } : {})
  }
}
