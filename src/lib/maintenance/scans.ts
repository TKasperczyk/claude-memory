import { execFileSync } from 'child_process'
import fs from 'fs'
import { homedir } from 'os'
import path from 'path'
import {
  DEFAULT_CONFIG,
  EMBEDDING_DIM,
  type Config,
  type MemoryRecord
} from '../types.js'
import { queryRecords } from '../lancedb.js'
import { resolveMaintenanceSettings, type MaintenanceSettings } from '../settings.js'
import { normalizeStep } from '../shared.js'

export const QUERY_PAGE_SIZE = 500
const COMMAND_EXISTS_CACHE_TTL_MS = 2 * 60 * 1000

interface ValidityResult {
  valid: boolean
  reason?: string
}

export async function findStaleRecords(
  config: Config = DEFAULT_CONFIG,
  settings?: MaintenanceSettings
): Promise<MemoryRecord[]> {
  const maintenance = resolveMaintenanceSettings(settings)
  const cutoff = Date.now() - maintenance.staleDays * 24 * 60 * 60 * 1000
  const filter = `deprecated = false AND last_used < ${Math.trunc(cutoff)}`
  return fetchRecords(filter, config, false)
}

export async function findGlobalCandidates(
  config: Config = DEFAULT_CONFIG,
  settings?: MaintenanceSettings
): Promise<MemoryRecord[]> {
  const maintenance = resolveMaintenanceSettings(settings)
  const candidates: MemoryRecord[] = []
  const types = ['error', 'command', 'discovery'] as const
  const typeFilter = types.map(type => `type = '${type}'`).join(' OR ')
  const countFilter = [
    `(type = 'command' AND success_count >= ${maintenance.globalPromotionMinSuccessCount})`,
    `(type <> 'command' AND usage_count >= ${maintenance.globalPromotionMinSuccessCount})`
  ].join(' OR ')
  const filter = ['deprecated = false', `(${typeFilter})`, `(${countFilter})`].join(' AND ')
  const records = await fetchRecords(filter, config, false)

  for (const record of records) {
    if (record.scope === 'global') continue
    if (record.deprecated) continue
    if (isGlobalCandidate(record, maintenance)) {
      candidates.push(record)
    }
  }

  return candidates
}

export async function findLowUsageRecords(
  config: Config = DEFAULT_CONFIG,
  settings?: MaintenanceSettings
): Promise<MemoryRecord[]> {
  const maintenance = resolveMaintenanceSettings(settings)
  // Find records retrieved at least N times with usage ratio below threshold
  const filter = `deprecated = false AND retrieval_count >= ${maintenance.lowUsageMinRetrievals}`
  const records = await fetchRecords(filter, config, false)

  return records.filter(record => {
    const retrievalCount = record.retrievalCount ?? 0
    const usageCount = record.usageCount ?? 0
    if (retrievalCount < maintenance.lowUsageMinRetrievals) return false
    const ratio = usageCount / retrievalCount
    return ratio < maintenance.lowUsageRatioThreshold
  })
}

export async function findLowUsageHighRetrieval(
  config: Config = DEFAULT_CONFIG,
  settings?: MaintenanceSettings
): Promise<MemoryRecord[]> {
  const maintenance = resolveMaintenanceSettings(settings)
  const filter = ['deprecated = false', `retrieval_count >= ${maintenance.lowUsageHighRetrievalMin}`].join(' AND ')
  const records = await fetchRecords(filter, config, false)
  return records.filter(record => (record.usageCount ?? 0) === 0)
}

/**
 * Find records older than staleUnusedDays with zero usage.
 * These are memories that were extracted but never proved useful.
 */
export async function findStaleUnusedRecords(
  config: Config = DEFAULT_CONFIG,
  settings?: MaintenanceSettings
): Promise<MemoryRecord[]> {
  const maintenance = resolveMaintenanceSettings(settings)
  const cutoff = Date.now() - maintenance.staleUnusedDays * 24 * 60 * 60 * 1000
  const filter = ['deprecated = false', `timestamp < ${Math.trunc(cutoff)}`].join(' AND ')
  const records = await fetchRecords(filter, config, false)
  return records.filter(record => (record.usageCount ?? 0) === 0)
}

export async function checkValidity(record: MemoryRecord, settings?: MaintenanceSettings): Promise<ValidityResult> {
  const maintenance = resolveMaintenanceSettings(settings)
  switch (record.type) {
    case 'command': {
      const parsed = parseCommandLine(record.command)
      const command = parsed.executable
      if (!command) {
        return isClearlyProjectLocalCommand(record.command, null, parsed.args)
          ? { valid: true }
          : { valid: false, reason: 'missing-command' }
      }
      const exists = commandExists(command, record.context.cwd ?? record.context.project ?? record.project)
      if (!exists && isClearlyProjectLocalCommand(record.command, command, parsed.args)) return { valid: true }
      return exists ? { valid: true } : { valid: false, reason: `missing-command:${command}` }
    }
    case 'procedure': {
      const baseDir = record.context.project ?? record.project
      const steps = pickProcedureSteps(record.steps, maintenance.procedureStepCheckCount)
      if (steps.length === 0) return { valid: true }

      for (const step of steps) {
        if (!looksLikeShellCommandStep(step, baseDir)) continue
        const parsed = parseCommandLine(step)
        const command = parsed.executable
        if (!command) continue
        const exists = commandExists(command, baseDir)
        if (!exists && isClearlyProjectLocalCommand(step, command, parsed.args)) continue
        if (!exists) return { valid: false, reason: `missing-command:${command}` }
      }

      return { valid: true }
    }
    case 'discovery': {
      return { valid: true }
    }
    case 'error':
      return { valid: true, reason: 'assumed-valid' }
    case 'warning':
      return { valid: true, reason: 'assumed-valid' }
  }
}

export async function fetchRecords(
  filter: string | undefined,
  config: Config,
  includeEmbeddings: boolean
): Promise<MemoryRecord[]> {
  const records: MemoryRecord[] = []
  let offset = 0

  while (true) {
    const batch = await queryRecords(
      {
        filter,
        limit: QUERY_PAGE_SIZE,
        offset,
        includeEmbeddings
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

export function isValidEmbedding(embedding: number[] | undefined): embedding is number[] {
  return Array.isArray(embedding) && embedding.length === EMBEDDING_DIM
}

/**
 * Check if a record is a candidate for global promotion based on usage metrics.
 * The actual decision is made by the LLM in checkGlobalPromotion().
 */
function isGlobalCandidate(record: MemoryRecord, settings: MaintenanceSettings): boolean {
  // Only command, error, and discovery types can be promoted
  if (record.type !== 'command' && record.type !== 'error' && record.type !== 'discovery') {
    return false
  }

  const successCount = record.successCount ?? 0
  const usageCount = record.usageCount ?? 0

  // Commands need successful executions, other types need usage
  if (record.type === 'command') {
    if (successCount < settings.globalPromotionMinSuccessCount) return false
  } else if (usageCount < settings.globalPromotionMinSuccessCount) {
    return false
  }

  // Check usage ratio if we have enough retrievals
  const retrievalCount = record.retrievalCount ?? 0
  if (retrievalCount >= settings.globalPromotionMinRetrievalsForUsageRatio) {
    const ratio = usageCount / retrievalCount
    if (ratio < settings.globalPromotionMinUsageRatio) return false
  }

  return true
}

function pickProcedureSteps(steps: string[], maxSteps: number): string[] {
  const normalized = steps
    .map(step => normalizeStep(step))
    .filter(step => step.length > 0)
  return normalized.slice(0, maxSteps)
}

function extractExecutable(commandLine: string): string | null {
  return parseCommandLine(commandLine).executable
}

const PACKAGE_MANAGER_COMMANDS = new Set(['npm', 'pnpm', 'yarn', 'bun'])
const PROJECT_LOCAL_COMMANDS = new Set(['npx', 'tsx', 'node', 'python', 'python3', 'uv', 'uvx'])
const KNOWN_SHELL_COMMANDS = new Set([
  'adb',
  'awk',
  'bun',
  'cargo',
  'cat',
  'chmod',
  'chown',
  'cmake',
  'cp',
  'curl',
  'docker',
  'find',
  'ffmpeg',
  'git',
  'go',
  'grep',
  'ls',
  'magick',
  'make',
  'mkdir',
  'mv',
  'node',
  'npm',
  'npx',
  'pnpm',
  'python',
  'python3',
  'pytest',
  'rm',
  'rsync',
  'scp',
  'sed',
  'ssh',
  'systemctl',
  'tar',
  'tsx',
  'unzip',
  'uv',
  'uvx',
  'vitest',
  'wget',
  'yarn',
  'zip'
])

function isClearlyProjectLocalCommand(commandLine: string, executable: string | null, args: string[]): boolean {
  const command = executable ?? extractExecutable(commandLine)
  if (!command) return false
  if (looksLikePath(command)) return true
  if (PACKAGE_MANAGER_COMMANDS.has(command)) return true
  if (PROJECT_LOCAL_COMMANDS.has(command)) return true
  if (args.length > 0 && (args[0] === 'run' || args[0] === 'exec') && PACKAGE_MANAGER_COMMANDS.has(command)) return true
  return false
}

function looksLikeShellCommandStep(step: string, cwd?: string): boolean {
  const trimmed = step.trim()
  if (!trimmed) return false
  if (trimmed.startsWith('$ ')) return true

  const parsed = parseCommandLine(trimmed)
  const command = parsed.executable
  if (!command) return false
  if (looksLikePath(command)) return true
  if (KNOWN_SHELL_COMMANDS.has(command)) return true
  if (commandExists(command, cwd)) return true
  if (/^\p{Lu}/u.test(command)) return false
  return /\s--?[A-Za-z0-9][A-Za-z0-9-]*/.test(trimmed)
}

function parseCommandLine(commandLine: string): { executable: string | null; args: string[] } {
  const segment = firstCommandSegment(commandLine)
  const tokens = tokenizeCommand(segment)
  if (tokens.length === 0) return { executable: null, args: [] }

  let index = 0
  while (index < tokens.length) {
    const token = stripQuotes(tokens[index])
    if (!token) {
      index += 1
      continue
    }

    if (token === 'sudo') {
      index = skipSudoOptions(tokens, index + 1)
      continue
    }

    if (token === 'env') {
      index = skipEnvOptions(tokens, index + 1)
      continue
    }

    if (isEnvAssignment(token)) {
      index += 1
      continue
    }

    const args = tokens.slice(index + 1).map(stripQuotes).filter(Boolean)
    return { executable: token, args }
  }

  return { executable: null, args: [] }
}

function firstCommandSegment(commandLine: string): string {
  let inSingle = false
  let inDouble = false
  let escaped = false

  for (let i = 0; i < commandLine.length; i += 1) {
    const char = commandLine[i]

    if (escaped) {
      escaped = false
      continue
    }

    if (char === '\\' && !inSingle) {
      escaped = true
      continue
    }

    if (char === "'" && !inDouble) {
      inSingle = !inSingle
      continue
    }

    if (char === '"' && !inSingle) {
      inDouble = !inDouble
      continue
    }

    if (inSingle || inDouble) continue

    if (char === ';' || char === '|') {
      return commandLine.slice(0, i).trim()
    }

    if (char === '&' && commandLine[i + 1] === '&') {
      return commandLine.slice(0, i).trim()
    }
  }

  return commandLine.trim()
}

function tokenizeCommand(commandLine: string): string[] {
  const matches = commandLine.match(/"[^"]*"|'[^']*'|[^\s]+/g)
  return matches ? matches.map(token => token.trim()).filter(Boolean) : []
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1)
    }
  }
  return value
}

function skipSudoOptions(tokens: string[], startIndex: number): number {
  let index = startIndex
  while (index < tokens.length) {
    const token = stripQuotes(tokens[index])
    if (!token.startsWith('-')) break
    if (requiresOptionValue(token) && index + 1 < tokens.length) {
      index += 2
    } else {
      index += 1
    }
  }
  return index
}

function skipEnvOptions(tokens: string[], startIndex: number): number {
  let index = startIndex
  while (index < tokens.length) {
    const token = stripQuotes(tokens[index])
    if (!token.startsWith('-')) break
    if (requiresOptionValue(token) && index + 1 < tokens.length) {
      index += 2
    } else {
      index += 1
    }
  }
  while (index < tokens.length) {
    const token = stripQuotes(tokens[index])
    if (!isEnvAssignment(token)) break
    index += 1
  }
  return index
}

function requiresOptionValue(option: string): boolean {
  return option === '-u' || option === '-g' || option === '-h' || option === '-p' || option === '-U'
}

function isEnvAssignment(token: string): boolean {
  if (!token.includes('=')) return false
  if (token.startsWith('=')) return false
  const key = token.split('=', 1)[0]
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
}

function commandExists(command: string, cwd?: string): boolean {
  if (looksLikePath(command)) {
    return isExecutablePath(command, cwd)
  }

  const cacheKey = commandCacheKey(command, cwd)
  const cached = commandExistsCache.get(cacheKey)
  if (cached && isCommandCacheEntryValid(cached)) {
    return cached.value
  }

  const now = Date.now()
  const resolved = findCommandPath(command)
  if (resolved) {
    commandExistsCache.set(cacheKey, { value: true, checkedAt: now, kind: 'path', resolvedPath: resolved })
    return true
  }

  const exists = checkType(command)
  commandExistsCache.set(cacheKey, { value: exists, checkedAt: now, kind: exists ? 'builtin' : 'missing' })
  return exists
}

function looksLikePath(command: string): boolean {
  return command.startsWith('./') || command.startsWith('/') || command.includes('/')
}

function isExecutablePath(command: string, cwd?: string): boolean {
  const resolved = resolveCommandPath(command, cwd)
  if (!fs.existsSync(resolved)) return false
  try {
    fs.accessSync(resolved, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

type CommandExistsCacheEntry = {
  value: boolean
  checkedAt: number
  kind: 'path' | 'builtin' | 'missing'
  resolvedPath?: string
}

const commandExistsCache = new Map<string, CommandExistsCacheEntry>()

function commandCacheKey(command: string, cwd?: string): string {
  const envSignature = `${process.env.PATH ?? ''}|${process.env.SHELL ?? ''}`
  return `${envSignature}|${cwd ?? ''}|${command}`
}

function isCommandCacheEntryValid(entry: CommandExistsCacheEntry): boolean {
  if (Date.now() - entry.checkedAt > COMMAND_EXISTS_CACHE_TTL_MS) return false
  if (entry.kind === 'path' && entry.resolvedPath) {
    return isExecutableFile(entry.resolvedPath)
  }
  return true
}

function isExecutableFile(commandPath: string): boolean {
  try {
    fs.accessSync(commandPath, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

function findCommandPath(command: string): string | null {
  try {
    const output = execFileSync('which', [command], {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8'
    }).trim()
    if (!output) return null
    return output.split(/\r?\n/)[0]
  } catch {
    return null
  }
}

function checkType(command: string): boolean {
  const shell = process.env.SHELL || 'bash'
  try {
    execFileSync(shell, ['-lc', `type -a -- ${shellEscape(command)}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function resolveCommandPath(command: string, cwd?: string): string {
  const expanded = command.startsWith('~')
    ? path.join(homedir(), command.slice(1).replace(/^\/+/, ''))
    : command
  if (path.isAbsolute(expanded)) return expanded
  return path.resolve(cwd ?? process.cwd(), expanded)
}
