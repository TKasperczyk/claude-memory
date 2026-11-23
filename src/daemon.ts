#!/usr/bin/env node

import { startDaemonServer, DEFAULT_DAEMON_SOCKET_PATH, DEFAULT_DAEMON_PID_PATH } from './lib/daemon.js'
import { lookupFailureMemories } from './hooks/post-tool-failure.js'
import { isProcessEntrypoint } from './lib/shared.js'

export async function runDaemon(): Promise<void> {
  const handle = await startDaemonServer({
    socketPath: process.env.CC_MEMORIES_DAEMON_SOCKET || DEFAULT_DAEMON_SOCKET_PATH,
    pidPath: process.env.CC_MEMORIES_DAEMON_PID || DEFAULT_DAEMON_PID_PATH,
    onPostToolFailure: async (payload, config) => lookupFailureMemories(payload, config)
  })
  console.error(`[claude-memory-daemon] Listening on ${handle.socketPath} (pid=${process.pid})`)

  const shutdown = async () => {
    await handle.close()
    process.exit(0)
  }
  process.on('SIGINT', () => { void shutdown() })
  process.on('SIGTERM', () => { void shutdown() })
}

if (isProcessEntrypoint(import.meta.url)) {
  runDaemon().catch(error => {
    console.error('[claude-memory-daemon] Fatal error:', error)
    process.exit(1)
  })
}
