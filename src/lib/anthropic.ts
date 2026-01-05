import Anthropic from '@anthropic-ai/sdk'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// OAuth subscription auth constants (same as kira-runtime)
const OAUTH_BETAS = 'oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14'
const OAUTH_USER_AGENT = 'ai/5.0.97 ai-sdk/provider-utils/3.0.18 runtime/bun/1.3.3'
// This MUST be sent as the first system message for OAuth to work
export const CLAUDE_CODE_SYSTEM_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude."

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

function loadCredentials(): { creds: OAuthCredentials; source: 'kira' | 'claude-code' } | null {
  // Try Claude Code credentials first (usually fresh from active session)
  const claudeCodePath = join(homedir(), '.claude', '.credentials.json')
  if (existsSync(claudeCodePath)) {
    try {
      const data = JSON.parse(readFileSync(claudeCodePath, 'utf-8')) as ClaudeCodeCredentials
      if (data.claudeAiOauth) return { creds: data.claudeAiOauth, source: 'claude-code' }
    } catch { /* fall through */ }
  }

  // Fall back to kira-runtime credentials
  const kiraPath = join(homedir(), '.kira', 'credentials.json')
  if (existsSync(kiraPath)) {
    try {
      const creds = JSON.parse(readFileSync(kiraPath, 'utf-8')) as OAuthCredentials
      if (creds.accessToken) return { creds, source: 'kira' }
    } catch { /* fall through */ }
  }

  return null
}

function saveCredentials(creds: OAuthCredentials, source: 'kira' | 'claude-code'): void {
  try {
    if (source === 'claude-code') {
      const path = join(homedir(), '.claude', '.credentials.json')
      let existing: ClaudeCodeCredentials = {}
      try {
        existing = JSON.parse(readFileSync(path, 'utf-8')) as ClaudeCodeCredentials
      } catch { /* start fresh */ }
      existing.claudeAiOauth = creds
      writeFileSync(path, JSON.stringify(existing, null, 2))
    } else {
      const path = join(homedir(), '.kira', 'credentials.json')
      writeFileSync(path, JSON.stringify(creds, null, 2))
    }
  } catch (e) {
    console.error('[claude-memory] Failed to save refreshed credentials:', e)
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

async function getFreshCredentials(): Promise<{ creds: OAuthCredentials; source: 'kira' | 'claude-code' } | null> {
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
        'anthropic-beta': OAUTH_BETAS,
        'user-agent': OAUTH_USER_AGENT
      },
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
      'anthropic-beta': OAUTH_BETAS,
      'user-agent': OAUTH_USER_AGENT
    },
    ...(baseURL ? { baseURL } : {})
  })
}
