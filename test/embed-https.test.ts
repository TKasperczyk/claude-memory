import { execFileSync } from 'child_process'
import fs from 'fs'
import https from 'https'
import type { AddressInfo } from 'net'
import os from 'os'
import path from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { embed } from '../src/lib/embed.js'
import { DEFAULT_CONFIG, EMBEDDING_DIM, type Config } from '../src/lib/types.js'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-memory-embed-https-test-'))
const keyPath = path.join(tempDir, 'key.pem')
const certPath = path.join(tempDir, 'cert.pem')

let server: https.Server | null = null
let baseUrl = ''
let delayResponseMs = 0

function makeConfig(insecure: boolean): Config {
  return {
    ...DEFAULT_CONFIG,
    embeddings: {
      ...DEFAULT_CONFIG.embeddings,
      baseUrl,
      model: 'test-model',
      insecure
    }
  }
}

beforeAll(async () => {
  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey', 'rsa:2048',
    '-nodes',
    '-keyout', keyPath,
    '-out', certPath,
    '-days', '1',
    '-subj', '/CN=127.0.0.1'
  ], { stdio: 'ignore' })

  const key = fs.readFileSync(keyPath)
  const cert = fs.readFileSync(certPath)

  server = https.createServer({ key, cert }, (req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const send = () => {
        if (res.writableEnded || res.destroyed) return
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          data: [{ embedding: Array.from({ length: EMBEDDING_DIM }, (_, i) => i / EMBEDDING_DIM) }]
        }))
      }
      if (delayResponseMs > 0) {
        const timer = setTimeout(send, delayResponseMs)
        req.on('close', () => clearTimeout(timer))
      } else {
        send()
      }
    })
  })

  await new Promise<void>(resolve => {
    server!.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address() as AddressInfo
  baseUrl = `https://127.0.0.1:${address.port}/v1`
})

afterAll(async () => {
  if (server) {
    await new Promise<void>(resolve => server!.close(() => resolve()))
  }
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe('embed insecure HTTPS agent isolation', () => {
  it('succeeds against self-signed HTTPS when insecure=true without mutating NODE_TLS_REJECT_UNAUTHORIZED', async () => {
    const prevTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
    delayResponseMs = 0

    try {
      const vector = await embed('hello self-signed', makeConfig(true))
      expect(vector).toHaveLength(EMBEDDING_DIM)
      expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined()

      // Confirm TLS verification is STILL enforced when insecure=false
      await expect(embed('hello strict', makeConfig(false), { timeoutMs: 3000 }))
        .rejects.toThrow()
    } finally {
      if (prevTls !== undefined) {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevTls
      }
    }
  })

  it('aborts an in-flight insecure HTTPS embedding request promptly via AbortSignal', async () => {
    delayResponseMs = 5000
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 40)

    try {
      const startedAt = Date.now()
      await expect(
        embed('abort me', makeConfig(true), { signal: controller.signal, timeoutMs: 5000 })
      ).rejects.toThrow(/aborted/i)
      expect(Date.now() - startedAt).toBeLessThan(1000)
    } finally {
      clearTimeout(timer)
      delayResponseMs = 0
    }
  })
})
