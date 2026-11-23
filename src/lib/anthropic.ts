import Anthropic from '@anthropic-ai/sdk'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { homedir, platform, userInfo } from 'os'
import { basename, dirname, join } from 'path'
import { acquireFileLock } from './lock.js'
import { LOCKS_DIR } from './paths.js'

// OAuth subscription auth constants (aligned with OpenCode auth plugin)
const OAUTH_BETAS_WITH_CLAUDE_CODE = 'oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14'
const OAUTH_USER_AGENT = 'claude-cli/2.1.330 (external, cli)'
// This MUST be sent as the first system message for OAuth to work
export const CLAUDE_CODE_SYSTEM_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude."
export { buildCacheControl, type EphemeralCacheControl, type PromptCacheTtl } from './prompt-cache.js'

/**
 * Transform tool name for OAuth requests.
 * Anthropic's OAuth validation requires tool names to either:
 * - Start with an uppercase letter (PascalCase or Capital_snake)
 * - Have the mcp__ prefix
 *
 * This capitalizes the first letter of tool names that don't match these patterns.
 */
function transformToolNameForOAuth(name: string): string {
  if (!name) return name
  // MCP tools already valid
  if (name.startsWith('mcp__')) return name
  // Already starts with uppercase
  if (name.charAt(0) === name.charAt(0).toUpperCase() && /[A-Z]/.test(name.charAt(0))) return name
  // Capitalize first letter
  return name.charAt(0).toUpperCase() + name.slice(1)
}

/**
 * Reverse the OAuth tool name transformation.
 * Converts back from Capital_case to original lowercase.
 */
function reverseToolNameTransform(name: string): string {
  if (!name) return name
  // MCP tools unchanged
  if (name.startsWith('mcp__')) return name
  // Lowercase first letter
  return name.charAt(0).toLowerCase() + name.slice(1)
}

function reverseToolNameForRequest(
  name: string,
  renamedTools: ReadonlyMap<string, string>,
  trackedRequestTools: boolean
): string {
  const mapped = renamedTools.get(name)
  if (mapped !== undefined) return mapped
  if (trackedRequestTools) return name
  return reverseToolNameTransform(name)
}

function mutateToolUseNames(
  value: unknown,
  renamedTools: ReadonlyMap<string, string>,
  trackedRequestTools: boolean
): boolean {
  if (!value || typeof value !== 'object') return false
  let changed = false

  if (Array.isArray(value)) {
    for (const entry of value) {
      if (mutateToolUseNames(entry, renamedTools, trackedRequestTools)) changed = true
    }
    return changed
  }

  const record = value as Record<string, unknown>
  if (record.type === 'tool_use' && typeof record.name === 'string') {
    const original = reverseToolNameForRequest(record.name, renamedTools, trackedRequestTools)
    if (original !== record.name) {
      record.name = original
      changed = true
    }
  }

  for (const key of Object.keys(record)) {
    if (mutateToolUseNames(record[key], renamedTools, trackedRequestTools)) changed = true
  }

  return changed
}

function transformSseEvent(
  event: string,
  renamedTools: ReadonlyMap<string, string>,
  trackedRequestTools: boolean
): string {
  if (!event.includes('data:')) return event
  const lines = event.split('\n')
  const transformed = lines.map(line => {
    if (!line.startsWith('data:')) return line
    const prefixMatch = line.match(/^data:\s*/)
    const prefix = prefixMatch ? prefixMatch[0] : 'data: '
    const data = line.slice(prefix.length)
    if (!data || data === '[DONE]') return line
    try {
      const parsed = JSON.parse(data) as unknown
      if (mutateToolUseNames(parsed, renamedTools, trackedRequestTools)) {
        return `${prefix}${JSON.stringify(parsed)}`
      }
      return line
    } catch {
      return line
    }
  })
  return transformed.join('\n')
}

function cloneHeadersForDecodedBody(headers: Headers): Headers {
  const cloned = new Headers(headers)
  cloned.delete('content-encoding')
  cloned.delete('content-length')
  return cloned
}

/**
 * Create a fetch wrapper for OAuth requests that:
 * 1. Adds ?beta=true to /v1/messages requests
 * 2. Transforms tool names to satisfy OAuth validation (capitalize first letter)
 * 3. Transforms tool names back in responses
 */
export function createOAuthFetch(): typeof fetch {
  return async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    let requestUrl: URL
    if (typeof input === 'string') {
      requestUrl = new URL(input)
    } else if (input instanceof URL) {
      requestUrl = new URL(input.toString())
    } else {
      requestUrl = new URL(input.url)
    }

    if (requestUrl.pathname === '/v1/messages' && !requestUrl.searchParams.has('beta')) {
      requestUrl.searchParams.set('beta', 'true')
    }

    const renamedTools = new Map<string, string>()
    let trackedRequestTools = false

    const mapOutboundToolName = (originalName: string): string => {
      const transformed = transformToolNameForOAuth(originalName)
      if (transformed !== originalName) {
        renamedTools.set(transformed, originalName)
      }
      return transformed
    }

    // Transform tool names in request body
    let modifiedInit = init
    if (init?.body && typeof init.body === 'string') {
      try {
        const parsed = JSON.parse(init.body) as Record<string, unknown>
        let modified = false

        // Transform tools array
        if (parsed.tools && Array.isArray(parsed.tools)) {
          trackedRequestTools = true
          parsed.tools = (parsed.tools as Array<{ name?: string }>).map(tool => {
            if (tool.name) {
              const transformed = mapOutboundToolName(tool.name)
              if (transformed !== tool.name) modified = true
              return { ...tool, name: transformed }
            }
            return tool
          })
        }

        // Transform tool_choice.name if present
        const toolChoice = parsed.tool_choice as { name?: string } | undefined
        if (toolChoice?.name) {
          const transformed = mapOutboundToolName(toolChoice.name)
          if (transformed !== toolChoice.name) {
            parsed.tool_choice = { ...toolChoice, name: transformed }
            modified = true
          }
        }

        // Transform tool_use block names in multi-turn conversation messages
        if (Array.isArray(parsed.messages)) {
          parsed.messages = (parsed.messages as Array<{ role?: string; content?: unknown }>).map(message => {
            if (!message || !Array.isArray(message.content)) return message
            let messageModified = false
            const nextContent = message.content.map(block => {
              if (
                block
                && typeof block === 'object'
                && (block as { type?: unknown }).type === 'tool_use'
                && typeof (block as { name?: unknown }).name === 'string'
              ) {
                const originalName = (block as { name: string }).name
                const transformed = mapOutboundToolName(originalName)
                if (transformed !== originalName) {
                  messageModified = true
                  modified = true
                  return { ...(block as Record<string, unknown>), name: transformed }
                }
              }
              return block
            })
            return messageModified ? { ...message, content: nextContent } : message
          })
        }

        if (modified) {
          modifiedInit = { ...init, body: JSON.stringify(parsed) }
        }
      } catch {
        // Not JSON or parse error, use original body
      }
    }

    const response = await globalThis.fetch(requestUrl.toString(), modifiedInit)

    // Transform tool names back in response
    const contentType = response.headers.get('content-type') || ''
    if (contentType.includes('application/json') && !contentType.includes('stream')) {
      const text = await response.text()
      const decodedHeaders = cloneHeadersForDecodedBody(response.headers)
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>
        let modified = false

        // Transform tool_use names in content array
        if (parsed.content && Array.isArray(parsed.content)) {
          parsed.content = (parsed.content as Array<{ type?: string; name?: string }>).map(block => {
            if (block.type === 'tool_use' && block.name) {
              const original = reverseToolNameForRequest(block.name, renamedTools, trackedRequestTools)
              if (original !== block.name) modified = true
              return { ...block, name: original }
            }
            return block
          })
        }

        const newBody = modified ? JSON.stringify(parsed) : text
        return new Response(newBody, {
          status: response.status,
          statusText: response.statusText,
          headers: decodedHeaders
        })
      } catch {
        // Return a fresh Response with the buffered text instead of the already-drained original
        return new Response(text, {
          status: response.status,
          statusText: response.statusText,
          headers: decodedHeaders
        })
      }
    }

    // For streaming responses, transform tool names on the fly
    if (response.body && (contentType.includes('text/event-stream') || contentType.includes('stream'))) {
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      const encoder = new TextEncoder()
      let buffer = ''

      const stream = new ReadableStream({
        async pull(controller) {
          const { done, value } = await reader.read()
          if (done) {
            buffer += decoder.decode()
            if (buffer.length > 0) {
              const flushed = transformSseEvent(buffer, renamedTools, trackedRequestTools)
              controller.enqueue(encoder.encode(flushed))
              buffer = ''
            }
            controller.close()
            return
          }

          buffer += decoder.decode(value, { stream: true })
          const events = buffer.split(/\r?\n\r?\n/)
          buffer = events.pop() ?? ''
          if (events.length > 0) {
            const transformed = events
              .map(event => transformSseEvent(event, renamedTools, trackedRequestTools))
              .join('\n\n') + '\n\n'
            controller.enqueue(encoder.encode(transformed))
          }
        },
        async cancel(reason) {
          await reader.cancel(reason)
        }
      })

      return new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: cloneHeadersForDecodedBody(response.headers)
      })
    }

    return response
  }
}

// OAuth token refresh constants
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const OAUTH_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token'
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000 // Refresh 5 min before expiry

interface OAuthCredentials {
  accessToken: string
  refreshToken: string
  expiresAt: number
  apiKey?: string
}

interface ClaudeCodeCredentials {
  claudeAiOauth?: OAuthCredentials
}

// macOS Keychain service names (current first, then legacy)
const KEYCHAIN_SERVICE_NAMES = [
  'Claude Code-credentials',
  'Claude Code - credentials',
  'Claude Code',
]

type CredentialSource = 'claude-code-keychain' | 'claude-code'

function loadKeychainCredentials(): { creds: OAuthCredentials; source: CredentialSource } | null {
  for (const service of KEYCHAIN_SERVICE_NAMES) {
    try {
      const stdout = execFileSync('security', ['find-generic-password', '-s', service, '-w'], {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const data = JSON.parse(stdout.trim())
      if (typeof data !== 'object' || data === null || Array.isArray(data)) continue
      const oauth = (data as ClaudeCodeCredentials).claudeAiOauth
      if (oauth?.accessToken) return { creds: oauth, source: 'claude-code-keychain' }
    } catch { continue }
  }
  return null
}

function loadFileCredentials(): { creds: OAuthCredentials; source: CredentialSource } | null {
  const path = join(homedir(), '.claude', '.credentials.json')
  if (!existsSync(path)) return null
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8')) as ClaudeCodeCredentials
    if (data.claudeAiOauth?.accessToken) return { creds: data.claudeAiOauth, source: 'claude-code' }
  } catch { /* fall through */ }
  return null
}

export function loadCredentials(): { creds: OAuthCredentials; source: CredentialSource } | null {
  if (platform() === 'darwin') {
    const keychain = loadKeychainCredentials()
    if (keychain) return keychain
  }
  return loadFileCredentials()
}

function saveKeychainCredentials(creds: OAuthCredentials): void {
  try {
    const service = KEYCHAIN_SERVICE_NAMES[0]
    let existing: Record<string, unknown> = {}
    try {
      const stdout = execFileSync('security', ['find-generic-password', '-s', service, '-w'], {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const data = JSON.parse(stdout.trim())
      if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
        existing = data as Record<string, unknown>
      }
    } catch { /* start fresh */ }

    existing.claudeAiOauth = creds
    const payload = JSON.stringify(existing)
    const user = userInfo().username

    execFileSync('security', [
      'add-generic-password', '-s', service, '-a', user, '-w', payload, '-U',
    ], {
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch (e) {
    console.error('[claude-memory] Failed to save credentials to Keychain:', e)
  }
}

function saveFileCredentials(creds: OAuthCredentials): void {
  const credPath = join(homedir(), '.claude', '.credentials.json')
  const tmpPath = join(
    dirname(credPath),
    `.${basename(credPath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  )
  try {
    mkdirSync(dirname(credPath), { recursive: true })
    let existing: ClaudeCodeCredentials = {}
    try {
      existing = JSON.parse(readFileSync(credPath, 'utf-8')) as ClaudeCodeCredentials
    } catch { /* start fresh */ }
    existing.claudeAiOauth = creds
    writeFileSync(tmpPath, JSON.stringify(existing, null, 2), { encoding: 'utf-8', flag: 'wx', mode: 0o600 })
    renameSync(tmpPath, credPath)
  } catch (e) {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath)
    } catch {
      // ignore cleanup failure
    }
    console.error('[claude-memory] Failed to save refreshed credentials:', e)
  }
}

function saveCredentials(creds: OAuthCredentials, source: CredentialSource): void {
  if (source === 'claude-code-keychain') {
    saveKeychainCredentials(creds)
  } else {
    saveFileCredentials(creds)
  }
}

async function refreshAccessToken(refreshToken: string): Promise<OAuthCredentials | null> {
  try {
    const response = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: OAUTH_CLIENT_ID
      })
    })

    if (!response.ok) {
      console.error('[claude-memory] Token refresh failed:', await response.text())
      return null
    }

    const data = await response.json() as {
      access_token: string
      refresh_token: string
      expires_in: number
    }

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000
    }
  } catch (e) {
    console.error('[claude-memory] Token refresh error:', e)
    return null
  }
}

const OAUTH_REFRESH_LOCK_MAX_WAIT_MS = 10_000
const OAUTH_REFRESH_LOCK_RETRY_MS = 100
let inFlightOAuthRefresh: Promise<{ creds: OAuthCredentials; source: CredentialSource } | null> | null = null

function sleepAsync(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isCredentialsFresh(creds: OAuthCredentials): boolean {
  return Boolean(creds.apiKey) || creds.expiresAt >= Date.now() + TOKEN_REFRESH_BUFFER_MS
}

async function acquireOAuthRefreshLockAsync(
  lockPath: string,
  maxWaitMs: number,
  retryDelayMs: number
): Promise<
  | { status: 'acquired'; lockHandle: NonNullable<ReturnType<typeof acquireFileLock>> }
  | { status: 'fresh'; loaded: { creds: OAuthCredentials; source: CredentialSource } }
  | { status: 'timeout' }
> {
  const deadline = Date.now() + maxWaitMs

  while (true) {
    let lockHandle: ReturnType<typeof acquireFileLock> = null
    try {
      lockHandle = acquireFileLock(lockPath, {
        staleAfterMs: 60_000,
        staleStrategy: 'pid',
        ensureDir: true,
        proceedOnError: false,
        write: { data: () => `${process.pid}\n${Date.now()}`, ignoreErrors: true }
      })
    } catch (error) {
      console.error('[claude-memory] Failed to acquire OAuth refresh lock:', error)
      return { status: 'timeout' }
    }

    if (lockHandle) {
      return { status: 'acquired', lockHandle }
    }

    const reloaded = loadCredentials()
    if (reloaded && isCredentialsFresh(reloaded.creds)) {
      return { status: 'fresh', loaded: reloaded }
    }

    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      return { status: 'timeout' }
    }

    await sleepAsync(Math.min(retryDelayMs, remainingMs))
  }
}

export async function getFreshCredentials(options?: {
  lockMaxWaitMs?: number
  lockRetryMs?: number
}): Promise<{ creds: OAuthCredentials; source: CredentialSource } | null> {
  const loaded = loadCredentials()
  if (!loaded) return null

  // If we have an API key or unexpired access token, return as-is.
  if (isCredentialsFresh(loaded.creds)) return loaded

  // Coalesce concurrent refreshes within the same process so we never deadlock
  // our own event loop on the cross-process file lock or double-spend a refresh token.
  if (inFlightOAuthRefresh) {
    return inFlightOAuthRefresh
  }

  const refreshPromise = (async (): Promise<{ creds: OAuthCredentials; source: CredentialSource } | null> => {
    let { creds, source } = loaded
    const lockPath = join(LOCKS_DIR, 'oauth-refresh.lock')
    const acquisition = await acquireOAuthRefreshLockAsync(
      lockPath,
      options?.lockMaxWaitMs ?? OAUTH_REFRESH_LOCK_MAX_WAIT_MS,
      options?.lockRetryMs ?? OAUTH_REFRESH_LOCK_RETRY_MS
    )

    if (acquisition.status === 'fresh') {
      return acquisition.loaded
    }
    if (acquisition.status === 'timeout') {
      // One final check in case the holder just finished writing refreshed creds.
      const finalCheck = loadCredentials()
      if (finalCheck && isCredentialsFresh(finalCheck.creds)) {
        return finalCheck
      }
      console.error('[claude-memory] Timed out waiting for OAuth refresh lock; refusing unlocked token refresh')
      return null
    }

    try {
      // Re-read after acquiring lock in case another process already refreshed.
      const reloaded = loadCredentials()
      if (reloaded) {
        creds = reloaded.creds
        source = reloaded.source
        if (isCredentialsFresh(creds)) {
          return { creds, source }
        }
      }

      const refreshed = await refreshAccessToken(creds.refreshToken)
      if (!refreshed) return null

      saveCredentials(refreshed, source)
      creds = refreshed
      return { creds, source }
    } finally {
      acquisition.lockHandle.release()
    }
  })()

  inFlightOAuthRefresh = refreshPromise
  try {
    return await refreshPromise
  } finally {
    if (inFlightOAuthRefresh === refreshPromise) {
      inFlightOAuthRefresh = null
    }
  }
}

export async function createAnthropicClient(): Promise<Anthropic | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.OPENCODE_API_KEY
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN
  const baseURL = process.env.ANTHROPIC_BASE_URL

  // Try API key first (standard auth)
  if (apiKey) {
    return new Anthropic({
      apiKey,
      ...(baseURL ? { baseURL } : {})
    })
  }

  // Try explicit auth token from env
  if (authToken) {
    return new Anthropic({
      authToken,
      defaultHeaders: {
        // Include claude-code beta since we use the Claude Code system prompt
        'anthropic-beta': OAUTH_BETAS_WITH_CLAUDE_CODE,
        'user-agent': OAUTH_USER_AGENT
      },
      // Use OAuth fetch wrapper to add ?beta=true and transform tool names
      fetch: createOAuthFetch(),
      ...(baseURL ? { baseURL } : {})
    })
  }

  // Fall back to credentials with auto-refresh
  const fresh = await getFreshCredentials()
  if (!fresh) return null

  const { creds } = fresh

  // If credentials have a minted API key, use that
  if (creds.apiKey) {
    return new Anthropic({
      apiKey: creds.apiKey,
      ...(baseURL ? { baseURL } : {})
    })
  }

  // Use OAuth access token with required headers
  return new Anthropic({
    authToken: creds.accessToken,
    defaultHeaders: {
      // Include claude-code beta since we use the Claude Code system prompt
      'anthropic-beta': OAUTH_BETAS_WITH_CLAUDE_CODE,
      'user-agent': OAUTH_USER_AGENT
    },
    // Use OAuth fetch wrapper to add ?beta=true and transform tool names
    fetch: createOAuthFetch(),
    ...(baseURL ? { baseURL } : {})
  })
}
