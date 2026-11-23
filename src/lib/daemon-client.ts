import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'

function resolveClaudeMemoryRoot(): string {
  const override = process.env.CC_MEMORIES_DATA_DIR?.trim()
  if (!override) return path.join(os.homedir(), '.claude-memory')
  if (override === '~') return os.homedir()
  if (override.startsWith('~/')) return path.join(os.homedir(), override.slice(2))
  return path.resolve(override)
}

export const DEFAULT_DAEMON_SOCKET_PATH = path.join(resolveClaudeMemoryRoot(), 'daemon.sock')
export const DEFAULT_DAEMON_PID_PATH = path.join(resolveClaudeMemoryRoot(), 'daemon.pid')

export function getDaemonSocketPath(): string {
  return process.env.CC_MEMORIES_DAEMON_SOCKET?.trim() || path.join(resolveClaudeMemoryRoot(), 'daemon.sock')
}

/**
 * Zero-dependency Unix-socket JSON client for the warm local daemon.
 * Uses only Node built-in modules so hook entrypoints can hit a running daemon
 * without paying ~100ms to load @lancedb/lancedb or @anthropic-ai/sdk.
 * Returns null immediately (<0.2ms) when the socket does not exist or on error.
 */
export async function queryDaemon<T>(
  endpoint: string,
  body?: unknown,
  options: { socketPath?: string; timeoutMs?: number; method?: 'GET' | 'POST' } = {}
): Promise<T | null> {
  const socketPath = options.socketPath ?? getDaemonSocketPath()
  if (!fs.existsSync(socketPath)) return null

  const method = options.method ?? (body === undefined ? 'GET' : 'POST')
  const payload = body === undefined ? undefined : JSON.stringify(body)
  const timeoutMs = options.timeoutMs ?? 5000

  return new Promise<T | null>((resolve) => {
    let settled = false
    const done = (value: T | null): void => {
      if (settled) return
      settled = true
      resolve(value)
    }

    const req = http.request({
      socketPath,
      path: endpoint,
      method,
      headers: payload
        ? {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload, 'utf8')
          }
        : undefined
    }, (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { raw += chunk })
      res.on('end', () => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          done(null)
          return
        }
        try {
          done(JSON.parse(raw) as T)
        } catch {
          done(null)
        }
      })
    })

    req.setTimeout(timeoutMs, () => {
      req.destroy()
      done(null)
    })
    req.on('error', () => done(null))
    if (payload) req.write(payload)
    req.end()
  })
}
