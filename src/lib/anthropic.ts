import Anthropic from '@anthropic-ai/sdk'
import { execFileSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { homedir, platform, userInfo } from 'os'
import { join } from 'path'

// OAuth subscription auth constants (aligned with OpenCode auth plugin)
const OAUTH_BETAS = 'oauth-2025-04-20,interleaved-thinking-2025-05-14'
const OAUTH_BETAS_WITH_CLAUDE_CODE = 'oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14'
const OAUTH_USER_AGENT = 'claude-cli/2.1.2 (external, cli)'
// This MUST be sent as the first system message for OAuth to work
export const CLAUDE_CODE_SYSTEM_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude."

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

function mutateToolUseNames(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  let changed = false

  if (Array.isArray(value)) {
    for (const entry of value) {
      if (mutateToolUseNames(entry)) changed = true
    }
    return changed
  }

  const record = value as Record<string, unknown>
  if (record.type === 'tool_use' && typeof record.name === 'string') {
    const original = reverseToolNameTransform(record.name)
    if (original !== record.name) {
      record.name = original
      changed = true
    }
  }

  for (const key of Object.keys(record)) {
    if (mutateToolUseNames(record[key])) changed = true
  }

  return changed
}

function transformSseEvent(event: string): string {
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
      if (mutateToolUseNames(parsed)) {
        return `${prefix}${JSON.stringify(parsed)}`
      }
      return line
    } catch {
      return line
    }
  })
  return transformed.join('\n')
}

/**
 * Create a fetch wrapper for OAuth requests that:
 * 1. Adds ?beta=true to /v1/messages requests
 * 2. Transforms tool names to satisfy OAuth validation (capitalize first letter)
 * 3. Transforms tool names back in responses
 */
function createOAuthFetch(): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
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

    // Transform tool names in request body
    let modifiedInit = init
    if (init?.body && typeof init.body === 'string') {
      try {
        const parsed = JSON.parse(init.body) as Record<string, unknown>
        let modified = false

        // Transform tools array
        if (parsed.tools && Array.isArray(parsed.tools)) {
          parsed.tools = (parsed.tools as Array<{ name?: string }>).map(tool => {
            if (tool.name) {
              const transformed = transformToolNameForOAuth(tool.name)
              if (transformed !== tool.name) modified = true
              return { ...tool, name: transformed }
            }
            return tool
          })
        }

        // Transform tool_choice.name if present
        const toolChoice = parsed.tool_choice as { name?: string } | undefined
        if (toolChoice?.name) {
          const transformed = transformToolNameForOAuth(toolChoice.name)
          if (transformed !== toolChoice.name) {
            parsed.tool_choice = { ...toolChoice, name: transformed }
            modified = true
          }
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
      try {
        const text = await response.text()
        const parsed = JSON.parse(text) as Record<string, unknown>
        let modified = false

        // Transform tool_use names in content array
        if (parsed.content && Array.isArray(parsed.content)) {
          parsed.content = (parsed.content as Array<{ type?: string; name?: string }>).map(block => {
            if (block.type === 'tool_use' && block.name) {
              const original = reverseToolNameTransform(block.name)
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
          headers: response.headers
        })
      } catch {
        // Parse error, return original
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
            if (buffer.length > 0) {
              const flushed = transformSseEvent(buffer)
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
            const transformed = events.map(transformSseEvent).join('\n\n') + '\n\n'
            controller.enqueue(encoder.encode(transformed))
          }
        }
      })

      return new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
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
  try {
    const path = join(homedir(), '.claude', '.credentials.json')
    let existing: ClaudeCodeCredentials = {}
    try {
      existing = JSON.parse(readFileSync(path, 'utf-8')) as ClaudeCodeCredentials
    } catch { /* start fresh */ }
    existing.claudeAiOauth = creds
    writeFileSync(path, JSON.stringify(existing, null, 2))
  } catch (e) {
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

async function getFreshCredentials(): Promise<{ creds: OAuthCredentials; source: CredentialSource } | null> {
  const loaded = loadCredentials()
  if (!loaded) return null

  let { creds, source } = loaded

  // If we have an API key, return as-is
  if (creds.apiKey) return { creds, source }

  // Refresh if expired or near expiry
  if (creds.expiresAt < Date.now() + TOKEN_REFRESH_BUFFER_MS) {
    const refreshed = await refreshAccessToken(creds.refreshToken)
    if (!refreshed) return null

    saveCredentials(refreshed, source)
    creds = refreshed
  }

  return { creds, source }
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
