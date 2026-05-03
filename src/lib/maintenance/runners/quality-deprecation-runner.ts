import { DEFAULT_CONFIG, type Config, type MemoryRecord } from '../../types.js'
import { getPrimaryRecordText, getSecondaryRecordText } from '../../record-fields.js'
import { buildCandidateRecord } from '../../shared.js'
import { fetchRecords } from '../scans.js'
import { markDeprecated } from '../operations.js'
import type { MaintenanceAction, MaintenanceCandidateGroup } from '../../../../shared/types.js'
import { applyActionWithDryRun, buildActionFromRecord, buildErrorResult, buildResult } from './shared.js'
import type { MaintenanceRunResult } from './types.js'

type QualityMatch = {
  reason: string
  heuristic: string
  matchedText: string
}

const RAW_TOOL_PREFIX_RE = /^\s*(?:\[Tool (?:Result|Call)\b|<local-command-(?:stdout|stderr)>|<command-(?:stdout|stderr)>|<\/?tool[_-]?result\b|\{\s*"(?:stdout|stderr|interrupted|isImage|noOutputExpected)")/i
const PERSISTED_OUTPUT_RE = /<persisted-output>|Output too large|Full output saved to/i
const PERSISTED_OUTPUT_STRIP_RE = /<persisted-output>|Output too large\.?|Full output saved to|[A-Za-z]:?[/\\][^\s]+|\/[^\s]+/gi
const EXTENSION_ERROR_RE = /\b(?:error:\s*)?(?:extension disconnected|chrome browser extension isn't connected|browser extension disconnected|extension timeout|extension timed out)\b/i
const GENERIC_REMEDIATION_RE = /^(?:n\/a|none|unknown|retry|try again|no resolution|not resolved|same)$/i
const METRIC_LINE_RE = /^\s*(?:(?:mean\s+)?reward|ep[_\s-]?reward|episode[_\s-]?reward|equity|final\s+equity|checkpoint|saved\s+model|model\s+saved|timesteps?|iterations?|fps|loss|policy[_\s-]?loss|value[_\s-]?loss|entropy|approx[_\s-]?kl)\b.*(?:[-+]?\d|\$|\/)/i
const CHECKPOINT_PATH_RE = /\b(?:checkpoint|model|weights)\b.*(?:\/|\\).*\.(?:pt|pth|zip|ckpt|safetensors)\b/i
const NATURAL_LANGUAGE_OUTCOME_RE = /\b(?:because|therefore|indicates|shows|means|failed to|fails to|learned|profitable|unprofitable|strategy|bug|fix|resolved|root cause|works|does not work)\b/i

export async function runQualityDeprecation(
  dryRun: boolean,
  config: Config = DEFAULT_CONFIG
): Promise<MaintenanceRunResult> {
  const actions: MaintenanceAction[] = []
  const candidateGroups: MaintenanceCandidateGroup[] = []
  let checked = 0
  let candidates = 0
  let deprecated = 0
  let errors = 0

  try {
    const records = await fetchRecords('deprecated = false', config, false)
    checked = records.length
    const matches = records
      .map(record => ({ record, match: classifyQualityDeprecationCandidate(record) }))
      .filter((entry): entry is { record: MemoryRecord; match: QualityMatch } => Boolean(entry.match))
    candidates = matches.length

    if (matches.length > 0) {
      candidateGroups.push({
        id: 'quality-deprecation',
        label: 'Quality deprecation candidates',
        records: matches.map(({ record, match }) =>
          buildCandidateRecord(record, match.reason, {
            heuristic: match.heuristic,
            matchedText: truncateDetail(match.matchedText)
          })
        )
      })
    }

    for (const { record, match } of matches) {
      const action = buildActionFromRecord({
        type: 'deprecate',
        record,
        reason: match.reason,
        details: {
          heuristic: match.heuristic,
          matchedText: truncateDetail(match.matchedText)
        }
      })

      try {
        const applied = await applyActionWithDryRun(
          dryRun,
          actions,
          action,
          () => markDeprecated(record.id, config, { reason: match.reason })
        )
        if (applied) deprecated += 1
      } catch {
        errors += 1
      }
    }
  } catch (error) {
    return buildErrorResult(actions, { checked, candidates, deprecated, errors }, candidateGroups, error)
  }

  return buildResult(actions, { checked, candidates, deprecated, errors }, candidateGroups)
}

export function classifyQualityDeprecationCandidate(record: MemoryRecord): QualityMatch | null {
  const primary = getPrimaryRecordText(record)
  const secondary = getSecondaryRecordText(record)

  if (RAW_TOOL_PREFIX_RE.test(primary)) {
    return buildMatch('tool-result-prefix', primary)
  }

  if (PERSISTED_OUTPUT_RE.test(primary) && strippedWordCount(primary, PERSISTED_OUTPUT_STRIP_RE) <= 8) {
    return buildMatch('persisted-output-pointer', primary)
  }

  if (isVagueExtensionError(record, primary, secondary)) {
    return buildMatch('vague-extension-error', primary)
  }

  if (isRawMetricDump(record, primary, secondary)) {
    return buildMatch('raw-metric-dump', primary.includes('\n') ? primary : secondary)
  }

  return null
}

function buildMatch(heuristic: string, matchedText: string): QualityMatch {
  return {
    reason: `quality:${heuristic}`,
    heuristic,
    matchedText
  }
}

function isVagueExtensionError(record: MemoryRecord, primary: string, secondary: string): boolean {
  if (record.type !== 'error' && record.type !== 'warning') return false
  if (primary.length >= 60 || !EXTENSION_ERROR_RE.test(primary)) return false
  return !hasExplicitWorkaround(record, secondary)
}

function hasExplicitWorkaround(record: MemoryRecord, _secondary: string): boolean {
  const values: string[] = []
  if (record.type === 'error') values.push(record.resolution)
  if (record.type === 'warning') values.push(record.useInstead)

  return values.some(isNonGenericText)
}

function hasDurableSummaryOrRemediation(record: MemoryRecord): boolean {
  const values: string[] = []
  if (record.type === 'command') values.push(record.resolution ?? '')
  if (record.type === 'error') values.push(record.resolution, record.cause ?? '')
  if (record.type === 'warning') values.push(record.useInstead, record.reason)

  return values.some(isNonGenericText)
}

function isRawMetricDump(record: MemoryRecord, primary: string, secondary: string): boolean {
  if (record.type !== 'command' && record.type !== 'error' && record.type !== 'warning') return false
  if (hasDurableSummaryOrRemediation(record)) return false

  const metricText = primary.includes('\n') ? primary : secondary
  if (NATURAL_LANGUAGE_OUTCOME_RE.test(metricText)) return false

  const lines = metricText
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
  if (lines.length < 3) return false

  const metricLines = lines.filter(line => METRIC_LINE_RE.test(line) || CHECKPOINT_PATH_RE.test(line)).length
  return metricLines / lines.length >= 0.8
}

function isNonGenericText(value: string): boolean {
  const trimmed = value.trim()
  return Boolean(trimmed && !GENERIC_REMEDIATION_RE.test(trimmed))
}

function strippedWordCount(value: string, pattern: RegExp): number {
  return countWords(value.replace(pattern, ' '))
}

function countWords(value: string): number {
  const matches = value.match(/[A-Za-z][A-Za-z0-9_-]*/g)
  return matches ? matches.length : 0
}

function truncateDetail(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized
}
