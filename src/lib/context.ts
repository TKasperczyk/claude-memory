import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { DEFAULT_CONFIG, type Config, type MemoryRecord } from './types.js'

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

const KNOWN_COMMANDS = new Set([
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'npx',
  'node',
  'deno',
  'python',
  'python3',
  'pip',
  'pip3',
  'uv',
  'poetry',
  'cargo',
  'rustc',
  'go',
  'dotnet',
  'mvn',
  'gradle',
  'javac',
  'java',
  'git',
  'docker',
  'kubectl',
  'helm',
  'terraform',
  'ansible',
  'make',
  'cmake',
  'ninja',
  'rg',
  'grep',
  'sed',
  'awk',
  'curl',
  'wget',
  'ssh',
  'scp',
  'systemctl',
  'journalctl',
  'ps',
  'kill',
  'chmod',
  'chown',
  'ls',
  'cat',
  'cp',
  'mv',
  'rm',
  'find'
])

export function extractSignals(prompt: string, cwd: string): ContextSignals {
  const projectRoot = findGitRoot(cwd)
  const projectName = projectRoot ? path.basename(projectRoot) : path.basename(cwd)
  const domain = inferDomain(projectRoot ?? cwd)
  const errors = extractErrorSignals(prompt)
  const commands = extractCommandSignals(prompt)

  return {
    errors,
    commands,
    projectRoot,
    projectName,
    domain
  }
}

export function formatContext(
  records: MemoryRecord[],
  config: Config = DEFAULT_CONFIG
): string {
  const filtered = records.filter(record => !record.deprecated)
  if (filtered.length === 0) return ''

  const maxTokens = config.injection.maxTokens
  const maxRecords = config.injection.maxRecords

  const header = '<prior-knowledge>'
  const footer = '</prior-knowledge>'
  const lines: string[] = [header]
  let usedTokens = estimateTokens(header)
  let added = 0

  for (const record of filtered) {
    if (added >= maxRecords) break
    const entry = formatRecord(record)
    if (!entry) continue

    const line = `- ${entry}`
    const lineTokens = estimateTokens(line)
    const projected = usedTokens + lineTokens + estimateTokens(footer)
    if (projected > maxTokens) break

    lines.push(line)
    usedTokens += lineTokens
    added += 1
  }

  if (added === 0) return ''

  lines.push(footer)
  return lines.join('\n')
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

function formatRecord(record: MemoryRecord): string | null {
  switch (record.type) {
    case 'command': {
      const parts = [
        `command: ${cleanInline(record.command)}`
      ]
      if (record.outcome) parts.push(`outcome: ${record.outcome}`)
      if (typeof record.exitCode === 'number') parts.push(`exit: ${record.exitCode}`)
      if (record.resolution) parts.push(`resolution: ${cleanInline(record.resolution)}`)
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
      encoding: 'utf-8'
    }).trim()
    return output || undefined
  } catch {
    return undefined
  }
}
