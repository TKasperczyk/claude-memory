import { CLAUDE_CODE_SYSTEM_PROMPT } from '../../anthropic.js'
import { buildFilter, vectorSearchSimilar } from '../../lancedb.js'
import { createLogger } from '../../logger.js'
import { isPlainObject, isToolUseBlock, type ToolUseBlock } from '../../parsing.js'
import { buildCandidateRecord, buildRecordSnippet } from '../../shared.js'
import { DEFAULT_CONFIG, type Config, type DiscoveryRecord, type MemoryRecord } from '../../types.js'
import type { MaintenanceSettings } from '../../settings.js'
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

type CurrentnessVerdictKind = 'current' | 'historical_useful' | 'superseded'

type CurrentnessVerdict = {
  id: string
  verdict: CurrentnessVerdictKind
  reason: string
  supersedingRecordId?: string
}

type CurrentnessCluster = {
  id: string
  records: DiscoveryRecord[]
}

const CURRENTNESS_SIGNAL_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'remaining queue', pattern: /\bremaining\s+(?:sprint\s+)?queue\b/i },
  { label: 'current state', pattern: /\bcurrent\s+state\b/i },
  { label: 'after sprint', pattern: /\bafter\s+sprint\b/i },
  { label: 'deferred future work', pattern: /\bdeferred\s+to\s+future\b/i },
  { label: 'test count progression', pattern: /\b(?:test(?:\s+suite)?\s+count|tests?\s+across|test-count).{0,80}\b(?:progression|snapshot|baseline)\b/i },
  { label: 'version progression', pattern: /\b(?:version|v\d+).{0,80}\b(?:progression|snapshot|baseline)\b/i }
]

export async function runCurrentnessCheck(
  dryRun: boolean,
  config: Config = DEFAULT_CONFIG,
  _settings?: MaintenanceSettings,
  onProgress?: ProgressCallback
): Promise<MaintenanceRunResult> {
  const actions: MaintenanceRunResult['actions'] = []
  const candidateGroups: MaintenanceCandidateGroup[] = []
  let candidates = 0
  let clusters = 0
  let checked = 0
  let current = 0
  let historical = 0
  let deprecated = 0
  let errors = 0

  try {
    logger.info('Starting currentness check')
    const candidateRecords = await findCurrentnessCandidates(config)
    candidates = candidateRecords.length
    const currentnessClusters = await findCurrentnessClusters(candidateRecords, config)
    clusters = currentnessClusters.length

    if (currentnessClusters.length > 0) {
      candidateGroups.push(...currentnessClusters.map(cluster => ({
        id: cluster.id,
        label: `Currentness cluster ${cluster.id.split('-').at(-1) ?? ''}`.trim(),
        reason: `currentness signal + similarity >= ${Math.round(CURRENTNESS_SIMILARITY_THRESHOLD * 100)}%`,
        records: cluster.records.map(record =>
          buildCandidateRecord(record, getCurrentnessSignal(record) ?? 'currentness signal', {
            timestamp: record.timestamp ?? 0
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
      } catch (error) {
        errors += 1
        logger.warn(`Currentness cluster ${cluster.id} failed: ${toErrorMessage(error)}`)
      }
    }
  } catch (error) {
    return buildErrorResult(
      actions,
      { candidates, clusters, checked, current, historical, deprecated, errors },
      candidateGroups,
      error
    )
  }

  logger.info(`Currentness check complete: ${deprecated} deprecated, ${historical} historical, ${current} current, ${errors} errors`)
  return buildResult(
    actions,
    { candidates, clusters, checked, current, historical, deprecated, errors },
    candidateGroups
  )
}

async function findCurrentnessCandidates(config: Config): Promise<DiscoveryRecord[]> {
  const records = await fetchRecords('deprecated = false AND type = \'discovery\'', config, true)
  return records.filter(isCurrentnessCandidate)
}

function isCurrentnessCandidate(record: MemoryRecord): record is DiscoveryRecord {
  return record.type === 'discovery'
    && !record.deprecated
    && isValidEmbedding(record.embedding)
    && Boolean(getCurrentnessSignal(record))
}

function getCurrentnessSignal(record: DiscoveryRecord): string | null {
  const text = [record.what, record.where, record.evidence].filter(Boolean).join('\n')
  const match = CURRENTNESS_SIGNAL_PATTERNS.find(signal => signal.pattern.test(text))
  return match?.label ?? null
}

async function findCurrentnessClusters(
  candidates: DiscoveryRecord[],
  config: Config
): Promise<CurrentnessCluster[]> {
  const candidatesByProject = new Map<string, DiscoveryRecord[]>()
  for (const record of candidates) {
    const project = record.project ?? ''
    if (!candidatesByProject.has(project)) candidatesByProject.set(project, [])
    candidatesByProject.get(project)!.push(record)
  }

  const clusters: CurrentnessCluster[] = []
  let clusterIndex = 0

  for (const projectCandidates of candidatesByProject.values()) {
    const candidateById = new Map(projectCandidates.map(record => [record.id, record]))
    const seen = new Set<string>()

    for (const record of projectCandidates) {
      if (seen.has(record.id)) continue
      if (!isValidEmbedding(record.embedding)) {
        seen.add(record.id)
        continue
      }

      const matches = await vectorSearchSimilar(
        record.embedding,
        {
          filter: buildCurrentnessFilter(record),
          limit: CURRENTNESS_SEARCH_LIMIT,
          similarityThreshold: CURRENTNESS_SIMILARITY_THRESHOLD
        },
        config
      )

      const members = [record]
      for (const match of matches) {
        const candidate = candidateById.get(match.record.id)
        if (!candidate || seen.has(candidate.id)) continue
        members.push(candidate)
        if (members.length >= CURRENTNESS_MAX_CLUSTER_SIZE) break
      }

      if (members.length < 2) {
        seen.add(record.id)
        continue
      }

      for (const member of members) seen.add(member.id)
      members.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))
      clusterIndex += 1
      clusters.push({
        id: `currentness-cluster-${clusterIndex}`,
        records: members
      })
    }
  }

  return clusters
}

function buildCurrentnessFilter(record: DiscoveryRecord): string {
  return buildFilter({
    project: record.project,
    type: 'discovery',
    excludeId: record.id,
    excludeDeprecated: true
  }) ?? 'deprecated = false AND type = \'discovery\''
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
    max_tokens: Math.min(CURRENTNESS_MAX_TOKENS, config.extraction.maxTokens),
    temperature: 0,
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
      signal: getCurrentnessSignal(record),
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
