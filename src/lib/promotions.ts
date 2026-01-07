import Anthropic from '@anthropic-ai/sdk'
import { createHash } from 'crypto'
import fs from 'fs'
import { homedir } from 'os'
import path from 'path'
import { CLAUDE_CODE_SYSTEM_PROMPT, createAnthropicClient } from './anthropic.js'
import { queryRecords } from './milvus.js'
import { asString, isPlainObject } from './parsing.js'
import { KNOWN_COMMANDS, normalizeStep, truncateWithTail } from './shared.js'
import { DEFAULT_CONFIG, type Config, type DiscoveryRecord, type MemoryRecord, type ProcedureRecord } from './types.js'

const QUERY_PAGE_SIZE = 500
const SKILL_SUCCESS_THRESHOLD = 5
const CLAUDE_MD_SUCCESS_THRESHOLD = 3
const SKILL_NAME_MAX_LENGTH = 64
const PROJECT_SLUG_MAX_LENGTH = 80
const PROMOTION_MODEL = 'claude-haiku-4-5-20251001'
const PROMOTION_TOOL_NAME = 'emit_promotion_decisions'
const PROMOTION_MAX_TOKENS = 1600
const PROMOTION_BATCH_SIZE = 8
const CLAUDE_MD_MAX_CHARS = 16000
const SKILL_CONTEXT_MAX_CHARS = 24000
const SKILL_FILE_MAX_CHARS = 4000

type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: unknown }

type PromotionAction = 'new' | 'edit'

interface PromotionDecision {
  id: string
  shouldPromote: boolean
  reason: string
  action: PromotionAction
  targetFile: string
  suggestedContent?: string
}

type PromotionPayload = {
  decisions: PromotionDecision[]
}

const PROMOTION_SYSTEM_PROMPT = `You decide whether to promote candidate records into durable documentation.

Rules:
- Output ONLY via the tool call "${PROMOTION_TOOL_NAME}" exactly once.
- Provide a decision for every candidate id.
- Use existing content to avoid redundancy.
- Only promote durable, reusable information.
- Keep the reason concise and specific.
- Always include an action ("new" or "edit") and targetFile for each decision.
- Use action="edit" only when an existing file from the provided context should be updated.
- Use action="new" when a new file should be created, and include the proposed target path.
- If you include suggestedContent: for action="new" provide full file content; for action="edit" provide only the new content to add.
- suggestedContent is optional; keep it short and in Markdown if provided.
`

const PROMOTION_TOOL: Anthropic.Tool = {
  name: PROMOTION_TOOL_NAME,
  description: 'Emit promotion decisions for candidate records.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['decisions'],
    properties: {
      decisions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'shouldPromote', 'reason', 'action', 'targetFile'],
          properties: {
            id: { type: 'string' },
            shouldPromote: { type: 'boolean' },
            reason: { type: 'string' },
            action: { type: 'string', enum: ['new', 'edit'] },
            targetFile: { type: 'string' },
            suggestedContent: { type: 'string' }
          }
        }
      }
    }
  }
}

interface PromotionSuggestion<T> {
  record: T
  decision: PromotionDecision
}


export interface ClaudeMdCandidateGroups {
  global: DiscoveryRecord[]
  byProject: Record<string, DiscoveryRecord[]>
}

export interface SuggestionSummary {
  skillFiles: string[]
  claudeMdFiles: string[]
  skillCandidates: number
  claudeMdCandidates: number
}

export async function findSkillCandidatesHeuristic(
  config: Config = DEFAULT_CONFIG
): Promise<ProcedureRecord[]> {
  const filter = `type == "procedure" && usage_count >= ${SKILL_SUCCESS_THRESHOLD} && deprecated == false`
  const records = await fetchRecords(filter, config)

  return records
    .filter(isProcedureRecord)
    .filter(record => !record.deprecated)
    .filter(record => (record.usageCount ?? 0) >= SKILL_SUCCESS_THRESHOLD)
    .sort(compareByUsage)
}

export async function findClaudeMdCandidatesHeuristic(
  config: Config = DEFAULT_CONFIG
): Promise<ClaudeMdCandidateGroups> {
  const filter = `type == "discovery" && usage_count >= ${CLAUDE_MD_SUCCESS_THRESHOLD} && deprecated == false`
  const records = await fetchRecords(filter, config)
  const verified = records
    .filter(isDiscoveryRecord)
    .filter(record => !record.deprecated)
    .filter(record => record.confidence === 'verified')
    .filter(record => (record.usageCount ?? 0) >= CLAUDE_MD_SUCCESS_THRESHOLD)
    .sort(compareByUsage)

  return groupClaudeMdCandidates(verified)
}

export async function findSkillCandidates(
  config: Config = DEFAULT_CONFIG,
  root: string = process.cwd()
): Promise<PromotionSuggestion<ProcedureRecord>[]> {
  const candidates = await findSkillCandidatesHeuristic(config)
  if (candidates.length === 0) return []

  return filterSkillCandidatesWithLlm(candidates, root, config)
}

export async function findClaudeMdCandidates(
  config: Config = DEFAULT_CONFIG,
  root: string = process.cwd()
): Promise<PromotionSuggestion<DiscoveryRecord>[]> {
  const candidates = await findClaudeMdCandidatesHeuristic(config)
  const flattened = flattenClaudeMdCandidates(candidates)
  if (flattened.length === 0) return []

  return filterClaudeMdCandidatesWithLlm(flattened, root, config)
}

export function generateSkillSuggestion(record: ProcedureRecord): string {
  const generatedAt = new Date().toISOString()
  const displayName = cleanInline(record.name) || 'Procedure'
  const skillName = normalizeSkillName(displayName, record.id)
  const description = buildSkillDescription(record, displayName)
  const domain = cleanInline(record.context.domain ?? record.domain ?? '')
  const project = cleanInline(record.context.project ?? record.project ?? '')

  const lines: string[] = []
  lines.push('---')
  lines.push(`name: ${yamlQuoteIfNeeded(skillName)}`)
  lines.push(`description: ${yamlQuoteIfNeeded(description)}`)
  lines.push('---')
  lines.push('')
  lines.push(`# ${displayName}`)
  lines.push('')
  lines.push('## Steps')
  lines.push(...formatProcedureSteps(record.steps))

  const prerequisites = (record.prerequisites ?? [])
    .map(entry => cleanInline(entry))
    .filter(Boolean)
  if (prerequisites.length > 0) {
    lines.push('')
    lines.push('## Prerequisites')
    for (const entry of prerequisites) {
      lines.push(`- ${entry}`)
    }
  }

  const verification = cleanInline(record.verification ?? '')
  if (verification) {
    lines.push('')
    lines.push('## Verification')
    if (looksLikeCommand(verification)) {
      lines.push(`- \`${verification}\``)
    } else {
      lines.push(`- ${verification}`)
    }
  }

  if (domain || project) {
    lines.push('')
    lines.push('## Context')
    if (domain) lines.push(`- Domain: ${domain}`)
    if (project) lines.push(`- Project: ${project}`)
  }

  lines.push('')
  lines.push('## Metadata')
  lines.push(`- Source record ID: ${record.id}`)
  lines.push(`- Generated: ${generatedAt}`)
  if (typeof record.successCount === 'number') {
    lines.push(`- Success count: ${record.successCount}`)
  }
  if (typeof record.failureCount === 'number') {
    lines.push(`- Failure count: ${record.failureCount}`)
  }
  const lastUsed = formatTimestamp(record.lastUsed)
  if (lastUsed) {
    lines.push(`- Last used: ${lastUsed}`)
  }

  return finalizeOutput(lines)
}

function generateSkillAppendix(record: ProcedureRecord): string {
  const lines: string[] = []
  lines.push('## Suggested updates')
  lines.push('')
  lines.push('### Steps')
  lines.push(...formatProcedureSteps(record.steps))

  const prerequisites = (record.prerequisites ?? [])
    .map(entry => cleanInline(entry))
    .filter(Boolean)
  if (prerequisites.length > 0) {
    lines.push('')
    lines.push('### Prerequisites')
    for (const entry of prerequisites) {
      lines.push(`- ${entry}`)
    }
  }

  const verification = cleanInline(record.verification ?? '')
  if (verification) {
    lines.push('')
    lines.push('### Verification')
    if (looksLikeCommand(verification)) {
      lines.push(`- \`${verification}\``)
    } else {
      lines.push(`- ${verification}`)
    }
  }

  return finalizeOutput(lines)
}

export function generateClaudeMdSuggestion(records: DiscoveryRecord[]): string {
  const generatedAt = new Date().toISOString()
  const sourceIds = uniqueStrings(records.map(record => record.id))
  const scope = describeScope(records)
  const grouped = groupDiscoveries(records)

  const lines: string[] = []
  lines.push('# Suggested CLAUDE.md Additions')
  lines.push('')
  lines.push('Review and merge these suggestions into CLAUDE.md as appropriate.')
  lines.push('')
  lines.push(`Generated: ${generatedAt}`)
  lines.push(`Source record IDs: ${sourceIds.join(', ')}`)
  lines.push(`Scope: ${scope.label}`)
  if (scope.projectDetail) lines.push(scope.projectDetail)
  lines.push('')

  for (const [groupName, groupRecords] of grouped) {
    lines.push(`## ${groupName}`)
    for (const record of groupRecords) {
      const what = cleanInline(record.what)
      const evidence = cleanInline(record.evidence)
      const line = evidence ? `- ${what} (Evidence: ${evidence})` : `- ${what}`
      lines.push(line)
    }
    lines.push('')
  }

  return finalizeOutput(lines)
}

function generateClaudeMdAppendix(records: DiscoveryRecord[]): string {
  const grouped = groupDiscoveries(records)
  const lines: string[] = []
  lines.push('## Suggested additions')
  lines.push('')

  for (const [groupName, groupRecords] of grouped) {
    lines.push(`### ${groupName}`)
    for (const record of groupRecords) {
      const what = cleanInline(record.what)
      const evidence = cleanInline(record.evidence ?? '')
      const line = evidence ? `- ${what} (Evidence: ${evidence})` : `- ${what}`
      lines.push(line)
    }
    lines.push('')
  }

  return finalizeOutput(lines)
}

interface PromotionDiff<T> {
  kind: 'skill' | 'claude-md'
  record: T
  action: PromotionAction
  targetFile: string
  diff: string
  decisionReason: string
}

export async function buildPromotionDiffs(
  config: Config = DEFAULT_CONFIG,
  root: string = process.cwd()
): Promise<{
  skillDiffs: PromotionDiff<ProcedureRecord>[]
  claudeMdDiffs: PromotionDiff<DiscoveryRecord>[]
  skillCandidates: number
  claudeMdCandidates: number
}> {
  const [skillSuggestions, claudeSuggestions] = await Promise.all([
    findSkillCandidates(config, root),
    findClaudeMdCandidates(config, root)
  ])

  const skillDiffs = skillSuggestions
    .map(suggestion => buildSkillDiff(suggestion, root))
    .filter((diff): diff is PromotionDiff<ProcedureRecord> => Boolean(diff))

  const claudeMdDiffs = claudeSuggestions
    .map(suggestion => buildClaudeDiff(suggestion, root))
    .filter((diff): diff is PromotionDiff<DiscoveryRecord> => Boolean(diff))

  return {
    skillDiffs,
    claudeMdDiffs,
    skillCandidates: skillSuggestions.length,
    claudeMdCandidates: claudeSuggestions.length
  }
}

export async function writeSuggestions(
  config: Config = DEFAULT_CONFIG,
  root: string = process.cwd()
): Promise<SuggestionSummary> {
  const summary: SuggestionSummary = {
    skillFiles: [],
    claudeMdFiles: [],
    skillCandidates: 0,
    claudeMdCandidates: 0
  }

  const { skillDiffs, claudeMdDiffs, skillCandidates, claudeMdCandidates } = await buildPromotionDiffs(config, root)
  summary.skillCandidates = skillCandidates
  summary.claudeMdCandidates = claudeMdCandidates

  const skillsDir = path.join(root, 'suggestions', 'skills')
  const claudeDir = path.join(root, 'suggestions', 'claude-md')
  const dateStamp = formatDateStamp(new Date())

  ensureDir(skillsDir)
  ensureDir(claudeDir)

  const usedSkillNames = new Set<string>()
  for (const diff of skillDiffs) {
    const baseName = normalizeSkillName(diff.record.name ?? '', diff.record.id)
    const fileBase = uniqueName(baseName, diff.record.id, usedSkillNames)
    const filePath = resolveSuggestionPath(
      path.join(skillsDir, `${fileBase}.diff`),
      dateStamp
    )
    fs.writeFileSync(filePath, diff.diff, 'utf-8')
    summary.skillFiles.push(filePath)
  }

  const usedClaudeNames = new Set<string>()
  for (const diff of claudeMdDiffs) {
    const project = normalizeProjectKey(diff.record.project)
    const baseName = project ? normalizeProjectFileName(project) : 'global'
    const fileBase = uniqueName(baseName, diff.record.id, usedClaudeNames)
    const filePath = resolveSuggestionPath(
      path.join(claudeDir, `${fileBase}.diff`),
      dateStamp
    )
    fs.writeFileSync(filePath, diff.diff, 'utf-8')
    summary.claudeMdFiles.push(filePath)
  }

  return summary
}

function buildSkillDiff(
  suggestion: PromotionSuggestion<ProcedureRecord>,
  root: string
): PromotionDiff<ProcedureRecord> | null {
  const { record, decision } = suggestion
  const skillsDir = path.join(homedir(), '.claude', 'skills')
  const resolvedTarget = resolveTargetPath(decision.targetFile, skillsDir)
  const displayTarget = formatDiffPath(resolvedTarget, root)
  const targetExists = fs.existsSync(resolvedTarget)
  const action = resolvePromotionAction(decision.action, resolvedTarget, record.id, targetExists)
  const generatedContent = generateSkillSuggestion(record)
  const newFileContent = decision.action === 'new'
    ? coalesceSuggestedContent(decision.suggestedContent, generatedContent)
    : ensureTrailingNewline(generatedContent)

  if (action === 'new') {
    const diff = buildNewFileDiff(displayTarget, newFileContent)
    if (!diff) return null
    return {
      kind: 'skill',
      record,
      action,
      targetFile: displayTarget,
      diff,
      decisionReason: decision.reason
    }
  }

  const existing = readFileIfExists(resolvedTarget)
  if (!existing) {
    const diff = buildNewFileDiff(displayTarget, ensureTrailingNewline(generatedContent))
    if (!diff) return null
    return {
      kind: 'skill',
      record,
      action: 'new',
      targetFile: displayTarget,
      diff,
      decisionReason: decision.reason
    }
  }

  const appendix = coalesceSuggestedContent(decision.suggestedContent, generateSkillAppendix(record))
  const appendContent = buildAppendContent(existing, appendix)
  const diff = buildAppendDiff(displayTarget, existing, appendContent)
  if (!diff) return null
  return {
    kind: 'skill',
    record,
    action,
    targetFile: displayTarget,
    diff,
    decisionReason: decision.reason
  }
}

function buildClaudeDiff(
  suggestion: PromotionSuggestion<DiscoveryRecord>,
  root: string
): PromotionDiff<DiscoveryRecord> | null {
  const { record, decision } = suggestion
  const resolvedTarget = resolveTargetPath(decision.targetFile, root)
  const displayTarget = formatDiffPath(resolvedTarget, root)
  const targetExists = fs.existsSync(resolvedTarget)
  const action = resolvePromotionAction(decision.action, resolvedTarget, record.id, targetExists)
  const generatedContent = generateClaudeMdSuggestion([record])
  const newFileContent = decision.action === 'new'
    ? coalesceSuggestedContent(decision.suggestedContent, generatedContent)
    : ensureTrailingNewline(generatedContent)

  if (action === 'new') {
    const diff = buildNewFileDiff(displayTarget, newFileContent)
    if (!diff) return null
    return {
      kind: 'claude-md',
      record,
      action,
      targetFile: displayTarget,
      diff,
      decisionReason: decision.reason
    }
  }

  const existing = readFileIfExists(resolvedTarget)
  if (!existing) {
    const diff = buildNewFileDiff(displayTarget, ensureTrailingNewline(generatedContent))
    if (!diff) return null
    return {
      kind: 'claude-md',
      record,
      action: 'new',
      targetFile: displayTarget,
      diff,
      decisionReason: decision.reason
    }
  }

  const appendix = coalesceSuggestedContent(decision.suggestedContent, generateClaudeMdAppendix([record]))
  const appendContent = buildAppendContent(existing, appendix)
  const diff = buildAppendDiff(displayTarget, existing, appendContent)
  if (!diff) return null
  return {
    kind: 'claude-md',
    record,
    action,
    targetFile: displayTarget,
    diff,
    decisionReason: decision.reason
  }
}

function resolvePromotionAction(
  action: PromotionAction,
  targetFile: string,
  recordId: string,
  targetExists: boolean = fs.existsSync(targetFile)
): PromotionAction {
  if (action === 'edit' && !targetExists) {
    console.warn(`[claude-memory] Promotion edit target missing (${recordId}): ${targetFile}; falling back to new.`)
    return 'new'
  }
  return action
}

function resolveTargetPath(targetFile: string, baseDir: string): string {
  const trimmed = targetFile.trim()
  if (trimmed === '~') return homedir()
  if (trimmed.startsWith('~/')) return path.join(homedir(), trimmed.slice(2))
  if (path.isAbsolute(trimmed)) return trimmed
  return path.resolve(baseDir, trimmed)
}

function formatDiffPath(targetFile: string, root: string): string {
  const normalizedTarget = targetFile.replace(/\\/g, '/')
  const normalizedRoot = path.resolve(root).replace(/\\/g, '/')
  if (normalizedTarget.startsWith(`${normalizedRoot}/`)) {
    return normalizedTarget.slice(normalizedRoot.length + 1)
  }
  return normalizedTarget
}

function readFileIfExists(targetFile: string): string | null {
  if (!fs.existsSync(targetFile)) return null
  try {
    return fs.readFileSync(targetFile, 'utf-8')
  } catch (error) {
    console.error(`[claude-memory] Failed to read target file for promotion (${targetFile}):`, error)
    return null
  }
}

function coalesceSuggestedContent(suggested: string | undefined, fallback: string): string {
  const trimmed = suggested?.trim()
  if (trimmed) return ensureTrailingNewline(suggested ?? trimmed)
  return ensureTrailingNewline(fallback)
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith('\n') ? content : `${content}\n`
}

function buildAppendContent(existing: string, appendix: string): string {
  const trimmedAppendix = appendix.trim()
  if (!trimmedAppendix) return ''
  const separator = existing.trim().length > 0 ? '\n\n' : ''
  const normalizedAppendix = appendix.replace(/^\n+/, '')
  return ensureTrailingNewline(`${separator}${normalizedAppendix}`)
}

function splitLines(content: string): string[] {
  if (!content) return []
  const normalized = content.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  if (lines[lines.length - 1] === '') {
    lines.pop()
  }
  return lines
}

function buildNewFileDiff(targetFile: string, content: string): string {
  if (!content.trim()) return ''
  const lines = splitLines(content)
  const header = [
    '--- /dev/null',
    `+++ ${targetFile}`,
    `@@ -0,0 +1,${lines.length} @@`
  ]
  const body = lines.map(line => `+${line}`)
  return finalizeDiff([...header, ...body])
}

function buildAppendDiff(targetFile: string, oldContent: string, appendContent: string, contextSize = 3): string {
  if (!appendContent.trim()) return ''
  const oldLines = splitLines(oldContent)
  const appendLines = splitLines(appendContent)
  if (oldLines.length === 0) return buildNewFileDiff(targetFile, appendContent)
  const contextStart = Math.max(0, oldLines.length - contextSize)
  const contextLines = oldLines.slice(contextStart)
  const oldStart = contextStart + 1
  const oldCount = contextLines.length
  const newStart = oldStart
  const newCount = contextLines.length + appendLines.length
  const header = [
    `--- ${targetFile}`,
    `+++ ${targetFile}`,
    `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`
  ]
  const body = [
    ...contextLines.map(line => ` ${line}`),
    ...appendLines.map(line => `+${line}`)
  ]
  return finalizeDiff([...header, ...body])
}

function finalizeDiff(lines: string[]): string {
  const output = lines.join('\n').trimEnd()
  return output ? `${output}\n` : ''
}

async function filterSkillCandidatesWithLlm(
  candidates: ProcedureRecord[],
  _root: string,
  config: Config
): Promise<PromotionSuggestion<ProcedureRecord>[]> {
  const client = await createAnthropicClient()
  if (!client) {
    console.error('[claude-memory] No authentication available for promotion suggestions. Set ANTHROPIC_API_KEY or run kira login.')
    return candidates.map(record => ({
      record,
      decision: buildDefaultSkillDecision(record)
    }))
  }

  const skillContext = loadSkillContext()
  const batches = chunkArray(candidates, PROMOTION_BATCH_SIZE)
  const approved: PromotionSuggestion<ProcedureRecord>[] = []

  for (const batch of batches) {
    try {
      const prompt = buildSkillPromotionPrompt(batch, skillContext)
      const decisions = await requestPromotionDecisions(client, prompt, config)
      approved.push(...applyPromotionDecisions(batch, decisions, buildDefaultSkillDecision))
    } catch (error) {
      console.error('[claude-memory] Failed to score skill promotions with LLM; using heuristic results for batch:', error)
      approved.push(...batch.map(record => ({
        record,
        decision: buildDefaultSkillDecision(record)
      })))
    }
  }

  return approved
}

async function filterClaudeMdCandidatesWithLlm(
  candidates: DiscoveryRecord[],
  root: string,
  config: Config
): Promise<PromotionSuggestion<DiscoveryRecord>[]> {
  const client = await createAnthropicClient()
  if (!client) {
    console.error('[claude-memory] No authentication available for promotion suggestions. Set ANTHROPIC_API_KEY or run kira login.')
    return candidates.map(record => ({
      record,
      decision: buildDefaultClaudeDecision(record, root)
    }))
  }

  const fallbackClaudeMd = loadClaudeMdContext(root)
  const grouped = groupClaudeMdCandidates(candidates)
  const approved: PromotionSuggestion<DiscoveryRecord>[] = []

  const scoreGroup = async (records: DiscoveryRecord[], claudeMd: string): Promise<void> => {
    if (records.length === 0) return
    const batches = chunkArray(records, PROMOTION_BATCH_SIZE)
    for (const batch of batches) {
      try {
        const prompt = buildClaudeMdPromotionPrompt(batch, claudeMd)
        const decisions = await requestPromotionDecisions(client, prompt, config)
        approved.push(...applyPromotionDecisions(batch, decisions, record => buildDefaultClaudeDecision(record, root)))
      } catch (error) {
        console.error('[claude-memory] Failed to score CLAUDE.md promotions with LLM; using heuristic results for batch:', error)
        approved.push(...batch.map(record => ({
          record,
          decision: buildDefaultClaudeDecision(record, root)
        })))
      }
    }
  }

  await scoreGroup(grouped.global, fallbackClaudeMd)
  for (const [project, records] of Object.entries(grouped.byProject)) {
    const claudeMd = loadProjectClaudeMdContext(project, fallbackClaudeMd)
    await scoreGroup(records, claudeMd)
  }

  return approved
}

function buildSkillPromotionPrompt(
  candidates: ProcedureRecord[],
  skillContext: { text: string; fileCount: number }
): string {
  const payload = buildProcedureCandidatePayload(candidates)
  const contextText = skillContext.text || '(no existing skills found)'

  return `Given these existing skills, decide whether to promote each candidate.
If promoting, choose action="edit" to update an existing skill file or action="new" to create a new skill file.
For action="edit", targetFile must match a file path from the context below.
For action="new", targetFile should be the proposed path (use defaultTargetFile unless you have a better option).

Existing skills from ~/.claude/skills (count: ${skillContext.fileCount}, truncated):
${contextText}

Candidates (JSON):
${JSON.stringify(payload, null, 2)}
`
}

function buildClaudeMdPromotionPrompt(
  candidates: DiscoveryRecord[],
  claudeMd: string
): string {
  const payload = buildDiscoveryCandidatePayload(candidates)
  const contextText = claudeMd || '(CLAUDE.md not found)'

  return `Given this existing CLAUDE.md, decide whether to promote each discovery.
If promoting, choose action="edit" to update the existing CLAUDE.md or action="new" to create a new file.
For action="edit", targetFile should match the existing CLAUDE.md path shown or provided in defaultTargetFile.
For action="new", targetFile should be the proposed path.

Existing CLAUDE.md (truncated):
${contextText}

Candidates (JSON):
${JSON.stringify(payload, null, 2)}
`
}

function buildProcedureCandidatePayload(records: ProcedureRecord[]): Array<Record<string, unknown>> {
  return records.map(record => {
    const steps = (record.steps ?? [])
      .map(step => normalizeStep(step))
      .filter(Boolean)
      .slice(0, 12)
    const prerequisites = (record.prerequisites ?? [])
      .map(entry => cleanInline(entry))
      .filter(Boolean)
    const verification = cleanInline(record.verification ?? '')
    const domain = cleanInline(record.context.domain ?? record.domain ?? '')
    const project = cleanInline(record.context.project ?? record.project ?? '')

    return {
      id: record.id,
      name: cleanInline(record.name ?? ''),
      steps,
      ...(prerequisites.length > 0 ? { prerequisites } : {}),
      ...(verification ? { verification } : {}),
      ...(project ? { project } : {}),
      ...(domain ? { domain } : {}),
      defaultTargetFile: suggestSkillTargetPath(record),
      usageCount: record.usageCount ?? 0,
      successCount: record.successCount ?? 0,
      failureCount: record.failureCount ?? 0,
      lastUsed: formatTimestamp(record.lastUsed) ?? undefined
    }
  })
}

function buildDiscoveryCandidatePayload(records: DiscoveryRecord[]): Array<Record<string, unknown>> {
  return records.map(record => {
    const where = cleanInline(record.where ?? '')
    const evidence = cleanInline(record.evidence ?? '')
    const domain = cleanInline(record.domain ?? '')
    const project = cleanInline(record.project ?? '')

    return {
      id: record.id,
      what: cleanInline(record.what),
      ...(where ? { where } : {}),
      ...(evidence ? { evidence } : {}),
      ...(project ? { project } : {}),
      ...(domain ? { domain } : {}),
      defaultTargetFile: suggestClaudeMdTargetPath(project),
      confidence: record.confidence,
      usageCount: record.usageCount ?? 0,
      lastUsed: formatTimestamp(record.lastUsed) ?? undefined
    }
  })
}

async function requestPromotionDecisions(
  client: Anthropic,
  prompt: string,
  config: Config
): Promise<PromotionDecision[]> {
  const response = await client.messages.create({
    model: PROMOTION_MODEL,
    max_tokens: Math.min(PROMOTION_MAX_TOKENS, config.extraction.maxTokens),
    temperature: 0,
    system: [
      { type: 'text', text: CLAUDE_CODE_SYSTEM_PROMPT },
      { type: 'text', text: PROMOTION_SYSTEM_PROMPT }
    ],
    messages: [{ role: 'user', content: prompt }],
    tools: [PROMOTION_TOOL],
    tool_choice: { type: 'tool', name: PROMOTION_TOOL_NAME }
  })

  const toolInput = response.content.find((block): block is ToolUseBlock =>
    isToolUseBlock(block) && block.name === PROMOTION_TOOL_NAME
  )?.input

  if (!toolInput) {
    throw new Error('Promotion tool call missing in response.')
  }

  const payload = coercePromotionPayload(toolInput)
  if (!payload) {
    throw new Error('Promotion response invalid or incomplete.')
  }

  return payload.decisions
}

function applyPromotionDecisions<T extends { id: string }>(
  candidates: T[],
  decisions: PromotionDecision[],
  fallbackDecision: (candidate: T) => PromotionDecision
): PromotionSuggestion<T>[] {
  const decisionMap = new Map<string, PromotionDecision>()

  for (const decision of decisions) {
    if (!decisionMap.has(decision.id)) {
      decisionMap.set(decision.id, decision)
    }
  }

  const approved: PromotionSuggestion<T>[] = []
  for (const candidate of candidates) {
    const decision = decisionMap.get(candidate.id)
    const resolved = decision ?? fallbackDecision(candidate)
    if (!decision) {
      console.warn(`[claude-memory] Missing promotion decision for candidate ${candidate.id}; falling back to heuristic.`)
    }
    if (resolved.shouldPromote) {
      approved.push({ record: candidate, decision: resolved })
    }
  }

  return approved
}

function coercePromotionPayload(input: unknown): PromotionPayload | null {
  if (!isPlainObject(input)) return null
  const record = input as Record<string, unknown>
  const decisions = Array.isArray(record.decisions)
    ? record.decisions.map(coercePromotionDecision).filter((decision): decision is PromotionDecision => Boolean(decision))
    : []

  if (decisions.length === 0) return null
  return { decisions }
}

function coercePromotionDecision(input: unknown): PromotionDecision | null {
  if (!isPlainObject(input)) return null
  const record = input as Record<string, unknown>

  const id = asString(record.id)?.trim()
  const reason = asString(record.reason)?.trim()
  const action = asString(record.action)?.trim()
  const targetFile = asString(record.targetFile)?.trim()
  const suggestedContent = asString(record.suggestedContent)?.trim()
  const shouldPromote = typeof record.shouldPromote === 'boolean' ? record.shouldPromote : null

  if (!id || !reason || shouldPromote === null) return null
  if (!shouldPromote) {
    const resolvedAction = action === 'new' || action === 'edit' ? action : 'new'
    return {
      id,
      shouldPromote,
      reason,
      action: resolvedAction,
      targetFile: targetFile ?? ''
    }
  }
  if (!action || (action !== 'new' && action !== 'edit')) return null
  if (!targetFile) return null

  return {
    id,
    shouldPromote,
    reason,
    action,
    targetFile,
    ...(suggestedContent ? { suggestedContent } : {})
  }
}

function groupClaudeMdCandidates(records: DiscoveryRecord[]): ClaudeMdCandidateGroups {
  const grouped: ClaudeMdCandidateGroups = { global: [], byProject: {} }

  for (const record of records) {
    const project = normalizeProjectKey(record.project)
    if (project) {
      if (!grouped.byProject[project]) grouped.byProject[project] = []
      grouped.byProject[project].push(record)
    } else {
      grouped.global.push(record)
    }
  }

  return grouped
}

function flattenClaudeMdCandidates(groups: ClaudeMdCandidateGroups): DiscoveryRecord[] {
  const flattened: DiscoveryRecord[] = []
  flattened.push(...groups.global)
  for (const records of Object.values(groups.byProject)) {
    flattened.push(...records)
  }
  return flattened
}

function loadClaudeMdContext(root: string): string {
  const targetPath = path.join(root, 'CLAUDE.md')
  if (!fs.existsSync(targetPath)) return ''

  try {
    const content = fs.readFileSync(targetPath, 'utf-8')
    return truncateWithTail(content, CLAUDE_MD_MAX_CHARS)
  } catch (error) {
    console.error('[claude-memory] Failed to read CLAUDE.md for promotion context:', error)
    return ''
  }
}

function loadProjectClaudeMdContext(project: string | undefined, fallback: string): string {
  if (!project) return fallback
  const targetPath = path.join(project, 'CLAUDE.md')
  if (!fs.existsSync(targetPath)) return fallback

  try {
    const content = fs.readFileSync(targetPath, 'utf-8')
    return truncateWithTail(content, CLAUDE_MD_MAX_CHARS)
  } catch (error) {
    console.error(`[claude-memory] Failed to read project CLAUDE.md for promotion context (${targetPath}):`, error)
    return fallback
  }
}

function loadSkillContext(): { text: string; fileCount: number } {
  const skillsDir = path.join(homedir(), '.claude', 'skills')
  if (!fs.existsSync(skillsDir)) {
    return { text: '', fileCount: 0 }
  }

  const files = listSkillFiles(skillsDir)
  const entries: string[] = []

  for (const filePath of files) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8').trim()
      if (!content) continue
      const relative = path.relative(skillsDir, filePath)
      const snippet = truncateWithTail(content, SKILL_FILE_MAX_CHARS)
      entries.push(`File: ${relative}\n${snippet}`)
    } catch (error) {
      console.error(`[claude-memory] Failed to read skill file ${filePath}:`, error)
    }
  }

  const combined = entries.join('\n\n')
  return {
    text: truncateWithTail(combined, SKILL_CONTEXT_MAX_CHARS),
    fileCount: files.length
  }
}

function listSkillFiles(rootDir: string): string[] {
  const results: string[] = []
  let entries: fs.Dirent[] = []
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true })
  } catch (error) {
    console.error(`[claude-memory] Failed to list skill files in ${rootDir}:`, error)
    return results
  }

  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name)
    if (entry.isDirectory()) {
      results.push(...listSkillFiles(entryPath))
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(entryPath)
    }
  }

  return results.sort()
}

function chunkArray<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items]
  const batches: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size))
  }
  return batches
}

function isToolUseBlock(value: unknown): value is ToolUseBlock {
  return (
    isPlainObject(value)
    && value.type === 'tool_use'
    && typeof value.id === 'string'
    && typeof value.name === 'string'
    && 'input' in value
  )
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

function resolveSuggestionPath(targetPath: string, dateStamp: string): string {
  if (!fs.existsSync(targetPath)) return targetPath
  const parsed = path.parse(targetPath)
  const baseName = path.join(parsed.dir, `${parsed.name}-${dateStamp}${parsed.ext}`)
  if (!fs.existsSync(baseName)) return baseName

  let counter = 2
  let candidate = path.join(parsed.dir, `${parsed.name}-${dateStamp}-${counter}${parsed.ext}`)
  while (fs.existsSync(candidate)) {
    counter += 1
    candidate = path.join(parsed.dir, `${parsed.name}-${dateStamp}-${counter}${parsed.ext}`)
  }
  return candidate
}

function formatDateStamp(date: Date): string {
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return `${year}${month}${day}`
}

async function fetchRecords(
  filter: string | undefined,
  config: Config
): Promise<MemoryRecord[]> {
  const records: MemoryRecord[] = []
  let offset = 0

  while (true) {
    const batch = await queryRecords(
      {
        filter,
        limit: QUERY_PAGE_SIZE,
        offset
      },
      config
    )

    if (batch.length === 0) break
    records.push(...batch)
    if (batch.length < QUERY_PAGE_SIZE) break
    offset += batch.length
  }

  return records
}

function isProcedureRecord(record: MemoryRecord): record is ProcedureRecord {
  return record.type === 'procedure'
}

function isDiscoveryRecord(record: MemoryRecord): record is DiscoveryRecord {
  return record.type === 'discovery'
}

function compareByUsage(a: MemoryRecord, b: MemoryRecord): number {
  const usageDiff = (b.usageCount ?? 0) - (a.usageCount ?? 0)
  if (usageDiff !== 0) return usageDiff
  const lastUsedDiff = (b.lastUsed ?? 0) - (a.lastUsed ?? 0)
  if (lastUsedDiff !== 0) return lastUsedDiff
  return (b.timestamp ?? 0) - (a.timestamp ?? 0)
}

function normalizeProjectKey(project?: string): string | undefined {
  if (!project) return undefined
  const trimmed = project.trim()
  if (!trimmed) return undefined
  if (trimmed.toLowerCase() === 'unknown') return undefined
  return trimmed
}

function cleanInline(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function normalizeSkillName(name: string, fallbackId: string): string {
  const slug = slugify(name, SKILL_NAME_MAX_LENGTH)
  if (slug) return slug
  return `procedure-${fallbackId.slice(0, 8)}`
}

function suggestSkillTargetPath(record: ProcedureRecord): string {
  const displayName = cleanInline(record.name ?? '')
  const skillName = normalizeSkillName(displayName, record.id)
  return path.join(homedir(), '.claude', 'skills', `${skillName}.md`)
}

function suggestClaudeMdTargetPath(project?: string): string {
  if (project) return path.join(project, 'CLAUDE.md')
  return 'CLAUDE.md'
}

function buildDefaultSkillDecision(record: ProcedureRecord): PromotionDecision {
  const targetFile = suggestSkillTargetPath(record)
  const action: PromotionAction = fs.existsSync(targetFile) ? 'edit' : 'new'
  return {
    id: record.id,
    shouldPromote: true,
    reason: 'heuristic promotion',
    action,
    targetFile
  }
}

function buildDefaultClaudeDecision(record: DiscoveryRecord, root: string): PromotionDecision {
  const project = normalizeProjectKey(record.project)
  const targetFile = project
    ? path.join(project, 'CLAUDE.md')
    : path.join(root, 'CLAUDE.md')
  const action: PromotionAction = fs.existsSync(targetFile) ? 'edit' : 'new'
  return {
    id: record.id,
    shouldPromote: true,
    reason: 'heuristic promotion',
    action,
    targetFile
  }
}

function buildSkillDescription(record: ProcedureRecord, displayName: string): string {
  const domain = cleanInline(record.context.domain ?? record.domain ?? '')
  const project = cleanInline(record.context.project ?? record.project ?? '')
  const base = displayName
    ? `Step-by-step procedure for ${displayName}.`
    : 'Step-by-step procedure.'
  const parts = [base]
  if (domain) parts.push(`Use for ${domain} tasks.`)
  if (project) parts.push(`Project: ${project}.`)
  return cleanInline(parts.join(' '))
}

function formatProcedureSteps(steps: string[]): string[] {
  const lines: string[] = []
  let index = 1

  for (const step of steps) {
    const normalized = normalizeStep(step)
    if (!normalized) continue
    if (looksLikeCommand(normalized)) {
      lines.push(`${index}. \`${normalized}\``)
    } else {
      lines.push(`${index}. ${normalized}`)
    }
    index += 1
  }

  if (lines.length === 0) {
    lines.push('1. Add steps once defined.')
  }

  return lines
}

function looksLikeCommand(step: string): boolean {
  if (!step) return false
  const trimmed = step.trim()
  if (!trimmed) return false
  if (trimmed.startsWith('./') || trimmed.startsWith('/') || trimmed.startsWith('~/')) return true
  const first = trimmed.split(/\s+/)[0]
  if (!first) return false
  return KNOWN_COMMANDS.has(first)
}

function groupDiscoveries(
  records: DiscoveryRecord[]
): Array<[string, DiscoveryRecord[]]> {
  const groups = new Map<string, DiscoveryRecord[]>()

  for (const record of records) {
    const groupName = resolveDiscoveryGroup(record)
    const entries = groups.get(groupName) ?? []
    entries.push(record)
    groups.set(groupName, entries)
  }

  const entries = Array.from(groups.entries())
  entries.sort(([a], [b]) => a.localeCompare(b))
  for (const entry of entries) {
    entry[1].sort(compareByUsage)
  }

  return entries
}

function resolveDiscoveryGroup(record: DiscoveryRecord): string {
  const where = cleanInline(record.where ?? '')
  if (where) return where
  const domain = cleanInline(record.domain ?? '')
  if (domain) return `Domain: ${domain}`
  return 'General'
}

function describeScope(records: DiscoveryRecord[]): { label: string; projectDetail?: string } {
  const projects = uniqueStrings(
    records
      .map(record => normalizeProjectKey(record.project))
      .filter((value): value is string => Boolean(value))
  )

  if (projects.length === 0) {
    return { label: 'Global' }
  }
  if (projects.length === 1) {
    return { label: 'Project-specific', projectDetail: `Project: ${projects[0]}` }
  }
  return { label: 'Multiple projects', projectDetail: `Projects: ${projects.join(', ')}` }
}

function normalizeProjectFileName(project: string): string {
  const hashSuffix = hashString(project).slice(0, 6)
  const maxBaseLength = Math.max(1, PROJECT_SLUG_MAX_LENGTH - hashSuffix.length - 1)
  const slug = slugify(project, maxBaseLength)
  if (slug) return `${slug}-${hashSuffix}`
  return `project-${hashSuffix}`
}

function uniqueName(base: string, id: string, used: Set<string>): string {
  const fallback = base || `record-${id.slice(0, 8)}`
  if (!used.has(fallback)) {
    used.add(fallback)
    return fallback
  }

  const suffix = id.slice(0, 8)
  const withSuffix = `${fallback}-${suffix}`
  if (!used.has(withSuffix)) {
    used.add(withSuffix)
    return withSuffix
  }

  let counter = 2
  let candidate = `${withSuffix}-${counter}`
  while (used.has(candidate)) {
    counter += 1
    candidate = `${withSuffix}-${counter}`
  }
  used.add(candidate)
  return candidate
}

function slugify(value: string, maxLength: number): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  if (!normalized) return ''
  if (normalized.length <= maxLength) return normalized

  const trimmed = normalized.slice(0, maxLength).replace(/-+$/g, '')
  if (trimmed) return trimmed
  return normalized.slice(0, maxLength)
}

function hashString(value: string): string {
  return createHash('sha1').update(value).digest('hex')
}

function formatTimestamp(value: number | undefined): string | null {
  if (!value || !Number.isFinite(value) || value <= 0) return null
  return new Date(value).toISOString()
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const trimmed = value ? value.trim() : ''
    if (!trimmed) continue
    if (seen.has(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result
}

function yamlQuoteIfNeeded(value: string): string {
  if (value === '') return '""'
  const needsQuotes = /^\s|\s$/.test(value)
    || /[:#\n\r\t]/.test(value)
    || /["']/.test(value)
    || /^[\-\?:,\[\]\{\}&\*!|>'"%@`]/.test(value)
  if (!needsQuotes) return value
  return `"${escapeYamlString(value)}"`
}

function escapeYamlString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
}

function finalizeOutput(lines: string[]): string {
  const output = lines.join('\n').trimEnd()
  return output.length > 0 ? `${output}\n` : ''
}
