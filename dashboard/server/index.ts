/**
 * Dashboard API server - queries Milvus and serves data to frontend.
 * Run with: pnpm run server
 */

import cors from 'cors'
import express from 'express'
import { createServerContext } from './context.js'
import { createLogger } from './lib/logger.js'
import { createExtractionsRouter } from './routes/extractions.js'
import { createInstallationRouter } from './routes/installation.js'
import { createMaintenanceRouter } from './routes/maintenance.js'
import { createMemoryRouter } from './routes/memory.js'
import { createPreviewRouter } from './routes/preview.js'
import { createSessionsRouter } from './routes/sessions.js'
import { createSettingsRouter } from './routes/settings.js'
import { startStatsSnapshotScheduler } from './lib/stats-snapshot-scheduler.js'

const logger = createLogger('server')
const app = express()
const PORT = process.env.PORT ?? 3001
const context = createServerContext()

startStatsSnapshotScheduler(context.config)

app.use(cors({ origin: ['http://localhost:5173', 'http://127.0.0.1:5173'] }))
app.use(express.json())

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

app.listen(PORT, () => {
  logger.info(`Dashboard API server running on http://localhost:${PORT}`)
})
