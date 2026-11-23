import express from 'express'
import fs from 'fs/promises'
import path from 'path'
import { homedir } from 'os'
import { reviewMaintenanceResult, reviewMaintenanceResultStreaming } from '../../../src/lib/maintenance-review.js'
import {
  AUTO_MAINTENANCE_OPERATIONS,
  MAINTENANCE_OPERATIONS,
  MAINTENANCE_OPERATION_DEFINITIONS,
  compactTableSafely,
  runAllMaintenance,
  runMaintenanceOperation,
  type MaintenanceOperation
} from '../../../src/lib/maintenance-api.js'
import { acquireFileLock, type FileLockHandle } from '../../../src/lib/lock.js'
import { LOCKS_DIR } from '../../../src/lib/paths.js'
import {
  buildMaintenanceRun,
  deleteMaintenanceRun,
  getLastMaintenanceRun,
  getMaintenanceRun,
  listMaintenanceRuns,
  saveMaintenanceRun
} from '../../../src/lib/maintenance-log.js'
import { countRecords, deleteByFilter } from '../../../src/lib/lancedb.js'
import { getMaintenanceReview, saveMaintenanceReview } from '../../../src/lib/review-storage.js'
import type { ServerContext } from '../context.js'
import { createLogger } from '../lib/logger.js'
import { createSseStream, sendSseError } from '../lib/sse.js'
import {
  getRequestConfig,
  resolveBaseConfig,
  validateCollectionHeaderMiddleware
} from '../utils/config.js'
import { isPlainObject, parseNonNegativeInt } from '../utils/params.js'
import { ensureConfigInitialized } from '../utils/lancedb.js'

const logger = createLogger('maintenance')
const MAINTENANCE_LOCK_STALE_MS = 10 * 60 * 1000
const activeMaintenanceTables = new Set<string>()

type MaintenanceLockLease = {
  release: () => void
}

function acquireDashboardMaintenanceLock(table: string, dryRun: boolean): MaintenanceLockLease | null {
  if (dryRun) {
    return { release: () => {} }
  }
  if (activeMaintenanceTables.has(table)) {
    return null
  }
  let fileLock: FileLockHandle | null = null
  try {
    fileLock = acquireFileLock(path.join(LOCKS_DIR, 'auto-maintenance.lock'), {
      staleAfterMs: MAINTENANCE_LOCK_STALE_MS,
      staleStrategy: 'pid',
      ensureDir: true,
      proceedOnError: false,
      write: { data: () => `${process.pid}\n${Date.now()}` }
    })
  } catch (error) {
    logger.warn('Failed to acquire maintenance file lock; falling back to in-process lock', error)
    fileLock = { locked: false, release: () => {} }
  }
  if (!fileLock) {
    return null
  }

  activeMaintenanceTables.add(table)
  let released = false
  return {
    release: () => {
      if (released) return
      released = true
      activeMaintenanceTables.delete(table)
      fileLock?.release()
    }
  }
}

type SuggestionApplyAction = 'new' | 'edit'

class SuggestionTargetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SuggestionTargetError'
  }
}

class DiffApplyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DiffApplyError'
  }
}

export function createMaintenanceRouter(context: ServerContext): express.Router {
  const router = express.Router()
  router.use(validateCollectionHeaderMiddleware)
  const { configRoot, suggestionAllowedRoots } = context
  const getBaseConfig = () => resolveBaseConfig(context)

  router.get('/api/maintenance/runs', (req, res) => {
    try {
      const requestConfig = getRequestConfig(req, getBaseConfig())
      const runs = listMaintenanceRuns(requestConfig.lancedb.table)
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
      logger.error('Failed to list maintenance runs', error)
      res.status(500).json({ error: 'Failed to list maintenance runs' })
    }
  })

  router.get('/api/maintenance/runs/last', (req, res) => {
    try {
      const requestConfig = getRequestConfig(req, getBaseConfig())
      const run = getLastMaintenanceRun(requestConfig.lancedb.table)
      if (!run) {
        return res.status(404).json({ error: 'Maintenance run not found' })
      }
      res.json({ run })
    } catch (error) {
      logger.error('Failed to get last maintenance run', error)
      res.status(500).json({ error: 'Failed to get last maintenance run' })
    }
  })

  router.get('/api/maintenance/runs/:runId', (req, res) => {
    try {
      const requestConfig = getRequestConfig(req, getBaseConfig())
      const run = getMaintenanceRun(req.params.runId, requestConfig.lancedb.table)
      if (!run) {
        return res.status(404).json({ error: 'Maintenance run not found' })
      }
      res.json({ run })
    } catch (error) {
      logger.error('Failed to get maintenance run', error)
      res.status(500).json({ error: 'Failed to get maintenance run' })
    }
  })

  router.delete('/api/maintenance/runs/:runId', (req, res) => {
    try {
      const requestConfig = getRequestConfig(req, getBaseConfig())
      const deleted = deleteMaintenanceRun(req.params.runId, requestConfig.lancedb.table)
      if (!deleted) {
        return res.status(404).json({ error: 'Maintenance run not found' })
      }
      res.json({ success: true })
    } catch (error) {
      logger.error('Failed to delete maintenance run', error)
      res.status(500).json({ error: 'Failed to delete maintenance run' })
    }
  })

  router.get('/api/maintenance/:operation/review/:resultId', (req, res) => {
    try {
      const { operation, resultId } = req.params
      const requestConfig = getRequestConfig(req, getBaseConfig())
      const review = getMaintenanceReview(resultId, operation, requestConfig.lancedb.table)
      if (!review) {
        return res.status(404).json({ error: 'Review not found' })
      }
      res.json(review)
    } catch (error) {
      logger.error('Maintenance review error', error)
      res.status(500).json({ error: 'Failed to get maintenance review' })
    }
  })

  router.post('/api/maintenance/:operation/review', async (req, res) => {
    try {
      const { operation } = req.params
      const body = req.body

      if (!MAINTENANCE_OPERATIONS.includes(operation as MaintenanceOperation)) {
        return res.status(400).json({ error: 'Unknown operation' })
      }

      if (!body || !body.result) {
        return res.status(400).json({ error: 'Result required' })
      }

      const { result } = body

      if (!result || !result.operation) {
        return res.status(400).json({ error: 'Result required' })
      }

      if (result.operation !== operation) {
        return res.status(400).json({
          error: `Operation mismatch: URL says '${operation}' but result has '${result.operation}'`
        })
      }

      const normalizedResult = {
        ...result,
        actions: Array.isArray(result.actions) ? result.actions : [],
        candidates: Array.isArray(result.candidates) ? result.candidates : []
      }

      const wantsStream = req.query.stream === 'true'
      if (wantsStream) {
        const stream = createSseStream(res)

        try {
          const config = await ensureConfigInitialized(req, getBaseConfig())
          const review = await reviewMaintenanceResultStreaming(normalizedResult, config, stream.onThinking, stream.signal)
          saveMaintenanceReview(review, config.lancedb.table)
          stream.sendData({ result: review })
          stream.done()
        } catch (error) {
          if (stream.signal.aborted) return
          logger.error('Maintenance review error', error)
          sendSseError(stream, error, 'Failed to run maintenance review')
        } finally {
          stream.end()
        }
        return
      }

      const config = await ensureConfigInitialized(req, getBaseConfig())
      const review = await reviewMaintenanceResult(normalizedResult, config)
      saveMaintenanceReview(review, config.lancedb.table)
      res.json(review)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error('Maintenance review error', error)
      res.status(500).json({ error: message || 'Failed to run maintenance review' })
    }
  })

  router.get('/api/maintenance/operations', (_req, res) => {
    res.json({ operations: MAINTENANCE_OPERATION_DEFINITIONS })
  })

  router.post('/api/maintenance/suggestions/apply', async (req, res) => {
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
      if (!parsedDiff.hasHunk || !parsedDiff.hasChanges) {
        return res.status(400).json({ error: 'Invalid diff format' })
      }
      const normalizedOldTarget = normalizeDiffPathValue(parsedDiff.oldPath)
      if (action === 'new' && normalizedOldTarget !== '/dev/null') {
        return res.status(400).json({ error: 'Diff does not represent a new file' })
      }
      if (action === 'edit' && normalizedOldTarget === '/dev/null') {
        return res.status(400).json({ error: 'Diff does not represent an edit' })
      }
      const content = action === 'new' ? buildDiffContent(parsedDiff.addedLines) : null
      if (action === 'new' && !content) {
        return res.status(400).json({ error: 'Invalid diff format' })
      }

      const resolvedTarget = await resolveSuggestionTarget(targetFile, configRoot, suggestionAllowedRoots)
      const allowOverwrite = overwrite === true

      if (action === 'new') {
        if (await pathExists(resolvedTarget) && !allowOverwrite) {
          return res.status(409).json({ error: 'Target file already exists' })
        }
        await fs.mkdir(path.dirname(resolvedTarget), { recursive: true })
        await fs.writeFile(resolvedTarget, content!, { encoding: 'utf-8', flag: allowOverwrite ? 'w' : 'wx' })
      } else {
        if (!(await pathExists(resolvedTarget))) {
          return res.status(404).json({ error: 'Target file not found' })
        }
        const currentContent = await fs.readFile(resolvedTarget, 'utf-8')
        let updatedContent: string
        try {
          updatedContent = applyUnifiedDiffToContent(currentContent, parsedDiff)
        } catch (error) {
          if (error instanceof DiffApplyError) {
            return res.status(409).json({ error: error.message })
          }
          throw error
        }
        await fs.writeFile(resolvedTarget, updatedContent, { encoding: 'utf-8' })
      }

      res.json({
        success: true,
        recordId,
        action: action as SuggestionApplyAction,
        targetFile: resolvedTarget,
        addedLines: parsedDiff.addedLineCount
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
      logger.error('Failed to apply suggestion', error)
      res.status(500).json({ error: 'Failed to apply suggestion' })
    }
  })

  router.post('/api/maintenance/run', async (req, res) => {
    let lockLease: MaintenanceLockLease | null = null
    try {
      const config = await ensureConfigInitialized(req, getBaseConfig())
      const { operation, dryRun } = req.body ?? {}
      if (!operation || typeof operation !== 'string') {
        return res.status(400).json({ error: 'Operation required' })
      }

      if (!MAINTENANCE_OPERATIONS.includes(operation as MaintenanceOperation)) {
        return res.status(400).json({ error: 'Unknown operation' })
      }
      const definition = MAINTENANCE_OPERATION_DEFINITIONS.find(item => item.key === operation)
      if (!dryRun && definition?.allowExecute === false) {
        return res.status(403).json({ error: 'Operation is preview-only' })
      }

      lockLease = acquireDashboardMaintenanceLock(config.lancedb.table, Boolean(dryRun))
      if (!lockLease) {
        return res.status(409).json({ error: 'Maintenance is already running' })
      }

      const mode = dryRun ? 'preview' : 'run'
      logger.info(`Running ${operation} (${mode})`)

      const result = await runMaintenanceOperation(
        operation as MaintenanceOperation,
        Boolean(dryRun),
        config
      )
      const run = buildMaintenanceRun([result], {
        dryRun: Boolean(dryRun),
        trigger: 'dashboard',
        operations: [operation]
      })
      saveMaintenanceRun(run, config.lancedb.table)

      logger.info(`Completed ${operation}`, result.summary)
      res.json({ ...result, runId: run.runId })
    } catch (error) {
      logger.error('Failed to run maintenance operation', error)
      res.status(500).json({ error: 'Failed to run maintenance operation' })
    } finally {
      lockLease?.release()
    }
  })

  router.post('/api/maintenance/run-all', async (req, res) => {
    let lockLease: MaintenanceLockLease | null = null
    try {
      const config = await ensureConfigInitialized(req, getBaseConfig())
      const { dryRun } = req.body ?? {}
      lockLease = acquireDashboardMaintenanceLock(config.lancedb.table, Boolean(dryRun))
      if (!lockLease) {
        return res.status(409).json({ error: 'Maintenance is already running' })
      }
      const results = await runAllMaintenance(Boolean(dryRun), config)
      const run = buildMaintenanceRun(results, {
        dryRun: Boolean(dryRun),
        trigger: 'dashboard',
        operations: results.map(result => result.operation)
      })
      saveMaintenanceRun(run, config.lancedb.table)
      res.json(results.map(result => ({ ...result, runId: run.runId })))
    } catch (error) {
      logger.error('Failed to run all maintenance operations', error)
      res.status(500).json({ error: 'Failed to run maintenance operations' })
    } finally {
      lockLease?.release()
    }
  })

  router.post('/api/maintenance/purge-deprecated', async (req, res) => {
    try {
      const config = await ensureConfigInitialized(req, getBaseConfig())
      const deleted = await deleteByFilter('deprecated = true', config)
      logger.info(`Purged ${deleted} deprecated records`)
      res.json({ deleted })
    } catch (error) {
      logger.error('Failed to purge deprecated records', error)
      res.status(500).json({ error: 'Failed to purge deprecated records' })
    }
  })

  router.get('/api/maintenance/deprecated-count', async (req, res) => {
    try {
      const config = await ensureConfigInitialized(req, getBaseConfig())
      const count = await countRecords({ filter: 'deprecated = true' }, config)
      res.json({ count })
    } catch (error) {
      logger.error('Failed to count deprecated records', error)
      res.status(500).json({ error: 'Failed to count deprecated records' })
    }
  })

  router.get('/api/maintenance/stream', async (req, res) => {
    const dryRun = req.query.dryRun === 'true'
    const singleOperation = typeof req.query.operation === 'string' ? req.query.operation : null
    const operationsToRun = singleOperation
      ? MAINTENANCE_OPERATIONS.filter(op => op === singleOperation)
      : AUTO_MAINTENANCE_OPERATIONS

    if (singleOperation && !MAINTENANCE_OPERATIONS.includes(singleOperation as MaintenanceOperation)) {
      return res.status(400).json({ error: 'Unknown operation' })
    }
    if (singleOperation && !dryRun) {
      const definition = MAINTENANCE_OPERATION_DEFINITIONS.find(item => item.key === singleOperation)
      if (definition?.allowExecute === false) {
        return res.status(403).json({ error: 'Operation is preview-only' })
      }
    }

    const requestConfig = getRequestConfig(req, getBaseConfig())
    const lockLease = acquireDashboardMaintenanceLock(requestConfig.lancedb.table, dryRun)
    if (!lockLease) {
      return res.status(409).json({ error: 'Maintenance is already running' })
    }

    const stream = createSseStream(res, {
      onClose: () => {
        logger.info('Client disconnected from maintenance stream')
      }
    })

    const sendEvent = (event: string, data: unknown) => {
      stream.send(event, data)
    }

    try {
      const config = await ensureConfigInitialized(req, getBaseConfig())
      const streamedResults: Awaited<ReturnType<typeof runMaintenanceOperation>>[] = []

      sendEvent('start', {
        operations: operationsToRun,
        dryRun
      })

      for (const operation of operationsToRun) {
        if (stream.signal.aborted) break

        sendEvent('progress', { operation, status: 'running' })

        try {
          const definition = MAINTENANCE_OPERATION_DEFINITIONS.find(item => item.key === operation)
          if (!dryRun && definition?.allowExecute === false) {
            throw new Error('Operation is preview-only')
          }
          const effectiveDryRun = operation === 'promotion-suggestions' ? true : dryRun
          const result = await runMaintenanceOperation(
            operation,
            effectiveDryRun,
            config,
            undefined,
            (progress) => {
              // Emit detailed progress updates for consolidation operations
              if (!stream.signal.aborted && !res.writableEnded) {
                sendEvent('detailed-progress', {
                  operation,
                  current: progress.current,
                  total: progress.total,
                  message: progress.message
                })
              }
            }
          )
          streamedResults.push(result)
          sendEvent('result', result)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          sendEvent('error', { operation, error: message })
        }
      }

      if (!dryRun && !stream.signal.aborted && streamedResults.length > 0) {
        await compactTableSafely(config)
      }

      if (!stream.signal.aborted && streamedResults.length > 0) {
        const run = buildMaintenanceRun(streamedResults, {
          dryRun,
          trigger: 'dashboard',
          operations: streamedResults.map(result => result.operation)
        })
        saveMaintenanceRun(run, config.lancedb.table)
        sendEvent('complete', { success: true, runId: run.runId })
      } else {
        sendEvent('complete', { success: true })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sendEvent('error', { error: message })
    } finally {
      lockLease.release()
      if (!res.writableEnded) {
        stream.end()
      }
    }
  })

  return router
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

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}

const MAX_SYMLINK_DEPTH = 40

async function lstatSafe(targetPath: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | null> {
  try {
    return await fs.lstat(targetPath)
  } catch {
    return null
  }
}

async function resolveRealPath(targetPath: string, depth: number = 0): Promise<string> {
  if (depth > MAX_SYMLINK_DEPTH) {
    throw new SuggestionTargetError('Invalid targetFile path')
  }
  const resolved = path.resolve(targetPath)
  try {
    return await fs.realpath(resolved)
  } catch {
    // Either the path does not exist yet OR it (or an ancestor) is a dangling symlink.
    // Walk upward with lstat so dangling symlinks are detected and followed instead of
    // treated as regular non-existent files inside allowedRoots.
    let current = resolved
    while (true) {
      const stat = await lstatSafe(current)
      if (stat) {
        const suffix = path.relative(current, resolved)
        if (stat.isSymbolicLink()) {
          const linkTarget = await fs.readlink(current)
          const nextBase = path.resolve(path.dirname(current), linkTarget)
          const nextPath = suffix ? path.join(nextBase, suffix) : nextBase
          return resolveRealPath(nextPath, depth + 1)
        }
        const realCurrent = await fs.realpath(current)
        return suffix ? path.join(realCurrent, suffix) : realCurrent
      }
      const parent = path.dirname(current)
      if (parent === current) return resolved
      current = parent
    }
  }
}

const FORBIDDEN_SUGGESTION_SEGMENTS = new Set(['.git', 'node_modules', 'dist', 'src', 'dashboard', 'scripts'])

function isSafeSuggestionTarget(realTarget: string, realAllowedRoot: string): boolean {
  if (path.extname(realTarget).toLowerCase() !== '.md') {
    return false
  }
  const relative = path.relative(realAllowedRoot, realTarget)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return false
  }
  const segments = relative.split(path.sep).filter(Boolean)
  for (const segment of segments) {
    if (FORBIDDEN_SUGGESTION_SEGMENTS.has(segment)) return false
    if (segment.startsWith('.') && segment !== '.claude') return false
  }
  return true
}

async function resolveSuggestionTarget(
  targetFile: string,
  configRoot: string,
  allowedRoots: string[]
): Promise<string> {
  const trimmed = targetFile.trim()
  if (!trimmed) return trimmed
  if (hasPathTraversal(trimmed)) {
    throw new SuggestionTargetError('Invalid targetFile path')
  }

  const expanded = normalizeTildePath(trimmed)
  const resolved = path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(configRoot, expanded)
  const allowedRoot = allowedRoots.find(root => isPathWithin(resolved, root))
  if (!allowedRoot) {
    throw new SuggestionTargetError('Target file must be within project root or ~/.claude/skills')
  }

  const realAllowedRoot = await resolveRealPath(allowedRoot)
  const realTarget = await resolveRealPath(resolved)
  if (!isPathWithin(realTarget, realAllowedRoot)) {
    throw new SuggestionTargetError('Invalid targetFile path')
  }
  if (!isSafeSuggestionTarget(realTarget, realAllowedRoot)) {
    throw new SuggestionTargetError('Target file must be a safe markdown (.md) documentation or skill file')
  }

  return realTarget
}

function normalizeDiffPathValue(targetFile: string): string {
  const trimmed = targetFile.trim()
  if (!trimmed) return ''
  if (trimmed === '/dev/null') return trimmed
  let unquoted = trimmed
  if (
    (unquoted.startsWith('"') && unquoted.endsWith('"')) ||
    (unquoted.startsWith('\'') && unquoted.endsWith('\''))
  ) {
    unquoted = unquoted.slice(1, -1)
  }
  const withoutPrefix = unquoted.replace(/^([ab])\//, '').replace(/^\.\/+/, '')
  return withoutPrefix.replace(/\\/g, '/')
}

type UnifiedDiffLine = {
  type: 'context' | 'add' | 'delete'
  value: string
}

type UnifiedDiffHunk = {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: UnifiedDiffLine[]
}

type ParsedUnifiedDiff = {
  oldPath: string
  newPath: string
  hunks: UnifiedDiffHunk[]
  addedLines: string[]
  addedLineCount: number
  deletedLineCount: number
  hasHunk: boolean
  hasChanges: boolean
  isSingleFile: boolean
}

function parseUnifiedDiff(
  diff: string
): ParsedUnifiedDiff {
  const lines = diff.replace(/\r\n/g, '\n').split('\n')
  const hunks: UnifiedDiffHunk[] = []
  const addedLines: string[] = []
  const oldPaths: string[] = []
  const newPaths: string[] = []
  let currentHunk: UnifiedDiffHunk | null = null
  let inHunk = false
  let hasHunk = false
  let addedLineCount = 0
  let deletedLineCount = 0

  const flushCurrentHunk = () => {
    if (!currentHunk) return
    hunks.push(currentHunk)
    currentHunk = null
  }

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flushCurrentHunk()
      inHunk = false
      continue
    }
    if (line.startsWith('@@')) {
      const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/)
      if (!match) {
        flushCurrentHunk()
        inHunk = false
        continue
      }
      flushCurrentHunk()
      currentHunk = {
        oldStart: Number.parseInt(match[1] ?? '0', 10),
        oldCount: Number.parseInt(match[2] ?? '1', 10),
        newStart: Number.parseInt(match[3] ?? '0', 10),
        newCount: Number.parseInt(match[4] ?? '1', 10),
        lines: []
      }
      inHunk = true
      hasHunk = true
      continue
    }
    if (!inHunk && line.startsWith('--- ')) {
      oldPaths.push(extractDiffPath(line.slice(4)))
      continue
    }
    if (!inHunk && line.startsWith('+++ ')) {
      newPaths.push(extractDiffPath(line.slice(4)))
      continue
    }
    if (!inHunk) continue
    if (line.startsWith('\\ No newline at end of file')) continue
    if (!currentHunk || line.length === 0) continue

    const marker = line[0]
    if (marker === '+') {
      currentHunk.lines.push({ type: 'add', value: line.slice(1) })
      addedLines.push(line.slice(1))
      addedLineCount += 1
      continue
    }
    if (marker === '-') {
      currentHunk.lines.push({ type: 'delete', value: line.slice(1) })
      deletedLineCount += 1
      continue
    }
    if (marker === ' ') {
      currentHunk.lines.push({ type: 'context', value: line.slice(1) })
      continue
    }

    flushCurrentHunk()
    inHunk = false
  }
  flushCurrentHunk()

  return {
    oldPath: oldPaths[0] ?? '',
    newPath: newPaths[0] ?? '',
    hunks,
    addedLines,
    addedLineCount,
    deletedLineCount,
    hasHunk,
    hasChanges: addedLineCount > 0 || deletedLineCount > 0,
    isSingleFile: oldPaths.length === 1 && newPaths.length === 1
  }
}

function extractDiffPath(rawPath: string): string {
  const trimmed = rawPath.trim()
  if (!trimmed) return ''
  const tabIndex = trimmed.indexOf('\t')
  return tabIndex === -1 ? trimmed : trimmed.slice(0, tabIndex)
}

function buildDiffContent(addedLines: string[]): string {
  if (addedLines.length === 0) return ''
  const content = addedLines.join('\n')
  return addedLines[addedLines.length - 1] === '' ? content : `${content}\n`
}

function applyUnifiedDiffToContent(content: string, parsedDiff: ParsedUnifiedDiff): string {
  const { lines, hadTrailingNewline } = splitContentLines(content)
  const output = [...lines]
  let lineOffset = 0

  for (let hunkIndex = 0; hunkIndex < parsedDiff.hunks.length; hunkIndex += 1) {
    const hunk = parsedDiff.hunks[hunkIndex]
    const insertionPoint = Math.max(0, hunk.oldStart - 1 + lineOffset)
    if (insertionPoint > output.length) {
      throw new DiffApplyError(
        `Diff hunk ${hunkIndex + 1} cannot be applied: target line is outside file bounds`
      )
    }

    let cursor = insertionPoint
    for (const line of hunk.lines) {
      if (line.type === 'context') {
        if (output[cursor] !== line.value) {
          throw new DiffApplyError(
            `Diff hunk ${hunkIndex + 1} cannot be applied: context mismatch at line ${cursor + 1}`
          )
        }
        cursor += 1
        continue
      }

      if (line.type === 'delete') {
        if (output[cursor] !== line.value) {
          throw new DiffApplyError(
            `Diff hunk ${hunkIndex + 1} cannot be applied: deletion mismatch at line ${cursor + 1}`
          )
        }
        output.splice(cursor, 1)
        lineOffset -= 1
        continue
      }

      output.splice(cursor, 0, line.value)
      cursor += 1
      lineOffset += 1
    }
  }

  return joinContentLines(output, hadTrailingNewline)
}

function splitContentLines(content: string): { lines: string[]; hadTrailingNewline: boolean } {
  if (!content) {
    return { lines: [], hadTrailingNewline: false }
  }

  const normalized = content.replace(/\r\n/g, '\n')
  const hadTrailingNewline = normalized.endsWith('\n')
  const lines = normalized.split('\n')
  if (hadTrailingNewline) {
    lines.pop()
  }
  return { lines, hadTrailingNewline }
}

function joinContentLines(lines: string[], hadTrailingNewline: boolean): string {
  if (lines.length === 0) return ''
  const body = lines.join('\n')
  return hadTrailingNewline ? `${body}\n` : body
}
