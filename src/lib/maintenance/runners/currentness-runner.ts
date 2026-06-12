import { CLAUDE_CODE_SYSTEM_PROMPT } from '../../anthropic.js'
import { batchUpdateRecords, buildFilter, vectorSearchSimilar } from '../../lancedb.js'
import { createLogger } from '../../logger.js'
import { isPlainObject, isToolUseBlock, type ToolUseBlock } from '../../parsing.js'
import { clampModelMaxTokens } from '../../model-capabilities.js'
import { buildCandidateRecord, buildRecordSnippet, escapeFilterValue } from '../../shared.js'
import { DEFAULT_CONFIG, type Config, type DiscoveryRecord, type MemoryRecord } from '../../types.js'
import { resolveMaintenanceSettings, type MaintenanceSettings } from '../../settings.js'
import {
  CURRENTNESS_MAX_TOKENS,
  CURRENTNESS_PROMPT,
  CURRENTNESS_TOOL,
  CURRENTNESS_TOOL_NAME,
  buildGeneralizationInput,
  extractJsonObject,
  extractResponseText,
  getAnthropicClient
} from '../prompts.js'
import { markDeprecated } from '../operations.js'
import { fetchRecords, isValidEmbedding } from '../scans.js'
import type { MaintenanceCandidateGroup } from '../../../../shared/types.js'
import { applyActionWithDryRun, buildActionFromRecord, buildErrorResult, buildResult, toErrorMessage } from './shared.js'
import type { MaintenanceRunResult, ProgressCallback } from './types.js'

const logger = createLogger('maintenance')

const CURRENTNESS_SIMILARITY_THRESHOLD = 0.7
const CURRENTNESS_SEARCH_LIMIT = 12
const CURRENTNESS_MAX_CLUSTER_SIZE = 8
const ACTIVE_DISCOVERY_FILTER = 'deprecated = false AND type = \'discovery\''

type CurrentnessVerdictKind = 'current' | 'historical_useful' | 'superseded'

type CurrentnessVerdict = {
  id: string
  verdict: CurrentnessVerdictKind
  reason: string
  supersedingRecordId?: string
}

type CurrentnessCandidate = DiscoveryRecord & { embedding: number[] }

type CurrentnessCluster = {
  id: string
  records: CurrentnessCandidate[]
  members: CurrentnessClusterMember[]
}

type CurrentnessClusterMember = {
  record: CurrentnessCandidate
  similarity: number
}

export async function runCurrentnessCheck(
  dryRun: boolean,
  config: Config = DEFAULT_CONFIG,
  _settings?: MaintenanceSettings,
  onProgress?: ProgressCallback
): Promise<MaintenanceRunResult> {
  const maintenance = resolveMaintenanceSettings(_settings)
  const actions: MaintenanceRunResult['actions'] = []
  const candidateGroups: MaintenanceCandidateGroup[] = []
  let candidates = 0
  let clusters = 0
  let checked = 0
  let current = 0
  let historical = 0
  let deprecated = 0
  let singletons = 0
  let errors = 0

  try {
    logger.info('Starting currentness check')
    const currentnessResult = await findCurrentnessClusters(config, maintenance)
    candidates = currentnessResult.candidates
    const currentnessClusters = currentnessResult.clusters
    singletons = currentnessResult.singletons.length
    clusters = currentnessClusters.length

    if (currentnessClusters.length > 0) {
      candidateGroups.push(...currentnessClusters.map(cluster => ({
        id: cluster.id,
        label: `Currentness cluster ${cluster.id.split('-').at(-1) ?? ''}`.trim(),
        reason: `embedding similarity >= ${Math.round(CURRENTNESS_SIMILARITY_THRESHOLD * 100)}%`,
        records: cluster.members.map(member =>
          buildCandidateRecord(member.record, member.similarity === 1 ? 'embedding seed' : 'embedding neighbor', {
            similarity: member.similarity,
            timestamp: member.record.timestamp ?? 0
          })
        )
      })))
    }

    for (let i = 0; i < currentnessClusters.length; i += 1) {
      const cluster = currentnessClusters[i]
      if (onProgress) {
        onProgress({
          current: i + 1,
          total: currentnessClusters.length,
          message: `Checking currentness cluster ${i + 1}/${currentnessClusters.length}`
        })
      }

      try {
        const verdicts = await checkCurrentnessCluster(cluster.records, config)
        checked += cluster.records.length
        const checkedAt = Date.now()

        for (const verdict of verdicts) {
          if (verdict.verdict === 'current') {
            current += 1
            continue
          }
          if (verdict.verdict === 'historical_useful') {
            historical += 1
            continue
          }

          const record = cluster.records.find(candidate => candidate.id === verdict.id)
          if (!record) continue
          const supersedingRecordId = resolveCurrentnessSupersedingId(verdict, cluster.records)
          if (!supersedingRecordId) {
            historical += 1
            continue
          }

          const action = buildActionFromRecord({
            type: 'deprecate',
            record,
            reason: verdict.reason,
            details: {
              currentnessVerdict: verdict.verdict,
              supersedingRecordId
            }
          })

          const applied = await applyActionWithDryRun(
            dryRun,
            actions,
            action,
            () => markDeprecated(record.id, config, {
              reason: `currentness:superseded-by:${supersedingRecordId}`,
              supersedingRecordId
            })
          )
          if (applied) deprecated += 1
        }

        if (!dryRun) {
          const failed = await markCurrentnessChecked(cluster.records, checkedAt, config)
          if (failed > 0) {
            errors += failed
            logger.warn(`Currentness cluster ${cluster.id}: failed to mark ${failed}/${cluster.records.length} records as checked`)
          }
        }
      } catch (error) {
        errors += 1
        logger.warn(`Currentness cluster ${cluster.id} failed: ${toErrorMessage(error)}`)
      }
    }

    if (!dryRun && currentnessResult.singletons.length > 0) {
      const failed = await markCurrentnessChecked(currentnessResult.singletons, Date.now(), config)
      if (failed > 0) {
        errors += failed
        logger.warn(`Currentness check: failed to mark ${failed}/${currentnessResult.singletons.length} singleton records as checked`)
      }
    }
  } catch (error) {
    return buildErrorResult(
      actions,
      { candidates, clusters, singletons, checked, current, historical, deprecated, errors },
      candidateGroups,
      error
    )
  }

  logger.info(`Currentness check complete: ${deprecated} deprecated, ${historical} historical, ${current} current, ${errors} errors`)
  return buildResult(
    actions,
    { candidates, clusters, singletons, checked, current, historical, deprecated, errors },
    candidateGroups
  )
}

async function findCurrentnessClusters(
  config: Config,
  maintenance: MaintenanceSettings
): Promise<{ candidates: number; clusters: CurrentnessCluster[]; singletons: CurrentnessCandidate[] }> {
  const records = await fetchRecords(ACTIVE_DISCOVERY_FILTER, config, true)
  const candidates = records.filter(isCurrentnessCandidate)
  const recheckCutoff = Date.now() - maintenance.currentnessRecheckDays * 24 * 60 * 60 * 1000
  const recheckCutoffValue = Math.trunc(recheckCutoff)
  const dueCandidates = candidates.filter(record => !wasRecentlyCurrentnessChecked(record, recheckCutoffValue))
  const candidatesByProject = new Map<string, CurrentnessCandidate[]>()
  for (const record of candidates) {
    const project = record.project ?? ''
    if (!candidatesByProject.has(project)) candidatesByProject.set(project, [])
    candidatesByProject.get(project)!.push(record)
  }

  const clusters: CurrentnessCluster[] = []
  const singletonById = new Map<string, CurrentnessCandidate>()
  let clusterIndex = 0

  for (const projectCandidates of candidatesByProject.values()) {
    const candidateById = new Map(projectCandidates.map(record => [record.id, record]))
    const dueIds = new Set(projectCandidates
      .filter(record => !wasRecentlyCurrentnessChecked(record, recheckCutoffValue))
      .map(record => record.id))
    const seen = new Set<string>()

    for (const record of projectCandidates) {
      if (!dueIds.has(record.id)) continue
      if (seen.has(record.id)) continue

      const matches = await vectorSearchSimilar(
        record.embedding,
        {
          filter: buildCurrentnessFilter(record),
          limit: CURRENTNESS_SEARCH_LIMIT,
          similarityThreshold: CURRENTNESS_SIMILARITY_THRESHOLD
        },
        config
      )

      const members: CurrentnessClusterMember[] = [{ record, similarity: 1 }]
      const memberIds = new Set<string>([record.id])
      for (const match of matches) {
        const candidate = candidateById.get(match.record.id)
        if (!candidate || seen.has(candidate.id) || memberIds.has(candidate.id)) continue
        members.push({ record: candidate, similarity: match.similarity })
        memberIds.add(candidate.id)
        if (members.length >= CURRENTNESS_MAX_CLUSTER_SIZE) break
      }

      if (members.length < 2) {
        singletonById.set(record.id, record)
        continue
      }

      for (const member of members) {
        seen.add(member.record.id)
        singletonById.delete(member.record.id)
      }
      members.sort((a, b) => {
        const timestampDiff = (a.record.timestamp ?? 0) - (b.record.timestamp ?? 0)
        if (timestampDiff !== 0) return timestampDiff
        return a.record.id < b.record.id ? -1 : 1
      })
      clusterIndex += 1
      clusters.push({
        id: `currentness-cluster-${clusterIndex}`,
        records: members.map(member => member.record),
        members
      })
    }
  }

  return { candidates: dueCandidates.length, clusters, singletons: Array.from(singletonById.values()) }
}

function isCurrentnessCandidate(record: MemoryRecord): record is CurrentnessCandidate {
  return record.type === 'discovery'
    && !record.deprecated
    && isValidEmbedding(record.embedding)
}

function wasRecentlyCurrentnessChecked(record: MemoryRecord, cutoff: number): boolean {
  const lastCheck = record.lastCurrentnessCheck ?? 0
  return lastCheck !== 0 && lastCheck >= cutoff
}

function buildCurrentnessFilter(record: DiscoveryRecord): string {
  return buildFilter({
    project: record.project,
    type: 'discovery',
    excludeId: record.id,
    excludeDeprecated: true
  }) ?? ACTIVE_DISCOVERY_FILTER
}

async function markCurrentnessChecked(
  records: DiscoveryRecord[],
  checkedAt: number,
  config: Config
): Promise<number> {
  if (records.length === 0) return 0

  try {
    const ids = records.map(record => record.id)
    const idList = ids.map(id => `'${escapeFilterValue(id)}'`).join(', ')
    const recordsWithEmbeddings = await fetchRecords(`id IN (${idList})`, config, true)
    if (recordsWithEmbeddings.length === 0) return records.length

    const result = await batchUpdateRecords(
      recordsWithEmbeddings,
      { lastCurrentnessCheck: checkedAt },
      config
    )
    return result.failed
  } catch (error) {
    logger.warn(`Currentness checked marker failed: ${toErrorMessage(error)}`)
    return records.length
  }
}

async function checkCurrentnessCluster(
  records: DiscoveryRecord[],
  config: Config
): Promise<CurrentnessVerdict[]> {
  const client = await getAnthropicClient()
  if (!client) {
    throw new Error('No authentication available for currentness check. Set ANTHROPIC_API_KEY or run kira login.')
  }

  const payload = JSON.stringify(buildCurrentnessInput(records), null, 2)
  const response = await client.messages.create({
    model: config.extraction.model,
    max_tokens: clampModelMaxTokens(
      config.extraction.model,
      Math.min(CURRENTNESS_MAX_TOKENS, config.extraction.maxTokens)
    ),
    system: [
      { type: 'text', text: CLAUDE_CODE_SYSTEM_PROMPT },
      { type: 'text', text: CURRENTNESS_PROMPT }
    ],
    messages: [{ role: 'user', content: `Records:\n${payload}` }],
    tools: [CURRENTNESS_TOOL],
    tool_choice: { type: 'tool', name: CURRENTNESS_TOOL_NAME }
  })

  const toolInput = response.content.find((block): block is ToolUseBlock =>
    isToolUseBlock(block) && block.name === CURRENTNESS_TOOL_NAME
  )?.input

  const parsed = toolInput ?? extractJsonObject(extractResponseText(response.content))
  return coerceCurrentnessVerdicts(parsed, records)
}

function buildCurrentnessInput(records: DiscoveryRecord[]): Record<string, unknown> {
  return {
    records: records.map(record => ({
      id: record.id,
      timestamp: record.timestamp ?? 0,
      snippet: buildRecordSnippet(record),
      record: buildGeneralizationInput(record)
    }))
  }
}

function coerceCurrentnessVerdicts(value: unknown, records: DiscoveryRecord[]): CurrentnessVerdict[] {
  const defaults = records.map(record => ({
    id: record.id,
    verdict: 'historical_useful' as const,
    reason: 'No currentness verdict emitted.'
  }))
  if (!isPlainObject(value) || !Array.isArray(value.records)) return defaults

  const recordIds = new Set(records.map(record => record.id))
  const byId = new Map<string, CurrentnessVerdict>()
  for (const entry of value.records) {
    if (!isPlainObject(entry)) continue
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    if (!recordIds.has(id)) continue

    const verdict = coerceCurrentnessVerdict(entry.verdict)
    const reason = typeof entry.reason === 'string' && entry.reason.trim()
      ? entry.reason.trim()
      : 'No reason provided.'
    const supersedingRecordId = typeof entry.supersedingRecordId === 'string'
      ? entry.supersedingRecordId.trim()
      : ''

    if (verdict === 'superseded') {
      if (!recordIds.has(supersedingRecordId) || supersedingRecordId === id) {
        byId.set(id, {
          id,
          verdict: 'historical_useful',
          reason: 'Superseded verdict omitted a valid superseding record in the cluster.'
        })
        continue
      }
      byId.set(id, { id, verdict, reason, supersedingRecordId })
      continue
    }

    byId.set(id, { id, verdict, reason })
  }

  return defaults.map(defaultVerdict => byId.get(defaultVerdict.id) ?? defaultVerdict)
}

function coerceCurrentnessVerdict(value: unknown): CurrentnessVerdictKind {
  if (value === 'current' || value === 'historical_useful' || value === 'superseded') return value
  return 'historical_useful'
}

function resolveCurrentnessSupersedingId(
  verdict: CurrentnessVerdict,
  records: DiscoveryRecord[]
): string | undefined {
  const recordIds = new Set(records.map(record => record.id))
  if (!verdict.supersedingRecordId) return undefined
  if (verdict.supersedingRecordId === verdict.id) return undefined
  if (!recordIds.has(verdict.supersedingRecordId)) return undefined
  return verdict.supersedingRecordId
}
