import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const testHome = await vi.hoisted(async () => {
  const [fsMod, osMod, pathMod] = await Promise.all([import('fs'), import('os'), import('path')])
  return fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'claude-memory-anthropic-oauth-test-'))
})

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return {
    ...actual,
    homedir: () => testHome,
    platform: () => 'linux'
  }
})

vi.mock('../src/lib/paths.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/paths.js')>('../src/lib/paths.js')
  return {
    ...actual,
    CLAUDE_MEMORY_ROOT: path.join(testHome, '.claude-memory'),
    LOCKS_DIR: path.join(testHome, '.claude-memory', 'locks')
  }
})

import { createOAuthFetch, getFreshCredentials } from '../src/lib/anthropic.js'

const credPath = path.join(testHome, '.claude', '.credentials.json')
const locksDir = path.join(testHome, '.claude-memory', 'locks')
const refreshLockPath = path.join(locksDir, 'oauth-refresh.lock')
const originalFetch = globalThis.fetch

function writeCreds(creds: { accessToken: string; refreshToken: string; expiresAt: number; apiKey?: string }): void {
  fs.mkdirSync(path.dirname(credPath), { recursive: true })
  fs.writeFileSync(credPath, JSON.stringify({ claudeAiOauth: creds }, null, 2), 'utf-8')
}

beforeEach(() => {
  globalThis.fetch = originalFetch
  fs.rmSync(credPath, { force: true })
  fs.rmSync(refreshLockPath, { force: true })
})

afterEach(() => {
  globalThis.fetch = originalFetch
  fs.rmSync(refreshLockPath, { force: true })
})

afterAll(() => {
  globalThis.fetch = originalFetch
  fs.rmSync(testHome, { recursive: true, force: true })
})

describe('createOAuthFetch', () => {
  it('transforms multi-turn tool_use names, preserves PascalCase/mcp tools, and strips stale encoding/length headers', async () => {
    let capturedUrl = ''
    let capturedBody: Record<string, unknown> | null = null

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = typeof input === 'string' ? input : input.toString()
      capturedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      return new Response(JSON.stringify({
        id: 'msg_1',
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'Search_memories', input: { query: 'test' } },
          { type: 'tool_use', id: 'tu_2', name: 'Bash', input: { cmd: 'ls' } },
          { type: 'tool_use', id: 'tu_3', name: 'mcp__srv__do', input: {} }
        ]
      }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'content-encoding': 'gzip',
          'content-length': '9999'
        }
      })
    }) as typeof fetch

    const oauthFetch = createOAuthFetch()
    const response = await oauthFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        tools: [
          { name: 'search_memories' },
          { name: 'Bash' },
          { name: 'mcp__srv__do' }
        ],
        tool_choice: { type: 'tool', name: 'search_memories' },
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'prev_1', name: 'search_memories', input: {} },
              { type: 'tool_use', id: 'prev_2', name: 'Bash', input: {} },
              { type: 'tool_use', id: 'prev_3', name: 'mcp__srv__do', input: {} }
            ]
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'prev_1', content: 'ok' }]
          }
        ]
      })
    })

    expect(capturedUrl).toBe('https://api.anthropic.com/v1/messages?beta=true')
    expect((capturedBody as any).tools.map((t: any) => t.name)).toEqual([
      'Search_memories',
      'Bash',
      'mcp__srv__do'
    ])
    expect((capturedBody as any).tool_choice.name).toBe('Search_memories')
    expect((capturedBody as any).messages[0].content.map((b: any) => b.name)).toEqual([
      'Search_memories',
      'Bash',
      'mcp__srv__do'
    ])

    expect(response.headers.get('content-encoding')).toBeNull()
    expect(response.headers.get('content-length')).toBeNull()

    const payload = await response.json() as { content: Array<{ name: string }> }
    expect(payload.content.map(b => b.name)).toEqual([
      'search_memories',
      'Bash',
      'mcp__srv__do'
    ])
  })

  it('returns readable buffered Response when an application/json error body is malformed JSON', async () => {
    globalThis.fetch = vi.fn(async () => new Response('<html>502 Bad Gateway</html>', {
      status: 502,
      statusText: 'Bad Gateway',
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip'
      }
    })) as typeof fetch

    const oauthFetch = createOAuthFetch()
    const response = await oauthFetch('https://api.anthropic.com/v1/messages', { method: 'POST', body: '{}' })

    expect(response.status).toBe(502)
    expect(response.headers.get('content-encoding')).toBeNull()
    expect(await response.text()).toBe('<html>502 Bad Gateway</html>')
  })

  it('transforms SSE tool names across chunk boundaries and propagates stream cancellation', async () => {
    const encoder = new TextEncoder()
    let cancelReason: unknown = null

    const ssePayload = [
      'event: content_block_start',
      `data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'Emit_records', input: {} } })}`,
      '',
      'event: content_block_start',
      `data: ${JSON.stringify({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_2', name: 'Bash', input: {} } })}`,
      '',
      'event: message_stop',
      'data: {"type":"message_stop","note":"café 🚀"}',
      '',
      ''
    ].join('\n')
    const rawBytes = encoder.encode(ssePayload)

    // Split mid-event and mid-UTF-8 emoji
    const split1 = Math.floor(rawBytes.length / 3)
    const split2 = rawBytes.length - 6
    const chunks = [rawBytes.slice(0, split1), rawBytes.slice(split1, split2), rawBytes.slice(split2)]

    globalThis.fetch = vi.fn(async () => {
      let i = 0
      const upstream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (i < chunks.length) {
            controller.enqueue(chunks[i++])
          } else {
            controller.close()
          }
        },
        cancel(reason) {
          cancelReason = reason
        }
      })
      return new Response(upstream, {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'content-encoding': 'gzip'
        }
      })
    }) as typeof fetch

    const oauthFetch = createOAuthFetch()
    const res = await oauthFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({ tools: [{ name: 'emit_records' }, { name: 'Bash' }] })
    })

    expect(res.headers.get('content-encoding')).toBeNull()
    const fullText = await res.text()
    expect(fullText).toContain('"name":"emit_records"')
    expect(fullText).toContain('"name":"Bash"')
    expect(fullText).toContain('café 🚀')

    // Now test explicit cancellation propagation
    const res2 = await oauthFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({ tools: [{ name: 'emit_records' }] })
    })
    const reader = res2.body!.getReader()
    await reader.cancel('client-aborted')
    expect(cancelReason).toBe('client-aborted')
  })
})

describe('getFreshCredentials refresh synchronization', () => {
  it('coalesces concurrent in-process refreshes into one fetch without blocking the event loop', async () => {
    writeCreds({
      accessToken: 'expired-token',
      refreshToken: 'refresh-1',
      expiresAt: Date.now() - 10_000
    })

    let fetchCalls = 0
    globalThis.fetch = vi.fn(async () => {
      fetchCalls += 1
      await new Promise(resolve => setTimeout(resolve, 40))
      return new Response(JSON.stringify({
        access_token: 'fresh-token',
        refresh_token: 'refresh-2',
        expires_in: 3600
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    const startedAt = Date.now()
    const [first, second, third] = await Promise.all([
      getFreshCredentials({ lockMaxWaitMs: 500, lockRetryMs: 10 }),
      getFreshCredentials({ lockMaxWaitMs: 500, lockRetryMs: 10 }),
      getFreshCredentials({ lockMaxWaitMs: 500, lockRetryMs: 10 })
    ])
    const elapsedMs = Date.now() - startedAt

    expect(fetchCalls).toBe(1)
    expect(elapsedMs).toBeLessThan(1000)
    expect(first?.creds.accessToken).toBe('fresh-token')
    expect(second?.creds.accessToken).toBe('fresh-token')
    expect(third?.creds.accessToken).toBe('fresh-token')
  })

  it('waits asynchronously when another live process holds oauth-refresh.lock and adopts its refreshed token', async () => {
    writeCreds({
      accessToken: 'expired-token',
      refreshToken: 'refresh-1',
      expiresAt: Date.now() - 10_000
    })

    fs.mkdirSync(locksDir, { recursive: true })
    fs.writeFileSync(refreshLockPath, `${process.pid}\n${Date.now()}`, 'utf-8')

    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch

    // Simulate another process finishing refresh and releasing lock 40ms later.
    // If getFreshCredentials blocked the event loop synchronously, this timer would never fire!
    setTimeout(() => {
      writeCreds({
        accessToken: 'other-proc-fresh-token',
        refreshToken: 'refresh-other',
        expiresAt: Date.now() + 3600_000
      })
      fs.rmSync(refreshLockPath, { force: true })
    }, 40)

    const result = await getFreshCredentials({ lockMaxWaitMs: 500, lockRetryMs: 15 })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result?.creds.accessToken).toBe('other-proc-fresh-token')
  })

  it('returns null instead of racing unlocked if oauth-refresh.lock remains held past timeout', async () => {
    writeCreds({
      accessToken: 'expired-token',
      refreshToken: 'refresh-1',
      expiresAt: Date.now() - 10_000
    })

    fs.mkdirSync(locksDir, { recursive: true })
    fs.writeFileSync(refreshLockPath, `${process.pid}\n${Date.now()}`, 'utf-8')

    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const result = await getFreshCredentials({ lockMaxWaitMs: 60, lockRetryMs: 15 })
      expect(result).toBeNull()
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      consoleError.mockRestore()
    }
  })
})
