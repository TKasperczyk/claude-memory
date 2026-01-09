/**
 * Dashboard API server - queries Milvus and serves data to frontend.
 * Run with: pnpm run server
 */

import express, { type Response } from 'express'
import cors from 'cors'
import fs from 'fs'
import path from 'path'
import { homedir } from 'os'
import {
  initMilvus,
  queryRecords,
  iterateRecords,
  hybridSearch,
  getRecord,
  deleteRecord,
  resetCollection,
  countRecords,
  escapeFilterValue,
  getRecordStats
} from '../../src/lib/milvus.js'
import { dedupeInjectedMemories, listAllSessions, loadSessionTracking } from '../../src/lib/session-tracking.js'
import { findGitRoot } from '../../src/lib/context.js'
import { handlePrePrompt } from '../../src/hooks/pre-prompt.js'
import { loadConfig } from '../../src/lib/config.js'
import {
  coerceRetrievalSettings,
  getDefaultMaintenanceSettings,
  getDefaultSettings,
  loadSettings,
  resetSettings,
  saveSettings,
  type Settings
} from '../../src/lib/settings.js'
import { type MemoryRecord, type RecordType } from '../../src/lib/types.js'
import { getExtractionRun, listExtractionRuns } from '../../src/lib/extraction-log.js'
import { reviewExtraction } from '../../src/lib/extraction-review.js'
import { reviewInjection } from '../../src/lib/injection-review.js'
import { getInjectionReview, getReview, saveInjectionReview, saveReview } from '../../src/lib/review-storage.js'
import {
  MAINTENANCE_OPERATIONS,
  MAINTENANCE_OPERATION_DEFINITIONS,
  runAllMaintenance,
  runMaintenanceOperation,
  type MaintenanceOperation
} from '../../src/lib/maintenance-api.js'

const app = express()
const PORT = process.env.PORT ?? 3001
const CONFIG_ROOT = findGitRoot(process.cwd()) ?? process.cwd()
const CONFIG = loadConfig(CONFIG_ROOT)
const MEMORY_TYPES: RecordType[] = ['command', 'error', 'discovery', 'procedure']
const SUGGESTION_ALLOWED_ROOTS = [
  path.resolve(CONFIG_ROOT),
  path.resolve(homedir(), '.claude', 'skills')
]
const CLAUDE_SETTINGS_PATH = path.join(homedir(), '.claude', 'settings.json')
const CLAUDE_HOOK_TIMEOUT_SECONDS = 5
const HOOKS_ROOT = path.resolve(CONFIG_ROOT, 'dist', 'hooks')
const CLAUDE_HOOKS = {
  UserPromptSubmit: {
    script: 'pre-prompt.js',
    command: `node "${path.join(HOOKS_ROOT, 'pre-prompt.js')}"`
  },
  SessionEnd: {
    script: 'post-session.js',
    command: `node "${path.join(HOOKS_ROOT, 'post-session.js')}"`
  },
  PreCompact: {
    script: 'post-session.js',
    command: `node "${path.join(HOOKS_ROOT, 'post-session.js')}"`
  }
} as const

app.use(cors({ origin: ['http://localhost:5173', 'http://127.0.0.1:5173'] }))
app.use(express.json())

app.get('/api/memory-types', (_req, res) => {
  res.json({ types: MEMORY_TYPES })
})

app.get('/api/settings', (_req, res) => {
  try {
    res.json(loadSettings())
  } catch (error) {
    console.error('Settings error:', error)
    res.status(500).json({ error: 'Failed to load settings' })
  }
})

app.get('/api/settings/defaults', (_req, res) => {
  try {
    res.json({
      settings: getDefaultSettings(),
      maintenance: getDefaultMaintenanceSettings()
    })
  } catch (error) {
    console.error('Settings defaults error:', error)
    res.status(500).json({ error: 'Failed to load default settings' })
  }
})

app.put('/api/settings', (req, res) => {
  try {
    if (!isPlainObject(req.body)) {
      return res.status(400).json({ error: 'Settings payload must be an object' })
    }
    saveSettings(req.body as Partial<Settings>)
    res.json(loadSettings())
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update settings'
    console.error('Settings update error:', error)
    res.status(500).send(message)
  }
})

app.post('/api/settings/reset', (_req, res) => {
  try {
    resetSettings()
    res.json(getDefaultSettings())
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to reset settings'
    console.error('Settings reset error:', error)
    res.status(500).send(message)
  }
})

app.get('/api/hooks/status', (_req, res) => {
  try {
    const settings = readClaudeSettingsFile(CLAUDE_SETTINGS_PATH)
    res.json({ hooks: buildHookStatus(settings) })
  } catch (error) {
    handleClaudeSettingsError(res, error, 'Failed to load hook status')
  }
})

app.post('/api/hooks/install', (_req, res) => {
  try {
    const settings = (readClaudeSettingsFile(CLAUDE_SETTINGS_PATH) ?? {}) as Record<string, unknown>
    const hooksConfig = isPlainObject(settings.hooks)
      ? settings.hooks as Record<string, unknown>
      : {}
    settings.hooks = hooksConfig

    const entries = Object.entries(CLAUDE_HOOKS) as [ClaudeHookEvent, ClaudeHookDefinition][]
    for (const [eventName, hook] of entries) {
      hooksConfig[eventName] = ensureHookInstalled(hooksConfig[eventName], hook)
    }

    fs.mkdirSync(path.dirname(CLAUDE_SETTINGS_PATH), { recursive: true })
    fs.writeFileSync(CLAUDE_SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8')

    res.json({ success: true, hooks: buildHookStatus(settings) })
  } catch (error) {
    handleClaudeSettingsError(res, error, 'Failed to install hooks')
  }
})

app.post('/api/hooks/uninstall', (_req, res) => {
  try {
    const settings = readClaudeSettingsFile(CLAUDE_SETTINGS_PATH)
    if (!settings) {
      res.json({ success: true, hooks: buildHookStatus(null) })
      return
    }
    if (!isPlainObject(settings.hooks)) {
      res.json({ success: true, hooks: buildHookStatus(settings) })
      return
    }
    const hooksConfig = settings.hooks as Record<string, unknown>

    const entries = Object.entries(CLAUDE_HOOKS) as [ClaudeHookEvent, ClaudeHookDefinition][]
    for (const [eventName, hookDefinition] of entries) {
      if (!Object.prototype.hasOwnProperty.call(hooksConfig, eventName)) continue
      hooksConfig[eventName] = removeHookEntries(hooksConfig[eventName], hookDefinition)
    }

    fs.mkdirSync(path.dirname(CLAUDE_SETTINGS_PATH), { recursive: true })
    fs.writeFileSync(CLAUDE_SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8')

    res.json({ success: true, hooks: buildHookStatus(settings) })
  } catch (error) {
    handleClaudeSettingsError(res, error, 'Failed to uninstall hooks')
  }
})

// Initialize Milvus on startup
let initialized = false

async function ensureInitialized(): Promise<void> {
  if (!initialized) {
    await initMilvus(CONFIG)
    initialized = true
  }
}

function parseNonNegativeInt(value: unknown, fallback: number): number {
  const raw = Array.isArray(value) ? value[0] : value
  if (raw === undefined || raw === null) return fallback
  const parsed = typeof raw === 'string' && raw.trim() === '' ? Number.NaN : Number(raw)
  if (!Number.isInteger(parsed) || parsed < 0) return fallback
  return parsed
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function escapeLikeValue(value: string): string {
  const escapedWildcards = value.replace(/[%_]/g, '\\$&')
  return escapeFilterValue(escapedWildcards)
}

function buildSearchFilter(filters: { type?: RecordType; project?: string; deprecated?: boolean }): string | undefined {
  const parts: string[] = []
  if (filters.type) parts.push(`type == "${escapeFilterValue(filters.type)}"`)
  if (filters.project) parts.push(`project == "${escapeFilterValue(filters.project)}"`)
  if (!filters.deprecated) parts.push('deprecated == false')
  return parts.length > 0 ? parts.join(' && ') : undefined
}

function buildKeywordFilter(query: string, baseFilter?: string): string {
  const escaped = escapeLikeValue(query)
  const likeClause = `exact_text like "%${escaped}%"`
  return baseFilter ? `${baseFilter} && ${likeClause}` : likeClause
}

type ClaudeHookEvent = keyof typeof CLAUDE_HOOKS
type ClaudeHookStatus = {
  installed: boolean
  configured: string | null
  expected: string
}
type ClaudeHookDefinition = {
  script: string
  command: string
}

class ClaudeSettingsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ClaudeSettingsError'
  }
}

function normalizeHookCommand(value: string): string {
  return value.replace(/\\/g, '/')
}

function matchesClaudeHook(command: string, gitRoot: string, scriptName: string): boolean {
  const normalizedCommand = normalizeHookCommand(command)
  const resolvedGitRoot = path.resolve(gitRoot)
  const normalizedGitRoot = normalizeHookCommand(resolvedGitRoot)
  if (!normalizedCommand.includes(normalizedGitRoot)) return false
  const scriptPath = normalizeHookCommand(path.join(resolvedGitRoot, 'dist', 'hooks', scriptName))
  return normalizedCommand.includes(scriptPath)
}

function collectHookCommands(eventConfig: unknown): string[] {
  if (!Array.isArray(eventConfig)) return []
  const commands: string[] = []
  for (const entry of eventConfig) {
    if (!isPlainObject(entry)) continue
    const hooks = entry.hooks
    if (!Array.isArray(hooks)) continue
    for (const hook of hooks) {
      if (!isPlainObject(hook)) continue
      if (typeof hook.command === 'string') {
        commands.push(hook.command)
      }
    }
  }
  return commands
}

function buildHookStatus(settings: Record<string, unknown> | null): Record<ClaudeHookEvent, ClaudeHookStatus> {
  const hooksConfig = settings && isPlainObject(settings.hooks)
    ? settings.hooks as Record<string, unknown>
    : {}
  const status = {} as Record<ClaudeHookEvent, ClaudeHookStatus>
  const entries = Object.entries(CLAUDE_HOOKS) as [ClaudeHookEvent, ClaudeHookDefinition][]
  for (const [eventName, hook] of entries) {
    const commands = collectHookCommands(hooksConfig[eventName])
    const configured = commands.find(command => matchesClaudeHook(command, CONFIG_ROOT, hook.script)) ?? null
    status[eventName] = {
      installed: Boolean(configured),
      configured,
      expected: hook.command
    }
  }
  return status
}

function readClaudeSettingsFile(settingsPath: string): Record<string, unknown> | null {
  let raw: string
  try {
    raw = fs.readFileSync(settingsPath, 'utf-8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    throw error
  }

  let parsed: unknown
  const trimmed = raw.trim()
  if (!trimmed) return {}

  try {
    parsed = JSON.parse(trimmed)
  } catch {
    throw new ClaudeSettingsError('settings.json is not valid JSON')
  }

  if (!isPlainObject(parsed)) {
    throw new ClaudeSettingsError('settings.json must be a JSON object')
  }

  return parsed
}

function ensureHookInstalled(eventConfig: unknown, hook: ClaudeHookDefinition): unknown[] {
  const entries = Array.isArray(eventConfig) ? eventConfig.slice() : []
  let found = false

  for (const entry of entries) {
    if (!isPlainObject(entry)) continue
    const hooks = Array.isArray(entry.hooks) ? entry.hooks : null
    if (!hooks) continue
    for (const item of hooks) {
      if (!isPlainObject(item)) continue
      const command = typeof item.command === 'string' ? item.command : ''
      if (command && matchesClaudeHook(command, CONFIG_ROOT, hook.script)) {
        item.type = 'command'
        item.command = hook.command
        item.timeout = CLAUDE_HOOK_TIMEOUT_SECONDS
        found = true
      }
    }
  }

  if (!found) {
    entries.push({
      hooks: [
        {
          type: 'command',
          command: hook.command,
          timeout: CLAUDE_HOOK_TIMEOUT_SECONDS
        }
      ]
    })
  }

  return entries
}

function removeHookEntries(eventConfig: unknown, hook: ClaudeHookDefinition): unknown {
  if (!Array.isArray(eventConfig)) return eventConfig
  const entries: unknown[] = []

  for (const entry of eventConfig) {
    if (!isPlainObject(entry)) {
      entries.push(entry)
      continue
    }
    const hooks = Array.isArray(entry.hooks) ? entry.hooks : null
    if (!hooks) {
      entries.push(entry)
      continue
    }
    const retainedHooks = hooks.filter(item => {
      if (!isPlainObject(item)) return true
      const command = typeof item.command === 'string' ? item.command : ''
      if (!command) return true
      return !matchesClaudeHook(command, CONFIG_ROOT, hook.script)
    })
    if (retainedHooks.length === hooks.length) {
      entries.push(entry)
      continue
    }
    if (retainedHooks.length > 0) {
      entries.push({ ...entry, hooks: retainedHooks })
      continue
    }
    const hasMetadata = Object.keys(entry).some(key => key !== 'hooks')
    if (hasMetadata) {
      entries.push({ ...entry, hooks: [] })
    }
  }

  return entries
}

function handleClaudeSettingsError(res: Response, error: unknown, fallbackMessage: string): void {
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'EACCES' || code === 'EPERM') {
    res.status(403).json({ error: 'Permission denied' })
    return
  }
  if (error instanceof ClaudeSettingsError) {
    res.status(500).json({ error: error.message })
    return
  }
  console.error('Claude settings error:', error)
  const message = error instanceof Error ? error.message : fallbackMessage
  res.status(500).json({ error: message || fallbackMessage })
}

type SuggestionApplyAction = 'new' | 'edit'

class SuggestionTargetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SuggestionTargetError'
  }
}

function hasPathTraversal(targetFile: string): boolean {
  const normalized = targetFile.replace(/\\/g, '/')
  return normalized.split('/').some(segment => segment === '..')
}

function normalizeTildePath(targetFile: string): string {
  if (targetFile === '~') return homedir()
  if (targetFile.startsWith('~/')) return path.join(homedir(), targetFile.slice(2))
  return targetFile
}

function isPathWithin(targetPath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, targetPath)
  return !relative.startsWith('..') && !path.isAbsolute(relative)
}

function findExistingParent(targetPath: string): string {
  let current = path.resolve(targetPath)
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current)
    if (parent === current) return current
    current = parent
  }
  return current
}

function resolveRealPath(targetPath: string): string {
  const resolved = path.resolve(targetPath)
  if (fs.existsSync(resolved)) {
    return fs.realpathSync(resolved)
  }
  const existingParent = findExistingParent(resolved)
  const realParent = fs.realpathSync(existingParent)
  const relative = path.relative(existingParent, resolved)
  return path.join(realParent, relative)
}

function resolveSuggestionTarget(targetFile: string): string {
  const trimmed = targetFile.trim()
  if (!trimmed) return trimmed
  if (hasPathTraversal(trimmed)) {
    throw new SuggestionTargetError('Invalid targetFile path')
  }

  const expanded = normalizeTildePath(trimmed)
  const resolved = path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(CONFIG_ROOT, expanded)
  const allowedRoot = SUGGESTION_ALLOWED_ROOTS.find(root => isPathWithin(resolved, root))
  if (!allowedRoot) {
    throw new SuggestionTargetError('Target file must be within project root or ~/.claude/skills')
  }

  const realAllowedRoot = resolveRealPath(allowedRoot)
  const realTarget = resolveRealPath(resolved)
  if (!isPathWithin(realTarget, realAllowedRoot)) {
    throw new SuggestionTargetError('Invalid targetFile path')
  }

  return resolved
}

function normalizeDiffPathValue(targetFile: string): string {
  const trimmed = targetFile.trim()
  if (!trimmed) return ''
  if (trimmed === '/dev/null') return trimmed
  let unquoted = trimmed
  if (
    (unquoted.startsWith('"') && unquoted.endsWith('"')) ||
    (unquoted.startsWith("'") && unquoted.endsWith("'"))
  ) {
    unquoted = unquoted.slice(1, -1)
  }
  const withoutPrefix = unquoted.replace(/^([ab])\//, '').replace(/^\.\/+/, '')
  return withoutPrefix.replace(/\\/g, '/')
}

function parseUnifiedDiff(
  diff: string
): {
  oldPath: string
  newPath: string
  addedLines: string[]
  hasHunk: boolean
  hasDeletion: boolean
  isSingleFile: boolean
} {
  const lines = diff.replace(/\r\n/g, '\n').split('\n')
  const addedLines: string[] = []
  const oldPaths: string[] = []
  const newPaths: string[] = []
  let inHunk = false
  let hasHunk = false
  let hasDeletion = false

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      inHunk = false
      continue
    }
    if (!inHunk && line.startsWith('--- ')) {
      oldPaths.push(line.slice(4))
      inHunk = false
      continue
    }
    if (!inHunk && line.startsWith('+++ ')) {
      newPaths.push(line.slice(4))
      inHunk = false
      continue
    }
    if (line.startsWith('@@')) {
      inHunk = true
      hasHunk = true
      continue
    }
    if (!inHunk) continue
    if (line.startsWith('\\ No newline at end of file')) continue
    if (line.startsWith('+')) {
      addedLines.push(line.slice(1))
      continue
    }
    if (line.startsWith('-')) {
      hasDeletion = true
      continue
    }
  }

  return {
    oldPath: oldPaths[0] ?? '',
    newPath: newPaths[0] ?? '',
    addedLines,
    hasHunk,
    hasDeletion,
    isSingleFile: oldPaths.length === 1 && newPaths.length === 1
  }
}

function buildDiffContent(addedLines: string[]): string {
  if (addedLines.length === 0) return ''
  const content = addedLines.join('\n')
  return addedLines[addedLines.length - 1] === '' ? content : `${content}\n`
}

function appendToExistingFile(targetPath: string, content: string): void {
  const fd = fs.openSync(targetPath, 'r+')
  try {
    const { size } = fs.fstatSync(fd)
    fs.writeSync(fd, content, size, 'utf-8')
  } finally {
    fs.closeSync(fd)
  }
}

// Get aggregate stats
app.get('/api/stats', async (_req, res) => {
  try {
    await ensureInitialized()
    const total = await countRecords({}, CONFIG)
    const stats = {
      total,
      byType: {} as Record<string, number>,
      byProject: {} as Record<string, number>,
      byDomain: {} as Record<string, number>,
      avgRetrievalCount: 0,
      avgUsageCount: 0,
      avgUsageRatio: 0,
      deprecated: 0
    }

    let totalRetrieval = 0
    let totalUsage = 0
    let recordsWithRetrieval = 0

    for await (const record of iterateRecords({}, CONFIG)) {
      // By type
      stats.byType[record.type] = (stats.byType[record.type] ?? 0) + 1

      // By project
      const project = record.project ?? 'unknown'
      stats.byProject[project] = (stats.byProject[project] ?? 0) + 1

      // By domain
      const domain = record.domain ?? 'unknown'
      stats.byDomain[domain] = (stats.byDomain[domain] ?? 0) + 1

      // Deprecated
      if (record.deprecated) stats.deprecated++

      // Usage stats
      const retrieval = record.retrievalCount ?? 0
      const usage = record.usageCount ?? 0
      if (retrieval > 0) {
        recordsWithRetrieval++
        totalRetrieval += retrieval
        totalUsage += usage
      }
    }

    if (recordsWithRetrieval > 0) {
      stats.avgRetrievalCount = totalRetrieval / recordsWithRetrieval
      stats.avgUsageCount = totalUsage / recordsWithRetrieval
      stats.avgUsageRatio = totalUsage / totalRetrieval
    }

    res.json(stats)
  } catch (error) {
    console.error('Stats error:', error)
    res.status(500).json({ error: 'Failed to get stats' })
  }
})

// List memories with filtering
app.get('/api/memories', async (req, res) => {
  try {
    await ensureInitialized()

    const limit = Math.min(parseNonNegativeInt(req.query.limit, 100), 1000)
    const offset = parseNonNegativeInt(req.query.offset, 0)
    const type = req.query.type as RecordType | undefined
    const project = req.query.project as string | undefined
    const deprecated = req.query.deprecated === 'true'

    const filterParts: string[] = []
    if (type) filterParts.push(`type == "${escapeFilterValue(type)}"`)
    if (project) filterParts.push(`project == "${escapeFilterValue(project)}"`)
    if (!deprecated) filterParts.push('deprecated == false')

    const filter = filterParts.length > 0 ? filterParts.join(' && ') : undefined

    const [records, total] = await Promise.all([
      queryRecords({ filter, limit, offset, orderBy: 'timestamp_desc' }, CONFIG),
      countRecords({ filter }, CONFIG)
    ])

    res.json({
      records,
      count: records.length,
      total,
      offset,
      limit
    })
  } catch (error) {
    console.error('List memories error:', error)
    res.status(500).json({ error: 'Failed to list memories' })
  }
})

// Get single memory by ID
app.get('/api/memories/:id', async (req, res) => {
  try {
    await ensureInitialized()
    const record = await getRecord(req.params.id, CONFIG)
    if (!record) {
      return res.status(404).json({ error: 'Memory not found' })
    }
    res.json(record)
  } catch (error) {
    console.error('Get memory error:', error)
    res.status(500).json({ error: 'Failed to get memory' })
  }
})

// Delete memory by ID
app.delete('/api/memories/:id', async (req, res) => {
  try {
    await ensureInitialized()
    const record = await getRecord(req.params.id, CONFIG)
    if (!record) {
      return res.status(404).json({ error: 'Memory not found' })
    }
    await deleteRecord(req.params.id, CONFIG)
    res.json({ success: true })
  } catch (error) {
    console.error('Delete memory error:', error)
    res.status(500).json({ error: 'Failed to delete memory' })
  }
})

// Reset Milvus collection (drop + recreate)
app.post('/api/reset-collection', async (_req, res) => {
  try {
    await ensureInitialized()
    await resetCollection(CONFIG)
    res.json({ success: true })
  } catch (error) {
    console.error('Reset collection error:', error)
    res.status(500).json({ error: 'Failed to reset collection' })
  }
})

// Preview context injection for a prompt (uses same logic as pre-prompt hook)
app.post('/api/preview', async (req, res) => {
  try {
    const { prompt, cwd = '/tmp', settings: rawSettingsOverride } = req.body
    if (!prompt) {
      return res.status(400).json({ error: 'Prompt required' })
    }

    const settingsOverride = isPlainObject(rawSettingsOverride)
      ? coerceRetrievalSettings(rawSettingsOverride as Record<string, unknown>, loadSettings())
      : undefined

    // Use the same handlePrePrompt function as the actual hook
    const result = await handlePrePrompt({
      hook_event_name: 'UserPromptSubmit',
      prompt,
      cwd,
      session_id: 'preview'
    }, CONFIG, { settingsOverride })

    res.json({
      signals: result.signals,
      results: result.results.map(r => ({
        record: r.record,
        score: r.score,
        similarity: r.similarity,
        keywordMatch: r.keywordMatch
      })),
      injectedRecords: result.injectedRecords,
      context: result.context ?? null,
      timedOut: result.timedOut
    })
  } catch (error) {
    console.error('Preview error:', error)
    res.status(500).json({ error: 'Failed to preview context' })
  }
})

// Search memories
app.get('/api/search', async (req, res) => {
  try {
    await ensureInitialized()

    const rawQuery = req.query.q as string
    const query = rawQuery?.trim()
    if (!query) {
      return res.status(400).json({ error: 'Query required' })
    }

    const limit = Math.min(parseNonNegativeInt(req.query.limit, 20), 200)
    const offset = parseNonNegativeInt(req.query.offset, 0)
    const type = req.query.type as RecordType | undefined
    const project = req.query.project as string | undefined
    const deprecated = req.query.deprecated === 'true'

    const baseFilter = buildSearchFilter({ type, project, deprecated })
    const keywordFilter = buildKeywordFilter(query, baseFilter)
    const windowLimit = offset + limit

    const [total, results] = await Promise.all([
      countRecords({ filter: keywordFilter }, CONFIG),
      hybridSearch({
        query,
        limit: windowLimit,
        type,
        project,
        excludeDeprecated: !deprecated
      }, CONFIG)
    ])

    const page = results.slice(offset, offset + limit)
    // total is keyword match count; results may include semantic-only matches
    // hasMore indicates if there are more results beyond this page
    const hasMore = results.length > offset + limit || total > offset + limit

    res.json({
      query,
      total: Math.max(total, results.length),
      offset,
      hasMore,
      results: page.map(r => ({
        record: r.record,
        score: r.score,
        similarity: r.similarity,
        keywordMatch: r.keywordMatch
      }))
    })
  } catch (error) {
    console.error('Search error:', error)
    res.status(500).json({ error: 'Failed to search' })
  }
})

// List active sessions with their injected memories and stats
app.get('/api/sessions', async (_req, res) => {
  try {
    await ensureInitialized()
    const sessions = listAllSessions().map(session => ({
      ...session,
      memories: dedupeInjectedMemories(session.memories)
    }))

    // Collect all memory IDs to fetch stats
    const allIds = sessions.flatMap(s => s.memories.map(m => m.id))
    const statsMap = await getRecordStats(allIds)

    // Enrich memories with stats
    const enrichedSessions = sessions.map(session => ({
      ...session,
      memories: session.memories.map(memory => ({
        ...memory,
        stats: statsMap.get(memory.id) ?? null
      }))
    }))

    res.json({
      sessions: enrichedSessions,
      count: sessions.length
    })
  } catch (error) {
    console.error('Sessions error:', error)
    res.status(500).json({ error: 'Failed to list sessions' })
  }
})

// Get cached injection review if available
app.get('/api/sessions/:sessionId/review', (req, res) => {
  try {
    const review = getInjectionReview(req.params.sessionId)
    if (!review) {
      return res.status(404).json({ error: 'Review not found' })
    }
    res.json(review)
  } catch (error) {
    console.error('Injection review error:', error)
    res.status(500).json({ error: 'Failed to get injection review' })
  }
})

// Trigger Opus review for a session injection
app.post('/api/sessions/:sessionId/review', async (req, res) => {
  try {
    const sessionId = req.params.sessionId
    const session = loadSessionTracking(sessionId)
    if (!session) {
      return res.status(404).json({ error: 'Session not found' })
    }

    await ensureInitialized()
    const review = await reviewInjection(sessionId, CONFIG)
    saveInjectionReview(review)
    res.json(review)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('Injection review error:', error)
    res.status(500).json({ error: message || 'Failed to run injection review' })
  }
})

// List extraction runs with pagination
app.get('/api/extractions', (req, res) => {
  try {
    const runs = listExtractionRuns()
    const limit = Math.min(parseNonNegativeInt(req.query.limit, 50), 500)
    const offset = parseNonNegativeInt(req.query.offset, 0)
    const page = runs.slice(offset, offset + limit)

    res.json({
      runs: page,
      count: page.length,
      total: runs.length,
      offset,
      limit
    })
  } catch (error) {
    console.error('Extractions error:', error)
    res.status(500).json({ error: 'Failed to list extractions' })
  }
})

// Get single extraction run with associated records
app.get('/api/extractions/:runId', async (req, res) => {
  try {
    const run = getExtractionRun(req.params.runId)
    if (!run) {
      return res.status(404).json({ error: 'Extraction run not found' })
    }

    const ids = run.extractedRecordIds ?? []
    if (ids.length === 0) {
      return res.json({ run, records: [] })
    }

    await ensureInitialized()

    const records: MemoryRecord[] = []
    const batchSize = 1000

    for (let i = 0; i < ids.length; i += batchSize) {
      const batchIds = ids.slice(i, i + batchSize)
      const idFilter = batchIds.map(id => `"${escapeFilterValue(id)}"`).join(', ')
      const batch = await queryRecords({
        filter: `id in [${idFilter}]`,
        limit: batchIds.length,
        orderBy: 'timestamp_desc'
      }, CONFIG)
      records.push(...batch)
    }

    const byId = new Map(records.map(record => [record.id, record]))
    const ordered = ids.map(id => byId.get(id)).filter((record): record is typeof records[number] => Boolean(record))

    res.json({ run, records: ordered })
  } catch (error) {
    console.error('Extraction run error:', error)
    res.status(500).json({ error: 'Failed to get extraction run' })
  }
})

// Get cached extraction review if available
app.get('/api/extractions/:runId/review', (req, res) => {
  try {
    const review = getReview(req.params.runId)
    if (!review) {
      return res.status(404).json({ error: 'Review not found' })
    }
    res.json(review)
  } catch (error) {
    console.error('Extraction review error:', error)
    res.status(500).json({ error: 'Failed to get extraction review' })
  }
})

// Trigger Opus review for an extraction run
app.post('/api/extractions/:runId/review', async (req, res) => {
  try {
    const runId = req.params.runId
    const run = getExtractionRun(runId)
    if (!run) {
      return res.status(404).json({ error: 'Extraction run not found' })
    }

    await ensureInitialized()
    const review = await reviewExtraction(runId, CONFIG)
    saveReview(review)
    res.json(review)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('Extraction review error:', error)
    res.status(500).json({ error: message || 'Failed to run extraction review' })
  }
})

// List maintenance operations for the dashboard
app.get('/api/maintenance/operations', (_req, res) => {
  res.json({ operations: MAINTENANCE_OPERATION_DEFINITIONS })
})

// Apply a promotion suggestion diff
app.post('/api/maintenance/suggestions/apply', (req, res) => {
  try {
    if (!isPlainObject(req.body)) {
      return res.status(400).json({ error: 'Invalid payload' })
    }

    const { recordId, action, targetFile, diff, overwrite } = req.body
    if (typeof recordId !== 'string' || recordId.trim().length === 0) {
      return res.status(400).json({ error: 'recordId required' })
    }
    if (action !== 'new' && action !== 'edit') {
      return res.status(400).json({ error: 'Invalid action' })
    }
    if (typeof targetFile !== 'string' || targetFile.trim().length === 0) {
      return res.status(400).json({ error: 'targetFile required' })
    }
    if (typeof diff !== 'string' || diff.trim().length === 0) {
      return res.status(400).json({ error: 'diff required' })
    }

    const parsedDiff = parseUnifiedDiff(diff)
    if (!parsedDiff.isSingleFile) {
      return res.status(400).json({ error: 'Diff must target a single file' })
    }
    const normalizedTarget = normalizeDiffPathValue(targetFile)
    const normalizedDiffTarget = normalizeDiffPathValue(parsedDiff.newPath)
    if (!normalizedDiffTarget || normalizedDiffTarget !== normalizedTarget) {
      return res.status(400).json({ error: 'Diff target does not match targetFile' })
    }
    if (!parsedDiff.hasHunk || parsedDiff.addedLines.length === 0 || parsedDiff.hasDeletion) {
      return res.status(400).json({ error: 'Invalid diff format' })
    }
    const normalizedOldTarget = normalizeDiffPathValue(parsedDiff.oldPath)
    if (action === 'new' && normalizedOldTarget !== '/dev/null') {
      return res.status(400).json({ error: 'Diff does not represent a new file' })
    }
    if (action === 'edit' && normalizedOldTarget === '/dev/null') {
      return res.status(400).json({ error: 'Diff does not represent an edit' })
    }

    const content = buildDiffContent(parsedDiff.addedLines)
    if (!content) {
      return res.status(400).json({ error: 'Invalid diff format' })
    }

    const resolvedTarget = resolveSuggestionTarget(targetFile)
    const allowOverwrite = overwrite === true

    if (action === 'new') {
      if (fs.existsSync(resolvedTarget) && !allowOverwrite) {
        return res.status(409).json({ error: 'Target file already exists' })
      }
      fs.mkdirSync(path.dirname(resolvedTarget), { recursive: true })
      fs.writeFileSync(resolvedTarget, content, { encoding: 'utf-8', flag: allowOverwrite ? 'w' : 'wx' })
    } else {
      if (!fs.existsSync(resolvedTarget)) {
        return res.status(404).json({ error: 'Target file not found' })
      }
      appendToExistingFile(resolvedTarget, content)
    }

    res.json({
      success: true,
      recordId,
      action: action as SuggestionApplyAction,
      targetFile: resolvedTarget,
      addedLines: parsedDiff.addedLines.length
    })
  } catch (error) {
    if (error instanceof SuggestionTargetError) {
      return res.status(400).json({ error: error.message })
    }
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EACCES' || code === 'EPERM') {
      return res.status(403).json({ error: 'Permission denied' })
    }
    if (code === 'ENOENT') {
      return res.status(404).json({ error: 'Target file not found' })
    }
    if (code === 'EEXIST') {
      return res.status(409).json({ error: 'Target file already exists' })
    }
    console.error('Apply suggestion error:', error)
    res.status(500).json({ error: 'Failed to apply suggestion' })
  }
})

// Run a single maintenance operation
app.post('/api/maintenance/run', async (req, res) => {
  try {
    await ensureInitialized()
    const { operation, dryRun } = req.body ?? {}
    if (!operation || typeof operation !== 'string') {
      return res.status(400).json({ error: 'Operation required' })
    }

    if (!MAINTENANCE_OPERATIONS.includes(operation as MaintenanceOperation)) {
      return res.status(400).json({ error: 'Unknown operation' })
    }

    const result = await runMaintenanceOperation(
      operation as MaintenanceOperation,
      Boolean(dryRun),
      CONFIG
    )
    res.json(result)
  } catch (error) {
    console.error('Maintenance run error:', error)
    res.status(500).json({ error: 'Failed to run maintenance operation' })
  }
})

// Run all maintenance operations
app.post('/api/maintenance/run-all', async (req, res) => {
  try {
    await ensureInitialized()
    const { dryRun } = req.body ?? {}
    const results = await runAllMaintenance(Boolean(dryRun), CONFIG)
    res.json(results)
  } catch (error) {
    console.error('Maintenance run-all error:', error)
    res.status(500).json({ error: 'Failed to run maintenance operations' })
  }
})

// Stream all maintenance operations with progress updates (SSE)
app.get('/api/maintenance/stream', async (req, res) => {
  const dryRun = req.query.dryRun === 'true'

  // Set up SSE headers
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const sendEvent = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`)
    res.write(`data: ${JSON.stringify(data)}\n\n`)
  }

  try {
    await ensureInitialized()

    // Send start event with operation list
    sendEvent('start', {
      operations: MAINTENANCE_OPERATIONS,
      dryRun
    })

    // Run each operation and stream progress
    for (const operation of MAINTENANCE_OPERATIONS) {
      sendEvent('progress', { operation, status: 'running' })

      try {
        const effectiveDryRun = operation === 'promotion-suggestions' ? true : dryRun
        const result = await runMaintenanceOperation(operation, effectiveDryRun, CONFIG)
        sendEvent('result', result)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        sendEvent('error', { operation, error: message })
      }
    }

    sendEvent('complete', { success: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    sendEvent('error', { error: message })
  } finally {
    res.end()
  }
})

app.listen(PORT, () => {
  console.error(`Dashboard API server running on http://localhost:${PORT}`)
})
