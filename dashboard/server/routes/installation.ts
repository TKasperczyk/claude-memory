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
  const { claudeSettingsPath, claudeConfigPath, installationRoot } = context

  router.get('/api/installation/status', (_req, res) => {
    handleInstallationStatus(res, claudeSettingsPath, installationRoot, claudeConfigPath, 'Failed to load installation status')
  })

  router.post('/api/installation/install', (_req, res) => {
    handleInstallationMutation(res, claudeSettingsPath, installationRoot, claudeConfigPath, 'install', 'Failed to install hooks and commands')
  })

  router.post('/api/installation/uninstall', (_req, res) => {
    handleInstallationMutation(res, claudeSettingsPath, installationRoot, claudeConfigPath, 'uninstall', 'Failed to uninstall hooks and commands')
  })

  router.get('/api/hooks/status', (_req, res) => {
    handleHookStatus(res, claudeSettingsPath, installationRoot, 'Failed to load hook status')
  })

  router.post('/api/hooks/install', (_req, res) => {
    handleHookMutation(res, claudeSettingsPath, installationRoot, 'install', 'Failed to install hooks')
  })

  router.post('/api/hooks/uninstall', (_req, res) => {
    handleHookMutation(res, claudeSettingsPath, installationRoot, 'uninstall', 'Failed to uninstall hooks')
  })

  return router
}

function handleInstallationStatus(
  res: Response,
  claudeSettingsPath: string,
  installationRoot: string,
  claudeConfigPath: string,
  fallbackMessage: string
): void {
  try {
    const status = getInstallationStatus(claudeSettingsPath, installationRoot, claudeConfigPath)
    res.json({ hooks: status.hooks, commands: status.commands, mcp: status.mcp })
  } catch (error) {
    handleClaudeSettingsError(res, error, fallbackMessage)
  }
}

function handleHookStatus(
  res: Response,
  claudeSettingsPath: string,
  installationRoot: string,
  fallbackMessage: string
): void {
  try {
    const hooks = getHookStatus(claudeSettingsPath, installationRoot)
    res.json({ hooks })
  } catch (error) {
    handleClaudeSettingsError(res, error, fallbackMessage)
  }
}

function handleInstallationMutation(
  res: Response,
  claudeSettingsPath: string,
  installationRoot: string,
  claudeConfigPath: string,
  action: 'install' | 'uninstall',
  fallbackMessage: string
): void {
  try {
    const status = action === 'install'
      ? installAll(claudeSettingsPath, installationRoot, claudeConfigPath)
      : uninstallAll(claudeSettingsPath, installationRoot, claudeConfigPath)
    res.json({ success: true, hooks: status.hooks, commands: status.commands, mcp: status.mcp })
  } catch (error) {
    handleClaudeSettingsError(res, error, fallbackMessage)
  }
}

function handleHookMutation(
  res: Response,
  claudeSettingsPath: string,
  installationRoot: string,
  action: 'install' | 'uninstall',
  fallbackMessage: string
): void {
  try {
    const hooks = action === 'install'
      ? installHooks(claudeSettingsPath, installationRoot)
      : uninstallHooks(claudeSettingsPath, installationRoot)
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
