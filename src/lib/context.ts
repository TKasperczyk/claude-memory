import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { DEFAULT_CONFIG, type Config, type MemoryRecord, type WarningRecord } from './types.js'
import { KNOWN_COMMANDS } from './shared.js'

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

const CONTEXT_PREAMBLE = `These are memories from past sessions. Command results and state information may be outdated - verify current state by running commands rather than assuming these results are still valid.`

export function buildContext(
  records: MemoryRecord[],
  config: Config = DEFAULT_CONFIG
): ContextBuildResult {
  const filtered = records.filter(record => !record.deprecated)
  if (filtered.length === 0) return { context: '', records: [] }

  const maxTokens = config.injection.maxTokens
  const maxRecords = config.injection.maxRecords

  // Separate warnings from other memories
  const warnings = filtered.filter((r): r is WarningRecord => r.type === 'warning')
  const others = filtered.filter(r => r.type !== 'warning')

  const lines: string[] = []
  let usedTokens = 0
  const selected: MemoryRecord[] = []

  // Inject warnings FIRST with special header (if any exist)
  if (warnings.length > 0) {
    const warningHeader = '<known-pitfalls>'
    const warningFooter = '</known-pitfalls>'
    lines.push(warningHeader)
    usedTokens += estimateTokens(warningHeader)

    let warningCount = 0
    for (const warning of warnings) {
      if (warningCount >= MAX_WARNING_RECORDS) break
      const entry = formatWarningRecord(warning)
      const entryTokens = estimateTokens(entry)
      const projected = usedTokens + entryTokens + estimateTokens(warningFooter)
      if (projected > maxTokens * 0.3) break // Warnings get max 30% of budget

      lines.push(`- ${entry}`)
      usedTokens += entryTokens
      warningCount += 1
      selected.push(warning)
    }

    lines.push(warningFooter)
    usedTokens += estimateTokens(warningFooter)
  }

  // Now inject other memories
  const header = '<prior-knowledge>'
  const preamble = CONTEXT_PREAMBLE
  const footer = '</prior-knowledge>'

  if (others.length > 0) {
    lines.push(header)
    lines.push(preamble)
    usedTokens += estimateTokens(header) + estimateTokens(preamble)

    let added = 0
    for (const record of others) {
      if (added >= maxRecords) break
      const entry = formatRecordWithAge(record)
      if (!entry) continue

      const line = `- ${entry}`
      const lineTokens = estimateTokens(line)
      const projected = usedTokens + lineTokens + estimateTokens(footer)
      if (projected > maxTokens) break

      lines.push(line)
      usedTokens += lineTokens
      added += 1
      selected.push(record)
    }

    if (added > 0) {
      lines.push(footer)
    } else {
      // Remove header/preamble if no records were added
      lines.splice(lines.indexOf(header), 2)
    }
  }

  if (selected.length === 0) return { context: '', records: [] }

  return { context: lines.join('\n'), records: selected }
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

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return value.slice(0, maxLength - 3) + '...'
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

function looksLikeCommand(line: string): boolean {
  const first = line.split(/\s+/)[0]
  if (!first) return false
  if (first.startsWith('./')) return true
  return KNOWN_COMMANDS.has(first)
}

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
