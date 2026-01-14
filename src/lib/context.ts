import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import {
  DEFAULT_CONFIG,
  type Config,
  type DiagnosticContextResult,
  type ExclusionReason,
  type MemoryRecord,
  type NearMissRecord,
  type ScoredRecord,
  type WarningRecord
} from './types.js'
import { looksLikeCommand, truncateText } from './shared.js'
import { buildExclusionReason } from './diagnostics.js'

export interface ContextSignals {
  errors: string[]
  commands: string[]
  projectRoot?: string
  projectName?: string
  domain?: string
}

const MAX_ERROR_SIGNALS = 4
const MAX_COMMAND_SIGNALS = 4
const MAX_SIGNAL_CHARS = 240
const MAX_ENTRY_CHARS = 600
const MAX_PROCEDURE_STEPS = 3
const MAX_STEP_CHARS = 160
const MAX_WARNING_RECORDS = 3
const MAX_WARNING_CHARS = 400

// Words/phrases to strip from prompts before memory processing
const NOISE_PATTERNS = [
  /\bultrathink\b/gi,
  /\bultrathin\b/gi,  // common typo
]

export function stripNoiseWords(text: string): string {
  let result = text
  for (const pattern of NOISE_PATTERNS) {
    result = result.replace(pattern, '')
  }
  // Only collapse horizontal whitespace (spaces/tabs), preserve newlines for code fence detection
  return result.replace(/[^\S\r\n]+/g, ' ').replace(/^ | $/gm, '').trim()
}

const STACK_START_REGEXES = [
  /^Traceback \(most recent call last\):/i,
  /^Exception in thread/i,
  /^Unhandled exception/i,
  /^Stack trace:/i,
  /^panic:/i
]

const STACK_CONT_REGEXES = [
  /^\s+at\s+/i,
  /^\s*Caused by:/i,
  /^\s*File\s+"?.+", line \d+/i,
  /^\s*in\s+[A-Za-z0-9_.]/i
]

const ERROR_LINE_REGEX = /(error|exception|traceback|panic|fatal|segmentation fault|stack trace|assertion failed|undefined reference|permission denied|no such file or directory|not found|ERR!)/i


export function extractSignals(prompt: string, cwd: string, projectRoot?: string): ContextSignals {
  const cleanPrompt = stripNoiseWords(prompt)
  const resolvedProjectRoot = projectRoot ?? findGitRoot(cwd)
  const projectName = resolvedProjectRoot ? path.basename(resolvedProjectRoot) : path.basename(cwd)
  const domain = inferDomain(resolvedProjectRoot ?? cwd)
  const errors = extractErrorSignals(cleanPrompt)
  const commands = extractCommandSignals(cleanPrompt)

  return {
    errors,
    commands,
    projectRoot: resolvedProjectRoot,
    projectName,
    domain
  }
}

export interface ContextBuildResult {
  context: string
  records: MemoryRecord[]
}

type ContextCandidate = MemoryRecord | ScoredRecord

type DiagnosticBuildContextOptions = {
  diagnostic: true
  mmrExclusions?: NearMissRecord[]
}

type StandardBuildContextOptions = {
  diagnostic?: false | undefined
  mmrExclusions?: NearMissRecord[]
}

type BuildContextOptions = DiagnosticBuildContextOptions | StandardBuildContextOptions

const CONTEXT_PREAMBLE = `These are memories from past sessions. Command results and state information may be outdated - verify current state by running commands rather than assuming these results are still valid.`

type ScoredWarningRecord = ScoredRecord & { record: WarningRecord }

function isScoredRecord(candidate: ContextCandidate): candidate is ScoredRecord {
  return 'record' in candidate
}

function toScoredRecord(candidate: ContextCandidate): ScoredRecord {
  if (isScoredRecord(candidate)) return candidate
  return {
    record: candidate,
    score: 0,
    similarity: 0,
    keywordMatch: false
  }
}

type WarningSectionResult = {
  lines: string[]
  usedTokens: number
  selected: ScoredWarningRecord[]
}

type MemorySectionResult = {
  lines: string[]
  usedTokens: number
  selected: ScoredRecord[]
}

function buildWarningSection(
  warnings: ScoredWarningRecord[],
  maxTokens: number,
  diagnostic: boolean,
  addExclusion: (record: ScoredRecord, reason: ExclusionReason) => void
): WarningSectionResult {
  if (warnings.length === 0) {
    return { lines: [], usedTokens: 0, selected: [] }
  }

  const warningHeader = '<known-pitfalls>'
  const warningFooter = '</known-pitfalls>'
  const headerTokens = estimateTokens(warningHeader)
  const footerTokens = estimateTokens(warningFooter)
  const warningBudget = maxTokens * 0.3

  const lines: string[] = []
  const selected: ScoredWarningRecord[] = []
  let usedTokens = 0
  let warningCount = 0

  for (let i = 0; i < warnings.length; i++) {
    if (warningCount >= MAX_WARNING_RECORDS) break
    const warning = warnings[i]
    const entry = formatWarningRecord(warning.record)
    const entryTokens = estimateTokens(entry)
    const baseTokens = warningCount === 0 ? usedTokens + headerTokens : usedTokens
    const projected = baseTokens + entryTokens + footerTokens
    if (projected > warningBudget) {
      if (diagnostic) {
        addExclusion(
          warning,
          buildExclusionReason('exceeded_token_budget', warningBudget, projected, { projectedTokens: projected })
        )
        for (let j = i + 1; j < warnings.length; j++) {
          const candidate = warnings[j]
          const candidateEntry = formatWarningRecord(candidate.record)
          const candidateTokens = estimateTokens(candidateEntry)
          const candidateBaseTokens = warningCount === 0 ? usedTokens + headerTokens : usedTokens
          const candidateProjected = candidateBaseTokens + candidateTokens + footerTokens
          addExclusion(
            candidate,
            buildExclusionReason('exceeded_token_budget', warningBudget, candidateProjected, {
              projectedTokens: candidateProjected
            })
          )
        }
      }
      break
    }

    if (warningCount === 0) {
      lines.push(warningHeader)
      usedTokens += headerTokens
    }

    lines.push(`- ${entry}`)
    usedTokens += entryTokens
    warningCount += 1
    selected.push(warning)
  }

  if (warningCount > 0) {
    lines.push(warningFooter)
    usedTokens += footerTokens
  }

  return { lines, usedTokens, selected }
}

function buildMemorySection(
  records: ScoredRecord[],
  maxTokens: number,
  maxRecords: number,
  diagnostic: boolean,
  addExclusion: (record: ScoredRecord, reason: ExclusionReason) => void,
  usedTokens: number
): MemorySectionResult {
  if (records.length === 0) {
    return { lines: [], usedTokens, selected: [] }
  }

  const header = '<prior-knowledge>'
  const preamble = CONTEXT_PREAMBLE
  const footer = '</prior-knowledge>'
  const headerTokens = estimateTokens(header)
  const preambleTokens = estimateTokens(preamble)
  const footerTokens = estimateTokens(footer)

  const lines: string[] = [header, preamble]
  const selected: ScoredRecord[] = []
  let added = 0
  let localUsedTokens = usedTokens + headerTokens + preambleTokens

  for (let i = 0; i < records.length; i++) {
    const record = records[i]
    const rank = i + 1
    if (added >= maxRecords) {
      if (diagnostic) {
        addExclusion(
          record,
          buildExclusionReason('exceeded_max_records', maxRecords, rank, { rank })
        )
      }
      if (!diagnostic) break
      continue
    }
    const entry = formatRecordWithAge(record.record)
    if (!entry) continue

    const line = `- ${entry}`
    const lineTokens = estimateTokens(line)
    const projected = localUsedTokens + lineTokens + footerTokens
    if (projected > maxTokens) {
      if (diagnostic) {
        addExclusion(
          record,
          buildExclusionReason('exceeded_token_budget', maxTokens, projected, { projectedTokens: projected })
        )
        for (let j = i + 1; j < records.length; j++) {
          const candidate = records[j]
          const candidateEntry = formatRecordWithAge(candidate.record)
          if (!candidateEntry) continue
          const candidateLine = `- ${candidateEntry}`
          const candidateTokens = estimateTokens(candidateLine)
          const candidateProjected = localUsedTokens + candidateTokens + footerTokens
          addExclusion(
            candidate,
            buildExclusionReason('exceeded_token_budget', maxTokens, candidateProjected, {
              projectedTokens: candidateProjected
            })
          )
        }
      }
      break
    }

    lines.push(line)
    localUsedTokens += lineTokens
    added += 1
    selected.push(record)
  }

  if (added === 0) {
    return { lines: [], usedTokens, selected: [] }
  }

  lines.push(footer)
  localUsedTokens += footerTokens

  return { lines, usedTokens: localUsedTokens, selected }
}

export function buildContext(
  records: MemoryRecord[],
  config?: Config
): ContextBuildResult
export function buildContext(
  records: ScoredRecord[],
  config?: Config
): ContextBuildResult
export function buildContext(
  records: ScoredRecord[],
  config: Config,
  options: DiagnosticBuildContextOptions
): DiagnosticContextResult
export function buildContext(
  records: ContextCandidate[],
  config: Config = DEFAULT_CONFIG,
  options: BuildContextOptions = {}
): ContextBuildResult | DiagnosticContextResult {
  const diagnostic = options.diagnostic === true
  const exclusionsById = diagnostic ? new Map<string, NearMissRecord>() : null

  const addExclusion = (record: ScoredRecord, reason: ExclusionReason): void => {
    if (!exclusionsById) return
    const existing = exclusionsById.get(record.record.id)
    if (existing) {
      existing.exclusionReasons.push(reason)
      return
    }
    exclusionsById.set(record.record.id, { record, exclusionReasons: [reason] })
  }

  if (diagnostic && options.mmrExclusions) {
    for (const exclusion of options.mmrExclusions) {
      for (const reason of exclusion.exclusionReasons) {
        addExclusion(exclusion.record, reason)
      }
    }
  }

  const candidates = records.map(toScoredRecord)
  const filtered = candidates.filter(candidate => !candidate.record.deprecated)
  if (filtered.length === 0) {
    if (diagnostic) {
      return {
        context: '',
        injectedRecords: [],
        exclusions: Array.from(exclusionsById?.values() ?? [])
      }
    }
    return { context: '', records: [] }
  }

  const maxTokens = config.injection.maxTokens
  const maxRecords = config.injection.maxRecords

  // Separate warnings from other memories
  const warnings = filtered.filter((r): r is ScoredWarningRecord => r.record.type === 'warning')
  const others = filtered.filter(r => r.record.type !== 'warning')

  const lines: string[] = []
  const selected: ScoredRecord[] = []

  const warningSection = buildWarningSection(warnings, maxTokens, diagnostic, addExclusion)
  lines.push(...warningSection.lines)
  selected.push(...warningSection.selected)

  const memorySection = buildMemorySection(
    others,
    maxTokens,
    maxRecords,
    diagnostic,
    addExclusion,
    warningSection.usedTokens
  )
  lines.push(...memorySection.lines)
  selected.push(...memorySection.selected)

  if (diagnostic && exclusionsById) {
    for (const injected of selected) {
      exclusionsById.delete(injected.record.id)
    }
  }

  const context = selected.length === 0 ? '' : lines.join('\n')

  if (!diagnostic) {
    if (selected.length === 0) return { context: '', records: [] }
    return { context, records: selected.map(item => item.record) }
  }

  return {
    context,
    injectedRecords: selected,
    exclusions: Array.from(exclusionsById?.values() ?? [])
  }
}

function formatWarningRecord(record: WarningRecord): string {
  const icon = record.severity === 'critical' ? '🚨' :
               record.severity === 'warning' ? '⚠️' : '⚡'
  const avoid = cleanInline(record.avoid)
  const useInstead = cleanInline(record.useInstead)
  const reason = cleanInline(record.reason)

  return truncateText(
    `${icon} Don't: ${avoid} → Use: ${useInstead} (${reason})`,
    MAX_WARNING_CHARS
  )
}

export function formatRecordSnippet(record: MemoryRecord): string | null {
  return formatRecord(record)
}

function extractErrorSignals(prompt: string): string[] {
  if (!prompt) return []

  const lines = prompt.split(/\r?\n/)
  const errors: string[] = []
  let currentStack: string[] | null = null

  const flushStack = (): void => {
    if (!currentStack || currentStack.length === 0) {
      currentStack = null
      return
    }
    const candidate = pickErrorLine(currentStack)
    if (candidate) errors.push(candidate)
    currentStack = null
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) {
      flushStack()
      continue
    }

    if (isStackStart(rawLine)) {
      flushStack()
      currentStack = [line]
      continue
    }

    if (currentStack) {
      if (isStackContinuation(rawLine)) {
        currentStack.push(line)
        continue
      }
      flushStack()
    }

    if (isErrorLine(rawLine)) {
      errors.push(line)
    }
  }

  flushStack()
  return dedupeAndTrim(errors, MAX_ERROR_SIGNALS)
}

function extractCommandSignals(prompt: string): string[] {
  if (!prompt) return []

  const lines = prompt.split(/\r?\n/)
  const commands: string[] = []
  let inFence = false

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (line.startsWith('```')) {
      inFence = !inFence
      continue
    }

    if (!inFence) continue
    if (!line) continue

    if (line.startsWith('$ ')) {
      commands.push(line.slice(2).trim())
      continue
    }

    if (line.startsWith('> ')) {
      commands.push(line.slice(2).trim())
      continue
    }

    if (line.startsWith('# ')) {
      commands.push(line.slice(2).trim())
      continue
    }

    if (looksLikeCommand(line)) {
      commands.push(line)
    }
  }

  return dedupeAndTrim(commands, MAX_COMMAND_SIGNALS)
}

function formatRecordWithAge(record: MemoryRecord): string | null {
  const base = formatRecord(record)
  if (!base) return null

  const age = formatRelativeAge(record.timestamp ?? record.lastUsed)
  if (!age) return base

  return `${base} | recorded: ${age}`
}

function formatRelativeAge(timestamp: number | undefined): string | null {
  if (!timestamp) return null

  const now = Date.now()
  const diff = now - timestamp
  if (diff < 0) return null

  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  const weeks = Math.floor(days / 7)
  const months = Math.floor(days / 30)

  if (months > 0) return `${months}mo ago`
  if (weeks > 0) return `${weeks}w ago`
  if (days > 0) return `${days}d ago`
  if (hours > 0) return `${hours}h ago`
  if (minutes > 5) return `${minutes}m ago`
  return 'just now'
}

function formatRecord(record: MemoryRecord): string | null {
  switch (record.type) {
    case 'command': {
      const parts = [
        `command: ${cleanInline(record.command)}`
      ]
      if (record.outcome) parts.push(`outcome: ${record.outcome}`)
      if (typeof record.exitCode === 'number') parts.push(`exit: ${record.exitCode}`)
      // Use "last result" instead of "resolution" to emphasize this is historical
      if (record.resolution) parts.push(`last result: ${cleanInline(record.resolution)}`)
      return truncateText(parts.join(' | '), MAX_ENTRY_CHARS)
    }
    case 'error': {
      const parts = [
        `error: ${cleanInline(record.errorText)}`,
        `resolution: ${cleanInline(record.resolution)}`
      ]
      if (record.cause) parts.push(`cause: ${cleanInline(record.cause)}`)
      return truncateText(parts.join(' | '), MAX_ENTRY_CHARS)
    }
    case 'discovery': {
      const parts = [
        `discovery: ${cleanInline(record.what)}`
      ]
      if (record.where) parts.push(`where: ${cleanInline(record.where)}`)
      if (record.confidence) parts.push(`confidence: ${record.confidence}`)
      return truncateText(parts.join(' | '), MAX_ENTRY_CHARS)
    }
    case 'procedure': {
      const steps = record.steps
        .slice(0, MAX_PROCEDURE_STEPS)
        .map(step => truncateText(cleanInline(step), MAX_STEP_CHARS))
      const parts = [
        `procedure: ${cleanInline(record.name)}`,
        `steps: ${steps.join('; ')}`
      ]
      if (record.verification) parts.push(`verify: ${cleanInline(record.verification)}`)
      return truncateText(parts.join(' | '), MAX_ENTRY_CHARS)
    }
    case 'warning': {
      const parts = [
        `warning: Don't ${cleanInline(record.avoid)}`,
        `use instead: ${cleanInline(record.useInstead)}`,
        `reason: ${cleanInline(record.reason)}`
      ]
      return truncateText(parts.join(' | '), MAX_ENTRY_CHARS)
    }
    default:
      return null
  }
}

function cleanInline(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

function dedupeAndTrim(values: string[], limit: number): string[] {
  const seen = new Set<string>()
  const result: string[] = []

  for (const raw of values) {
    const normalized = raw.replace(/\s+/g, ' ').trim()
    if (!normalized) continue
    const key = normalized.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(truncateText(normalized, MAX_SIGNAL_CHARS))
    if (result.length >= limit) break
  }

  return result
}

function isStackStart(line: string): boolean {
  return STACK_START_REGEXES.some(regex => regex.test(line))
}

function isStackContinuation(line: string): boolean {
  return STACK_CONT_REGEXES.some(regex => regex.test(line))
}

function isErrorLine(line: string): boolean {
  return ERROR_LINE_REGEX.test(line)
}

function pickErrorLine(lines: string[]): string {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (ERROR_LINE_REGEX.test(lines[i])) return lines[i].trim()
  }
  return lines[lines.length - 1].trim()
}

// looksLikeCommand is imported from shared.ts

function inferDomain(root: string): string | undefined {
  if (!root) return undefined

  const markers: Array<{ domain: string; files: string[] }> = [
    { domain: 'rust', files: ['Cargo.toml', 'Cargo.lock'] },
    { domain: 'go', files: ['go.mod', 'go.sum'] },
    { domain: 'node', files: ['package.json', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json'] },
    { domain: 'deno', files: ['deno.json', 'deno.jsonc'] },
    { domain: 'python', files: ['pyproject.toml', 'requirements.txt', 'Pipfile', 'setup.py'] },
    { domain: 'ruby', files: ['Gemfile', 'Gemfile.lock'] },
    { domain: 'php', files: ['composer.json'] },
    { domain: 'java', files: ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle'] },
    { domain: 'docker', files: ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml'] },
    { domain: 'terraform', files: ['main.tf', 'terraform.tf'] }
  ]

  for (const marker of markers) {
    for (const file of marker.files) {
      if (fileExists(root, file)) return marker.domain
    }
  }

  const entries = safeReadDir(root)
  if (entries.some(entry => entry.endsWith('.csproj') || entry.endsWith('.sln'))) {
    return 'dotnet'
  }
  if (entries.some(entry => entry.endsWith('.tf'))) {
    return 'terraform'
  }

  return undefined
}

function fileExists(root: string, filename: string): boolean {
  try {
    return fs.existsSync(path.join(root, filename))
  } catch {
    return false
  }
}

function safeReadDir(root: string): string[] {
  try {
    return fs.readdirSync(root)
  } catch {
    return []
  }
}

export function findGitRoot(cwd: string): string | undefined {
  if (!cwd) return undefined
  try {
    const output = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
      timeout: 500
    }).trim()
    return output || undefined
  } catch {
    return undefined
  }
}
