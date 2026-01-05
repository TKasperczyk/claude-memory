import { execFileSync } from 'child_process'
import fs from 'fs'
import { homedir } from 'os'
import path from 'path'
import { DEFAULT_CONFIG, EMBEDDING_DIM, type Config, type MemoryRecord } from './types.js'
import { queryRecords, updateRecord, vectorSearchSimilar } from './milvus.js'
import { buildExactText, escapeFilterValue, normalizeExactText, normalizeStep } from './shared.js'

const STALE_DAYS = 90
const DISCOVERY_MAX_AGE_DAYS = 180
const QUERY_PAGE_SIZE = 500
const PROCEDURE_STEP_CHECK_COUNT = 3
const CONSOLIDATION_SEARCH_LIMIT = 12
const CONSOLIDATION_MAX_CLUSTER_SIZE = 8
const TEXT_SIMILARITY_RATIO = 0.2
const LOW_USAGE_MIN_RETRIEVALS = 5
const LOW_USAGE_RATIO_THRESHOLD = 0.1
const CONTRADICTION_SIMILARITY_THRESHOLD = 0.75
const CONTRADICTION_SEARCH_LIMIT = 8
const GLOBAL_TOOL_KEYWORDS = [
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'npx',
  'node',
  'nodejs',
  'deno',
  'python',
  'python3',
  'pip',
  'pip3',
  'pipx',
  'uv',
  'poetry',
  'cargo',
  'rustc',
  'git',
  'docker',
  'docker-compose',
  'kubectl',
  'helm',
  'terraform',
  'ansible',
  'dotnet',
  'mvn',
  'gradle',
  'javac',
  'java'
]
const GLOBAL_COMMAND_TOOLS = new Set(GLOBAL_TOOL_KEYWORDS)
const GLOBAL_DISCOVERY_KEYWORDS = [
  'javascript',
  'typescript',
  'node',
  'nodejs',
  'python',
  'rust',
  'golang',
  'java',
  'kotlin',
  'c#',
  'c++',
  'ruby',
  'php',
  'swift',
  'scala',
  'elixir',
  'erlang',
  'bash',
  'shell',
  'zsh',
  'sql',
  'postgres',
  'postgresql',
  'mysql',
  'sqlite',
  'react',
  'vue',
  'angular',
  'svelte',
  'next.js',
  'nuxt',
  'express',
  'fastify',
  'django',
  'flask',
  'rails',
  'laravel',
  'spring',
  'grpc',
  'graphql'
]
const GENERIC_COMMAND_FLAGS = new Set(['--help', '-h', '--version', '-v', '-V', '--info', '--list'])
const GENERIC_SUBCOMMANDS = new Set(['help', 'version', 'info', 'list'])
const PACKAGE_MANAGER_TOOLS = new Set(['npm', 'pnpm', 'yarn', 'bun'])
const PACKAGE_MANAGER_SCRIPT_SUBCOMMANDS = new Set(['run', 'test', 'build', 'lint', 'start', 'dev', 'serve', 'check', 'format'])
const FILE_EXTENSION_REGEX = /\.(json|yml|yaml|toml|lock|md|txt|ini|cfg|conf|sh|py|rs|go|java|js|ts|tsx|jsx|c|cc|cpp|h|hpp)$/i
const PATH_TEXT_REGEX = /(^|\s)(\.{1,2}[\\/]|~\/|[A-Za-z]:[\\/]|\/[A-Za-z0-9._-]+|[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)/
const GLOBAL_TOOL_REGEXES = GLOBAL_TOOL_KEYWORDS.map(buildKeywordRegex)
const GLOBAL_DISCOVERY_REGEXES = GLOBAL_DISCOVERY_KEYWORDS.map(buildKeywordRegex)

export interface ValidityResult {
  valid: boolean
  reason?: string
}

export interface ConsolidationResult {
  keptId: string
  deprecatedIds: string[]
  successCount: number
  failureCount: number
  retrievalCount: number
  usageCount: number
  lastUsed: number
}

export interface ContradictionPair {
  newer: MemoryRecord
  older: MemoryRecord
  similarity: number
}

export async function findStaleRecords(config: Config = DEFAULT_CONFIG): Promise<MemoryRecord[]> {
  const cutoff = Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000
  const filter = `deprecated == false && last_used < ${Math.trunc(cutoff)}`
  return fetchRecords(filter, config, false)
}

export async function findGlobalCandidates(config: Config = DEFAULT_CONFIG): Promise<MemoryRecord[]> {
  const candidates: MemoryRecord[] = []
  const types = ['error', 'command', 'discovery'] as const

  for (const type of types) {
    const records = await fetchRecords(`deprecated == false && type == "${type}"`, config, false)
    for (const record of records) {
      if (record.scope === 'global') continue
      if (record.deprecated) continue
      if (isGlobalCandidate(record)) {
        candidates.push(record)
      }
    }
  }

  return candidates
}

export async function findLowUsageRecords(config: Config = DEFAULT_CONFIG): Promise<MemoryRecord[]> {
  // Find records retrieved at least N times with usage ratio below threshold
  const filter = `deprecated == false && retrieval_count >= ${LOW_USAGE_MIN_RETRIEVALS}`
  const records = await fetchRecords(filter, config, false)

  return records.filter(record => {
    const retrievalCount = record.retrievalCount ?? 0
    const usageCount = record.usageCount ?? 0
    if (retrievalCount < LOW_USAGE_MIN_RETRIEVALS) return false
    const ratio = usageCount / retrievalCount
    return ratio < LOW_USAGE_RATIO_THRESHOLD
  })
}

export async function checkValidity(record: MemoryRecord): Promise<ValidityResult> {
  switch (record.type) {
    case 'command': {
      const command = extractExecutable(record.command)
      if (!command) return { valid: false, reason: 'missing-command' }
      const exists = commandExists(command, record.context.cwd ?? record.context.project ?? record.project)
      return exists ? { valid: true } : { valid: false, reason: `missing-command:${command}` }
    }
    case 'procedure': {
      const baseDir = record.context.project ?? record.project
      const steps = pickProcedureSteps(record.steps, PROCEDURE_STEP_CHECK_COUNT)
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
      if (ageDays >= DISCOVERY_MAX_AGE_DAYS) {
        return { valid: false, reason: `discovery-aged:${Math.floor(ageDays)}d` }
      }
      return { valid: true }
    }
    case 'error':
      return { valid: true, reason: 'assumed-valid' }
  }
}

export async function markDeprecated(id: string, config: Config = DEFAULT_CONFIG): Promise<boolean> {
  return updateRecord(id, { deprecated: true }, config)
}

export async function promoteToGlobal(id: string, config: Config = DEFAULT_CONFIG): Promise<boolean> {
  return updateRecord(id, { scope: 'global' }, config)
}

export async function findSimilarClusters(
  similarityThreshold: number = 0.85,
  config: Config = DEFAULT_CONFIG
): Promise<MemoryRecord[][]> {
  const clusters: MemoryRecord[][] = []
  const clusteredIds = new Set<string>()
  let offset = 0

  while (true) {
    const batch = await queryRecords(
      {
        filter: 'deprecated == false',
        limit: QUERY_PAGE_SIZE,
        offset,
        includeEmbeddings: true
      },
      config
    )

    if (batch.length === 0) break

    for (const record of batch) {
      if (clusteredIds.has(record.id)) continue
      if (!isValidEmbedding(record.embedding)) continue

      const seedText = normalizeExactText(buildExactText(record))
      if (!seedText) continue

      const matches = await vectorSearchSimilar(
        record.embedding,
        {
          filter: buildConsolidationFilter(record),
          limit: CONSOLIDATION_SEARCH_LIMIT,
          similarityThreshold
        },
        config
      )

      const cluster: MemoryRecord[] = [record]
      for (const match of matches) {
        const candidate = match.record
        if (clusteredIds.has(candidate.id)) continue
        if (candidate.deprecated) continue

        const candidateText = normalizeExactText(buildExactText(candidate))
        if (!candidateText) continue
        if (!isExactTextSimilar(seedText, candidateText)) continue

        cluster.push(candidate)
        if (cluster.length >= CONSOLIDATION_MAX_CLUSTER_SIZE) break
      }

      if (cluster.length > 1) {
        clusters.push(cluster)
        for (const member of cluster) {
          clusteredIds.add(member.id)
        }
      }
    }

    if (batch.length < QUERY_PAGE_SIZE) break
    offset += batch.length
  }

  return clusters
}

export async function consolidateCluster(
  cluster: MemoryRecord[],
  config: Config = DEFAULT_CONFIG
): Promise<ConsolidationResult | null> {
  if (cluster.length < 2) return null

  const sorted = [...cluster].sort((a, b) => {
    const successDiff = (b.successCount ?? 0) - (a.successCount ?? 0)
    if (successDiff !== 0) return successDiff
    const lastUsedDiff = (b.lastUsed ?? 0) - (a.lastUsed ?? 0)
    if (lastUsedDiff !== 0) return lastUsedDiff
    return (b.timestamp ?? 0) - (a.timestamp ?? 0)
  })

  const keeper = sorted[0]
  const totals = cluster.reduce(
    (acc, record) => {
      acc.success += record.successCount ?? 0
      acc.failure += record.failureCount ?? 0
      acc.retrieval += record.retrievalCount ?? 0
      acc.usage += record.usageCount ?? 0
      acc.lastUsed = Math.max(acc.lastUsed, record.lastUsed ?? 0)
      return acc
    },
    { success: 0, failure: 0, retrieval: 0, usage: 0, lastUsed: 0 }
  )

  const updates: Partial<MemoryRecord> = {
    successCount: totals.success,
    failureCount: totals.failure,
    retrievalCount: totals.retrieval,
    usageCount: totals.usage
  }
  if (totals.lastUsed > 0) {
    updates.lastUsed = totals.lastUsed
  }

  await updateRecord(keeper.id, updates, config)

  const deprecatedIds: string[] = []
  for (const record of cluster) {
    if (record.id === keeper.id) continue
    await markDeprecated(record.id, config)
    deprecatedIds.push(record.id)
  }

  return {
    keptId: keeper.id,
    deprecatedIds,
    successCount: totals.success,
    failureCount: totals.failure,
    retrievalCount: totals.retrieval,
    usageCount: totals.usage,
    lastUsed: totals.lastUsed
  }
}

/**
 * Find contradiction pairs: semantically similar records of same type/project
 * but with different content (newer likely supersedes older).
 *
 * Unlike consolidation which finds near-duplicates (high text similarity),
 * this finds records that cover the same topic but say different things.
 */
export async function findContradictionPairs(
  config: Config = DEFAULT_CONFIG
): Promise<ContradictionPair[]> {
  const pairs: ContradictionPair[] = []
  const processedIds = new Set<string>()
  let offset = 0

  while (true) {
    const batch = await queryRecords(
      {
        filter: 'deprecated == false',
        limit: QUERY_PAGE_SIZE,
        offset,
        includeEmbeddings: true
      },
      config
    )

    if (batch.length === 0) break

    for (const record of batch) {
      if (processedIds.has(record.id)) continue
      if (!isValidEmbedding(record.embedding)) continue

      const recordText = normalizeExactText(buildExactText(record))
      if (!recordText) continue

      // Find semantically similar records of same type/project
      const matches = await vectorSearchSimilar(
        record.embedding,
        {
          filter: buildContradictionFilter(record),
          limit: CONTRADICTION_SEARCH_LIMIT,
          similarityThreshold: CONTRADICTION_SIMILARITY_THRESHOLD
        },
        config
      )

      for (const match of matches) {
        const candidate = match.record
        if (processedIds.has(candidate.id)) continue
        if (candidate.deprecated) continue

        const candidateText = normalizeExactText(buildExactText(candidate))
        if (!candidateText) continue

        // Skip if texts are too similar (that's consolidation territory)
        if (isExactTextSimilar(recordText, candidateText)) continue

        // Determine which is newer
        const recordTime = record.timestamp ?? 0
        const candidateTime = candidate.timestamp ?? 0

        if (recordTime > candidateTime) {
          pairs.push({ newer: record, older: candidate, similarity: match.similarity })
        } else if (candidateTime > recordTime) {
          pairs.push({ newer: candidate, older: record, similarity: match.similarity })
        }
        // If same timestamp, skip (ambiguous)

        // Mark the older one as processed to avoid duplicate pairs
        const olderId = recordTime > candidateTime ? candidate.id : record.id
        processedIds.add(olderId)
      }

      processedIds.add(record.id)
    }

    if (batch.length < QUERY_PAGE_SIZE) break
    offset += batch.length
  }

  return pairs
}

/**
 * Resolve a contradiction by deprecating the older record.
 * The newer record is assumed to supersede it.
 */
export async function resolveContradiction(
  pair: ContradictionPair,
  config: Config = DEFAULT_CONFIG
): Promise<boolean> {
  return markDeprecated(pair.older.id, config)
}

function buildContradictionFilter(record: MemoryRecord): string {
  const project = record.project ?? ''
  const domain = record.domain ?? ''
  return [
    'deprecated == false',
    `type == "${escapeFilterValue(record.type)}"`,
    `project == "${escapeFilterValue(project)}"`,
    `domain == "${escapeFilterValue(domain)}"`,
    `id != "${escapeFilterValue(record.id)}"`
  ].join(' && ')
}

async function fetchRecords(
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

function isValidEmbedding(embedding: number[] | undefined): embedding is number[] {
  return Array.isArray(embedding) && embedding.length === EMBEDDING_DIM
}

function isExactTextSimilar(seed: string, candidate: string): boolean {
  if (!seed || !candidate) return false
  if (seed === candidate) return true
  if (seed.includes(candidate) || candidate.includes(seed)) return true

  const maxLength = Math.max(seed.length, candidate.length)
  const threshold = Math.floor(maxLength * TEXT_SIMILARITY_RATIO)
  if (threshold === 0) return false
  if (Math.abs(seed.length - candidate.length) > threshold) return false

  return levenshteinDistance(seed, candidate, threshold) <= threshold
}

function buildConsolidationFilter(record: MemoryRecord): string {
  const project = record.project ?? ''
  const domain = record.domain ?? ''
  return [
    'deprecated == false',
    `type == "${escapeFilterValue(record.type)}"`,
    `project == "${escapeFilterValue(project)}"`,
    `domain == "${escapeFilterValue(domain)}"`,
    `id != "${escapeFilterValue(record.id)}"`
  ].join(' && ')
}

function isGlobalCandidate(record: MemoryRecord): boolean {
  switch (record.type) {
    case 'error':
      return isGlobalErrorCandidate(record)
    case 'command':
      return isGlobalCommandCandidate(record)
    case 'discovery':
      return isGlobalDiscoveryCandidate(record)
    default:
      return false
  }
}

function isGlobalErrorCandidate(record: Extract<MemoryRecord, { type: 'error' }>): boolean {
  const resolution = normalizeMatchText(record.resolution ?? '')
  const errorText = normalizeMatchText(record.errorText ?? '')
  const tool = normalizeMatchText(record.context.tool ?? '')
  if (resolution && matchesAnyRegex(resolution, GLOBAL_TOOL_REGEXES)) return true
  if (errorText && matchesAnyRegex(errorText, GLOBAL_TOOL_REGEXES)) return true
  if (tool && matchesAnyRegex(tool, GLOBAL_TOOL_REGEXES)) return true
  return false
}

function isGlobalCommandCandidate(record: Extract<MemoryRecord, { type: 'command' }>): boolean {
  const parsed = parseCommandLine(record.command)
  if (!parsed.executable) return false

  const executable = parsed.executable.toLowerCase()
  if (looksLikePath(executable) || executable.includes('\\')) return false
  if (!GLOBAL_COMMAND_TOOLS.has(executable)) return false

  const args = parsed.args
  if (args.some(isPathLikeToken)) return false
  if (isPackageManagerScript(executable, args)) return false

  const nonFlagArgs = args.filter(arg => !arg.startsWith('-'))
  if (hasGenericFlag(args)) return true
  if (nonFlagArgs.length <= 1) return true

  return false
}

function isGlobalDiscoveryCandidate(record: Extract<MemoryRecord, { type: 'discovery' }>): boolean {
  const combined = normalizeMatchText([record.what, record.where, record.evidence].filter(Boolean).join(' '))
  if (!combined) return false
  if (PATH_TEXT_REGEX.test(combined)) return false
  return matchesAnyRegex(combined, GLOBAL_DISCOVERY_REGEXES)
}

function normalizeMatchText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function matchesAnyRegex(value: string, regexes: RegExp[]): boolean {
  return regexes.some(regex => regex.test(value))
}

function buildKeywordRegex(keyword: string): RegExp {
  const escaped = escapeRegExp(keyword)
  return new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`, 'i')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function hasGenericFlag(args: string[]): boolean {
  for (const arg of args) {
    if (GENERIC_COMMAND_FLAGS.has(arg)) return true
    if (!arg.startsWith('-') && GENERIC_SUBCOMMANDS.has(arg)) return true
  }
  return false
}

function isPackageManagerScript(executable: string, args: string[]): boolean {
  if (!PACKAGE_MANAGER_TOOLS.has(executable)) return false
  const nonFlagArgs = args.filter(arg => !arg.startsWith('-'))
  return nonFlagArgs.some(arg => PACKAGE_MANAGER_SCRIPT_SUBCOMMANDS.has(arg))
}

function isPathLikeToken(token: string): boolean {
  const raw = stripQuotes(token)
  if (!raw) return false
  if (raw.startsWith('-') && !raw.includes('=')) return false

  const candidate = raw.includes('=') ? raw.split('=', 2)[1] : raw
  if (!candidate) return false

  if (candidate.startsWith('./') || candidate.startsWith('../') || candidate.startsWith('~/')) return true
  if (candidate.includes('/') || candidate.includes('\\')) return true
  if (FILE_EXTENSION_REGEX.test(candidate)) return true
  return false
}

function levenshteinDistance(a: string, b: string, maxDistance?: number): number {
  if (a === b) return 0
  const aLength = a.length
  const bLength = b.length

  if (aLength === 0) return bLength
  if (bLength === 0) return aLength
  if (maxDistance !== undefined && Math.abs(aLength - bLength) > maxDistance) {
    return maxDistance + 1
  }

  let prev = new Array<number>(bLength + 1)
  let curr = new Array<number>(bLength + 1)

  for (let j = 0; j <= bLength; j += 1) {
    prev[j] = j
  }

  for (let i = 1; i <= aLength; i += 1) {
    curr[0] = i
    let rowMin = curr[0]
    const aChar = a.charCodeAt(i - 1)

    for (let j = 1; j <= bLength; j += 1) {
      const cost = aChar === b.charCodeAt(j - 1) ? 0 : 1
      const deletion = prev[j] + 1
      const insertion = curr[j - 1] + 1
      const substitution = prev[j - 1] + cost
      const value = Math.min(deletion, insertion, substitution)
      curr[j] = value
      if (value < rowMin) rowMin = value
    }

    if (maxDistance !== undefined && rowMin > maxDistance) {
      return maxDistance + 1
    }

    const swap = prev
    prev = curr
    curr = swap
  }

  return prev[bLength]
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
