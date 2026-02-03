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
import { queryRecords } from '../milvus.js'
import { resolveMaintenanceSettings, type MaintenanceSettings } from '../settings.js'
import { normalizeStep } from '../shared.js'

export const QUERY_PAGE_SIZE = 500

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
  const filter = `deprecated == false && last_used < ${Math.trunc(cutoff)}`
  return fetchRecords(filter, config, false)
}

export async function findGlobalCandidates(
  config: Config = DEFAULT_CONFIG,
  settings?: MaintenanceSettings
): Promise<MemoryRecord[]> {
  const maintenance = resolveMaintenanceSettings(settings)
  const candidates: MemoryRecord[] = []
  const types = ['error', 'command', 'discovery'] as const
  const typeFilter = types.map(type => `type == "${type}"`).join(' || ')
  const countFilter = [
    `(type == "command" && success_count >= ${maintenance.globalPromotionMinSuccessCount})`,
    `(type != "command" && usage_count >= ${maintenance.globalPromotionMinSuccessCount})`
  ].join(' || ')
  const filter = ['deprecated == false', `(${typeFilter})`, `(${countFilter})`].join(' && ')
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
  const filter = `deprecated == false && retrieval_count >= ${maintenance.lowUsageMinRetrievals}`
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
  const filter = ['deprecated == false', `retrieval_count >= ${maintenance.lowUsageHighRetrievalMin}`].join(' && ')
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
  const filter = ['deprecated == false', `timestamp < ${Math.trunc(cutoff)}`].join(' && ')
  const records = await fetchRecords(filter, config, false)
  return records.filter(record => (record.usageCount ?? 0) === 0)
}

export async function checkValidity(record: MemoryRecord, settings?: MaintenanceSettings): Promise<ValidityResult> {
  const maintenance = resolveMaintenanceSettings(settings)
  switch (record.type) {
    case 'command': {
      const command = extractExecutable(record.command)
      if (!command) return { valid: false, reason: 'missing-command' }
      const exists = commandExists(command, record.context.cwd ?? record.context.project ?? record.project)
      return exists ? { valid: true } : { valid: false, reason: `missing-command:${command}` }
    }
    case 'procedure': {
      const baseDir = record.context.project ?? record.project
      const steps = pickProcedureSteps(record.steps, maintenance.procedureStepCheckCount)
      if (steps.length === 0) return { valid: false, reason: 'missing-procedure-step' }

      for (const step of steps) {
        const command = extractExecutable(step)
        if (!command) return { valid: false, reason: 'missing-command' }
        const exists = commandExists(command, baseDir)
        if (!exists) return { valid: false, reason: `missing-command:${command}` }
      }

      return { valid: true }
    }
    case 'discovery': {
      const timestamp = record.timestamp ?? 0
      if (!timestamp) return { valid: true, reason: 'no-timestamp' }
      const ageDays = (Date.now() - timestamp) / (1000 * 60 * 60 * 24)
      if (ageDays >= maintenance.discoveryMaxAgeDays) {
        return { valid: false, reason: `discovery-aged:${Math.floor(ageDays)}d` }
      }
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

  if (checkWhich(command)) return true
  if (checkType(command)) return true
  return false
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

function checkWhich(command: string): boolean {
  try {
    execFileSync('which', [command], { stdio: 'ignore' })
    return true
  } catch {
    return false
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
