/**
 * Dashboard API server - queries LanceDB and serves data to frontend.
 * Run with: pnpm run server
 */

import path from 'path'
import { fileURLToPath } from 'url'
import cors from 'cors'
import express from 'express'
import { createServerContext } from './context.js'
import { createLogger } from './lib/logger.js'
import { migrateSettingsIfNeeded } from '../../src/lib/settings.js'
import { createExtractionsRouter } from './routes/extractions.js'
import { createInstallationRouter } from './routes/installation.js'
import { createMaintenanceRouter } from './routes/maintenance.js'
import { createMemoryRouter } from './routes/memory.js'
import { createPreviewRouter } from './routes/preview.js'
import { createSessionsRouter } from './routes/sessions.js'
import { createSettingsRouter } from './routes/settings.js'
import { createChatRouter } from './routes/chat.js'
import { startStatsSnapshotScheduler } from './lib/stats-snapshot-scheduler.js'
import { validateCollectionHeaderMiddleware } from './utils/config.js'

const logger = createLogger('server')
const app = express()
const HOST = process.env.HOST ?? '127.0.0.1'
const PORT = Number(process.env.PORT ?? 3001)
const context = createServerContext()

try {
  const settingsMigration = migrateSettingsIfNeeded()
  if (settingsMigration.status === 'migrated') {
    logger.info(
      `Migrated settings.json v${settingsMigration.fromVersion ?? 1}->v${settingsMigration.toVersion} `
      + `(${settingsMigration.droppedKeys.length} dropped, ${settingsMigration.keptKeys.length} kept)`
    )
  } else if (settingsMigration.status === 'failed' || settingsMigration.status === 'skipped') {
    logger.warn(`Settings migration ${settingsMigration.status}: ${settingsMigration.error ?? settingsMigration.skipReason ?? 'unknown'}`)
  }
} catch (error) {
  logger.warn('Settings migration check failed', error)
}

startStatsSnapshotScheduler(context.config)

app.use(cors({ origin: ['http://localhost:5000', 'http://127.0.0.1:5000'] }))
app.use(express.json({ limit: '5mb' }))
app.use(validateCollectionHeaderMiddleware)

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now()
  res.on('finish', () => {
    const duration = Date.now() - start
    const level = res.statusCode >= 400 ? 'warn' : 'debug'
    logger[level](`${req.method} ${req.path} ${res.statusCode} ${duration}ms`)
  })
  next()
})

app.use(createSettingsRouter())
app.use(createInstallationRouter(context))
app.use(createMemoryRouter(context))
app.use(createPreviewRouter(context))
app.use(createSessionsRouter(context))
app.use(createExtractionsRouter(context))
app.use(createMaintenanceRouter(context))
app.use(createChatRouter(context))

// In production, serve the built Vite frontend as static files
if (process.env.NODE_ENV === 'production') {
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const staticDir = path.resolve(__dirname, '../dist')

  app.use(express.static(staticDir))

  // SPA fallback: non-API routes serve index.html
  app.get('*', (_req, res) => {
    res.sendFile(path.join(staticDir, 'index.html'))
  })
}

app.listen(PORT, HOST, () => {
  logger.info(`Dashboard server running on http://${HOST}:${PORT}`)
  if (process.env.NODE_ENV === 'production') {
    logger.info('Serving frontend from built assets')
  }
})
