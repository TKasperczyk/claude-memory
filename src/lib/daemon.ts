import fs from 'fs'
import http from 'http'
import path from 'path'
import { loadConfig } from './config.js'
import { findGitRoot } from './context.js'
import {
  DEFAULT_DAEMON_PID_PATH,
  DEFAULT_DAEMON_SOCKET_PATH,
  getDaemonSocketPath,
  queryDaemon
} from './daemon-client.js'
import { closeLanceDB, initLanceDB } from './lancedb.js'
import { canonicalizePath } from './paths.js'
import { handlePrePrompt } from './retrieval.js'
import { markInjectedForSuppression } from './session-tracking.js'
import { loadSettings, type RetrievalSettings } from './settings.js'
import { stripRecordEmbedding } from './shared.js'
import type { Config, MemoryRecord, PostToolUseFailureInput, PrePromptInput } from './types.js'

export { DEFAULT_DAEMON_SOCKET_PATH, DEFAULT_DAEMON_PID_PATH, getDaemonSocketPath, queryDaemon }
const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000
const MAX_REQUEST_BYTES = 2 * 1024 * 1024

export interface DaemonHealth {
  ok: true
  pid: number
  uptimeMs: number
  requests: number
}

export interface DaemonServerOptions {
  socketPath?: string
  pidPath?: string
  idleTimeoutMs?: number
  onPostToolFailure?: (payload: PostToolUseFailureInput, config: Config) => Promise<unknown>
}

export interface DaemonServerHandle {
  socketPath: string
  close: () => Promise<void>
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = ''
    let bytes = 0
    req.setEncoding('utf8')
    req.on('data', chunk => {
      bytes += Buffer.byteLength(chunk, 'utf8')
      if (bytes > MAX_REQUEST_BYTES) {
        reject(new Error('Request body too large'))
        req.destroy()
        return
      }
      body += chunk
    })
    req.on('end', () => {
      if (!body.trim()) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(body))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function writeJson(res: http.ServerResponse, statusCode: number, data: unknown): void {
  const payload = JSON.stringify(data)
  res.writeHead(statusCode, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload, 'utf8')
  })
  res.end(payload)
}

/**
 * Start a lightweight local Unix-socket daemon holding warm LanceDB handles so
 * short-lived hook processes avoid repeated Node/native-addon cold start.
 */
export async function startDaemonServer(options: DaemonServerOptions = {}): Promise<DaemonServerHandle> {
  const socketPath = options.socketPath ?? DEFAULT_DAEMON_SOCKET_PATH
  const pidPath = options.pidPath ?? DEFAULT_DAEMON_PID_PATH
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  const startedAt = Date.now()
  let requests = 0
  let closed = false
  let idleTimer: NodeJS.Timeout | null = null

  fs.mkdirSync(path.dirname(socketPath), { recursive: true })
  if (fs.existsSync(socketPath)) {
    const existingHealth = await queryDaemon<DaemonHealth>('/health', undefined, {
      socketPath,
      timeoutMs: 300
    })
    if (existingHealth?.ok) {
      throw new Error(`Daemon already listening on ${socketPath} (pid=${existingHealth.pid})`)
    }
    try {
      fs.unlinkSync(socketPath)
    } catch {
      // ignore stale unlink errors
    }
  }

  let server: http.Server

  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
    await closeLanceDB()
    try {
      if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath)
    } catch {
      // ignore
    }
    try {
      if (fs.existsSync(pidPath)) fs.unlinkSync(pidPath)
    } catch {
      // ignore
    }
  }

  const touchIdleTimer = (): void => {
    if (idleTimeoutMs <= 0) return
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      void close()
    }, idleTimeoutMs)
    idleTimer.unref()
  }

  server = http.createServer(async (req, res) => {
    touchIdleTimer()
    requests += 1

    try {
      if (req.method === 'GET' && req.url === '/health') {
        const health: DaemonHealth = {
          ok: true,
          pid: process.pid,
          uptimeMs: Date.now() - startedAt,
          requests
        }
        writeJson(res, 200, health)
        return
      }

      if (req.method === 'POST' && req.url === '/shutdown') {
        writeJson(res, 200, { ok: true })
        setImmediate(() => { void close() })
        return
      }

      if (req.method === 'POST' && req.url === '/pre-prompt') {
        const body = await readJsonBody(req) as {
          payload?: PrePromptInput
          projectRoot?: string
          config?: Config
          settingsOverride?: Partial<RetrievalSettings>
        }
        if (!body?.payload) {
          writeJson(res, 400, { error: 'missing payload' })
          return
        }
        const projectRoot = body.projectRoot ?? findGitRoot(body.payload.cwd)
        const configRoot = projectRoot ?? (body.payload.cwd ? canonicalizePath(body.payload.cwd) : body.payload.cwd)
        const config = body.config ?? loadConfig(configRoot)
        const settings = body.settingsOverride
          ? { ...loadSettings(), ...body.settingsOverride }
          : loadSettings()
        await initLanceDB(config)
        const result = await handlePrePrompt(body.payload, config, {
          projectRoot,
          settingsOverride: settings,
          closeOnTimeout: false
        })
        // Strip heavy embedding vectors and offline-eval stage1Candidates before IPC serialization.
        const compactResult = {
          ...result,
          stage1Candidates: undefined,
          results: result.results.map(entry => ({
            ...entry,
            record: stripRecordEmbedding(entry.record)
          })),
          injectedRecords: result.injectedRecords.map(stripRecordEmbedding)
        }
        writeJson(res, 200, { result: compactResult })
        return
      }

      if (req.method === 'POST' && req.url === '/post-tool-failure') {
        const body = await readJsonBody(req) as {
          payload?: PostToolUseFailureInput
          config?: Config
          trackSuppression?: boolean
        }
        if (!body?.payload || !options.onPostToolFailure) {
          writeJson(res, 400, { error: 'unsupported or missing payload' })
          return
        }
        const cwd = typeof body.payload.cwd === 'string' ? body.payload.cwd : ''
        const projectRoot = cwd ? findGitRoot(cwd) : undefined
        const configRoot = projectRoot ?? (cwd ? canonicalizePath(cwd) : cwd)
        const config = body.config ?? loadConfig(configRoot)
        await initLanceDB(config)
        const response = await options.onPostToolFailure(body.payload, config) as {
          records?: MemoryRecord[]
          context?: string | null
          durationMs?: number
        } | null
        if (
          body.trackSuppression
          && response?.context
          && Array.isArray(response.records)
          && response.records.length > 0
          && typeof body.payload.session_id === 'string'
          && body.payload.session_id
        ) {
          const settings = loadSettings()
          if (settings.enableTopicSuppression) {
            try {
              markInjectedForSuppression(
                body.payload.session_id,
                response.records.map(r => r.id),
                settings.recentlyInjectedWindow,
                config.lancedb.table
              )
            } catch {
              // non-fatal
            }
          }
        }
        writeJson(res, 200, response)
        return
      }

      writeJson(res, 404, { error: 'not found' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      writeJson(res, 500, { error: message })
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  try {
    fs.chmodSync(socketPath, 0o600)
  } catch {
    // ignore on platforms without unix socket chmod
  }
  try {
    fs.writeFileSync(pidPath, `${process.pid}\n`, 'utf-8')
  } catch {
    // ignore
  }

  touchIdleTimer()
  return { socketPath, close }
}
