import express from 'express'
import {
  getDefaultMaintenanceSettings,
  getDefaultSettings,
  loadSettings,
  resetSettings,
  saveSettings,
  validateSettingValue
} from '../../../src/lib/settings.js'
import type { Settings } from '../../../shared/types.js'
import { isPlainObject } from '../utils/params.js'

export function createSettingsRouter(): express.Router {
  const router = express.Router()

  router.get('/api/settings', (_req, res) => {
    try {
      res.json(loadSettings())
    } catch (error) {
      console.error('Settings error:', error)
      res.status(500).json({ error: 'Failed to load settings' })
    }
  })

  router.get('/api/settings/defaults', (_req, res) => {
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

  router.put('/api/settings', (req, res) => {
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

  router.patch('/api/settings', (req, res) => {
    try {
      if (!isPlainObject(req.body)) {
        return res.status(400).json({ error: 'Settings payload must be an object' })
      }

      const { setting, value } = req.body
      if (typeof setting !== 'string' || setting.trim().length === 0) {
        return res.status(400).json({ error: 'setting required' })
      }

      const normalizedSetting = setting.trim()
      const defaults = getDefaultSettings()
      if (!Object.prototype.hasOwnProperty.call(defaults, normalizedSetting)) {
        return res.status(400).json({ error: 'Unknown setting' })
      }

      const validation = validateSettingValue(normalizedSetting as keyof Settings, value)
      if (!validation.ok) {
        return res.status(400).json({ error: validation.error })
      }

      saveSettings({ [normalizedSetting]: validation.normalized } as Partial<Settings>)
      res.json(loadSettings())
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update setting'
      console.error('Setting update error:', error)
      res.status(500).json({ error: message })
    }
  })

  router.post('/api/settings/reset', (_req, res) => {
    try {
      resetSettings()
      res.json(getDefaultSettings())
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to reset settings'
      console.error('Settings reset error:', error)
      res.status(500).send(message)
    }
  })

  return router
}
