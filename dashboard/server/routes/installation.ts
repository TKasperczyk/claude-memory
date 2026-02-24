import express, { type Response } from 'express'
import {
  ClaudeSettingsError,
  getHookStatus,
  getInstallationStatus,
  installAll,
  installHooks,
  uninstallAll,
  uninstallHooks
} from '../../../src/lib/installer.js'
import type { ServerContext } from '../context.js'
import { createLogger } from '../lib/logger.js'

const logger = createLogger('installation')

export function createInstallationRouter(context: ServerContext): express.Router {
  const router = express.Router()
  const { claudeSettingsPath, claudeConfigPath, configRoot } = context

  router.get('/api/installation/status', (_req, res) => {
    handleInstallationStatus(res, claudeSettingsPath, configRoot, claudeConfigPath, 'Failed to load installation status')
  })

  router.post('/api/installation/install', (_req, res) => {
    handleInstallationMutation(res, claudeSettingsPath, configRoot, claudeConfigPath, 'install', 'Failed to install hooks and commands')
  })

  router.post('/api/installation/uninstall', (_req, res) => {
    handleInstallationMutation(res, claudeSettingsPath, configRoot, claudeConfigPath, 'uninstall', 'Failed to uninstall hooks and commands')
  })

  router.get('/api/hooks/status', (_req, res) => {
    handleHookStatus(res, claudeSettingsPath, configRoot, 'Failed to load hook status')
  })

  router.post('/api/hooks/install', (_req, res) => {
    handleHookMutation(res, claudeSettingsPath, configRoot, 'install', 'Failed to install hooks')
  })

  router.post('/api/hooks/uninstall', (_req, res) => {
    handleHookMutation(res, claudeSettingsPath, configRoot, 'uninstall', 'Failed to uninstall hooks')
  })

  return router
}

function handleInstallationStatus(
  res: Response,
  claudeSettingsPath: string,
  configRoot: string,
  claudeConfigPath: string,
  fallbackMessage: string
): void {
  try {
    const status = getInstallationStatus(claudeSettingsPath, configRoot, claudeConfigPath)
    res.json({ hooks: status.hooks, commands: status.commands, mcp: status.mcp })
  } catch (error) {
    handleClaudeSettingsError(res, error, fallbackMessage)
  }
}

function handleHookStatus(
  res: Response,
  claudeSettingsPath: string,
  configRoot: string,
  fallbackMessage: string
): void {
  try {
    const hooks = getHookStatus(claudeSettingsPath, configRoot)
    res.json({ hooks })
  } catch (error) {
    handleClaudeSettingsError(res, error, fallbackMessage)
  }
}

function handleInstallationMutation(
  res: Response,
  claudeSettingsPath: string,
  configRoot: string,
  claudeConfigPath: string,
  action: 'install' | 'uninstall',
  fallbackMessage: string
): void {
  try {
    const status = action === 'install'
      ? installAll(claudeSettingsPath, configRoot, claudeConfigPath)
      : uninstallAll(claudeSettingsPath, configRoot, claudeConfigPath)
    res.json({ success: true, hooks: status.hooks, commands: status.commands, mcp: status.mcp })
  } catch (error) {
    handleClaudeSettingsError(res, error, fallbackMessage)
  }
}

function handleHookMutation(
  res: Response,
  claudeSettingsPath: string,
  configRoot: string,
  action: 'install' | 'uninstall',
  fallbackMessage: string
): void {
  try {
    const hooks = action === 'install'
      ? installHooks(claudeSettingsPath, configRoot)
      : uninstallHooks(claudeSettingsPath, configRoot)
    res.json({ success: true, hooks })
  } catch (error) {
    handleClaudeSettingsError(res, error, fallbackMessage)
  }
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
  logger.error('Claude settings error', error)
  const message = error instanceof Error ? error.message : fallbackMessage
  res.status(500).json({ error: message || fallbackMessage })
}
