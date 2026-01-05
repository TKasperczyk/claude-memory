import fs from 'fs'
import path from 'path'
import { createHash } from 'crypto'
import { DEFAULT_CONFIG, type Config, type DiscoveryRecord, type MemoryRecord, type ProcedureRecord } from './types.js'
import { queryRecords } from './milvus.js'
import { KNOWN_COMMANDS, normalizeStep } from './shared.js'

const QUERY_PAGE_SIZE = 500
const SKILL_SUCCESS_THRESHOLD = 5
const CLAUDE_MD_SUCCESS_THRESHOLD = 3
const SKILL_NAME_MAX_LENGTH = 64
const PROJECT_SLUG_MAX_LENGTH = 80


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

export async function findSkillCandidates(
  config: Config = DEFAULT_CONFIG
): Promise<ProcedureRecord[]> {
  const filter = `type == "procedure" && success_count >= ${SKILL_SUCCESS_THRESHOLD} && deprecated == false`
  const records = await fetchRecords(filter, config)

  return records
    .filter(isProcedureRecord)
    .filter(record => !record.deprecated)
    .filter(record => (record.successCount ?? 0) >= SKILL_SUCCESS_THRESHOLD)
    .sort(compareByUsage)
}

export async function findClaudeMdCandidates(
  config: Config = DEFAULT_CONFIG
): Promise<ClaudeMdCandidateGroups> {
  const filter = `type == "discovery" && success_count >= ${CLAUDE_MD_SUCCESS_THRESHOLD} && deprecated == false`
  const records = await fetchRecords(filter, config)
  const verified = records
    .filter(isDiscoveryRecord)
    .filter(record => !record.deprecated)
    .filter(record => record.confidence === 'verified')
    .filter(record => (record.successCount ?? 0) >= CLAUDE_MD_SUCCESS_THRESHOLD)
    .sort(compareByUsage)

  const grouped: ClaudeMdCandidateGroups = { global: [], byProject: {} }

  for (const record of verified) {
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

  const [skillCandidates, claudeCandidates] = await Promise.all([
    findSkillCandidates(config),
    findClaudeMdCandidates(config)
  ])

  summary.skillCandidates = skillCandidates.length
  summary.claudeMdCandidates = claudeCandidates.global.length
    + Object.values(claudeCandidates.byProject).reduce((total, group) => total + group.length, 0)

  const skillsDir = path.join(root, 'suggestions', 'skills')
  const claudeDir = path.join(root, 'suggestions', 'claude-md')
  const dateStamp = formatDateStamp(new Date())

  ensureDir(skillsDir)
  ensureDir(claudeDir)

  const usedSkillNames = new Set<string>()
  for (const record of skillCandidates) {
    const baseName = normalizeSkillName(record.name, record.id)
    const fileBase = uniqueName(baseName, record.id, usedSkillNames)
    const filePath = resolveSuggestionPath(
      path.join(skillsDir, `${fileBase}.md`),
      dateStamp
    )
    fs.writeFileSync(filePath, generateSkillSuggestion(record), 'utf-8')
    summary.skillFiles.push(filePath)
  }

  if (claudeCandidates.global.length > 0) {
    const filePath = resolveSuggestionPath(path.join(claudeDir, 'global.md'), dateStamp)
    fs.writeFileSync(filePath, generateClaudeMdSuggestion(claudeCandidates.global), 'utf-8')
    summary.claudeMdFiles.push(filePath)
  }

  for (const [project, records] of Object.entries(claudeCandidates.byProject)) {
    if (records.length === 0) continue
    const fileBase = normalizeProjectFileName(project)
    const filePath = resolveSuggestionPath(
      path.join(claudeDir, `${fileBase}.md`),
      dateStamp
    )
    fs.writeFileSync(filePath, generateClaudeMdSuggestion(records), 'utf-8')
    summary.claudeMdFiles.push(filePath)
  }

  return summary
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
  const successDiff = (b.successCount ?? 0) - (a.successCount ?? 0)
  if (successDiff !== 0) return successDiff
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
