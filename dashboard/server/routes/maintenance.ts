import express from 'express'
import fs from 'fs/promises'
import path from 'path'
import { homedir } from 'os'
import { reviewMaintenanceResult, reviewMaintenanceResultStreaming } from '../../../src/lib/maintenance-review.js'
import {
  MAINTENANCE_OPERATIONS,
  MAINTENANCE_OPERATION_DEFINITIONS,
  runAllMaintenance,
  runMaintenanceOperation,
  type MaintenanceOperation
} from '../../../src/lib/maintenance-api.js'
import { getMaintenanceReview, saveMaintenanceReview } from '../../../src/lib/review-storage.js'
import type { ServerContext } from '../context.js'
import { createLogger } from '../lib/logger.js'
import { createSseStream, sendSseError } from '../lib/sse.js'
import { getRequestConfig } from '../utils/config.js'
import { isPlainObject } from '../utils/params.js'
import { ensureConfigInitialized } from '../utils/milvus.js'

const logger = createLogger('maintenance')

type SuggestionApplyAction = 'new' | 'edit'

class SuggestionTargetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SuggestionTargetError'
  }
}

export function createMaintenanceRouter(context: ServerContext): express.Router {
  const router = express.Router()
  const { config: baseConfig, configRoot, suggestionAllowedRoots } = context

  router.get('/api/maintenance/:operation/review/:resultId', (req, res) => {
    try {
      const { operation, resultId } = req.params
      const requestConfig = getRequestConfig(req, baseConfig)
      const review = getMaintenanceReview(resultId, operation, requestConfig.milvus.collection)
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
          const config = await ensureConfigInitialized(req, baseConfig)
          const review = await reviewMaintenanceResultStreaming(normalizedResult, config, stream.onThinking, stream.signal)
          saveMaintenanceReview(review, config.milvus.collection)
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

      const config = await ensureConfigInitialized(req, baseConfig)
      const review = await reviewMaintenanceResult(normalizedResult, config)
      saveMaintenanceReview(review, config.milvus.collection)
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

      const resolvedTarget = await resolveSuggestionTarget(targetFile, configRoot, suggestionAllowedRoots)
      const allowOverwrite = overwrite === true

      if (action === 'new') {
        if (await pathExists(resolvedTarget) && !allowOverwrite) {
          return res.status(409).json({ error: 'Target file already exists' })
        }
        await fs.mkdir(path.dirname(resolvedTarget), { recursive: true })
        await fs.writeFile(resolvedTarget, content, { encoding: 'utf-8', flag: allowOverwrite ? 'w' : 'wx' })
      } else {
        if (!(await pathExists(resolvedTarget))) {
          return res.status(404).json({ error: 'Target file not found' })
        }
        await appendToExistingFile(resolvedTarget, content)
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
      logger.error('Failed to apply suggestion', error)
      res.status(500).json({ error: 'Failed to apply suggestion' })
    }
  })

  router.post('/api/maintenance/run', async (req, res) => {
    try {
      const config = await ensureConfigInitialized(req, baseConfig)
      const { operation, dryRun } = req.body ?? {}
      if (!operation || typeof operation !== 'string') {
        return res.status(400).json({ error: 'Operation required' })
      }

      if (!MAINTENANCE_OPERATIONS.includes(operation as MaintenanceOperation)) {
        return res.status(400).json({ error: 'Unknown operation' })
      }

      const mode = dryRun ? 'preview' : 'run'
      logger.info(`Running ${operation} (${mode})`)

      const result = await runMaintenanceOperation(
        operation as MaintenanceOperation,
        Boolean(dryRun),
        config
      )

      logger.info(`Completed ${operation}`, result.summary)
      res.json(result)
    } catch (error) {
      logger.error('Failed to run maintenance operation', error)
      res.status(500).json({ error: 'Failed to run maintenance operation' })
    }
  })

  router.post('/api/maintenance/run-all', async (req, res) => {
    try {
      const config = await ensureConfigInitialized(req, baseConfig)
      const { dryRun } = req.body ?? {}
      const results = await runAllMaintenance(Boolean(dryRun), config)
      res.json(results)
    } catch (error) {
      logger.error('Failed to run all maintenance operations', error)
      res.status(500).json({ error: 'Failed to run maintenance operations' })
    }
  })

  router.get('/api/maintenance/stream', async (req, res) => {
    const dryRun = req.query.dryRun === 'true'
    const singleOperation = typeof req.query.operation === 'string' ? req.query.operation : null
    const operationsToRun = singleOperation
      ? MAINTENANCE_OPERATIONS.filter(op => op === singleOperation)
      : MAINTENANCE_OPERATIONS

    if (singleOperation && !MAINTENANCE_OPERATIONS.includes(singleOperation as MaintenanceOperation)) {
      return res.status(400).json({ error: 'Unknown operation' })
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
      const config = await ensureConfigInitialized(req, baseConfig)

      sendEvent('start', {
        operations: operationsToRun,
        dryRun
      })

      for (const operation of operationsToRun) {
        if (stream.signal.aborted) break

        sendEvent('progress', { operation, status: 'running' })

        try {
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

async function findExistingParent(targetPath: string): Promise<string> {
  let current = path.resolve(targetPath)
  while (!(await pathExists(current))) {
    const parent = path.dirname(current)
    if (parent === current) return current
    current = parent
  }
  return current
}

async function resolveRealPath(targetPath: string): Promise<string> {
  const resolved = path.resolve(targetPath)
  if (await pathExists(resolved)) {
    return fs.realpath(resolved)
  }
  const existingParent = await findExistingParent(resolved)
  const realParent = await fs.realpath(existingParent)
  const relative = path.relative(existingParent, resolved)
  return path.join(realParent, relative)
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

  return resolved
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

async function appendToExistingFile(targetPath: string, content: string): Promise<void> {
  const handle = await fs.open(targetPath, 'r+')
  try {
    const { size } = await handle.stat()
    await handle.write(content, size, 'utf-8')
  } finally {
    await handle.close()
  }
}
