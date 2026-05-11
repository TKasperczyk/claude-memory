import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAnthropicClient } from '../src/lib/anthropic.js'
import { extractRecords } from '../src/lib/extract.js'
import { emptyTokenUsage } from '../src/lib/token-usage.js'
import { DEFAULT_CONFIG } from '../src/lib/types.js'
import type { Transcript } from '../src/lib/transcript.js'

vi.mock('../src/lib/anthropic.js', () => ({
  CLAUDE_CODE_SYSTEM_PROMPT: 'Claude Code system prompt',
  createAnthropicClient: vi.fn()
}))

const mockedCreateAnthropicClient = vi.mocked(createAnthropicClient)
const mockedStream = vi.fn()
const mockedFinalMessage = vi.fn()

const minimalTranscript: Transcript = {
  messages: [{ role: 'user', text: 'capture durable knowledge' }],
  events: [{ type: 'user', text: 'capture durable knowledge' }],
  toolCalls: [],
  toolResults: [],
  parseErrors: 0
}

beforeEach(() => {
  mockedCreateAnthropicClient.mockReset()
  mockedStream.mockReset()
  mockedFinalMessage.mockReset()
  mockedStream.mockReturnValue({ finalMessage: mockedFinalMessage })
  mockedCreateAnthropicClient.mockResolvedValue({
    messages: {
      stream: mockedStream
    }
  } as any)
})

describe('extractRecords', () => {
  it('classifies Anthropic rate limits as api_error failures', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const err = Object.assign(new Error('Rate limit exceeded'), {
      status: 429,
      error: { type: 'rate_limit_error' }
    })
    mockedFinalMessage.mockRejectedValueOnce(err)

    try {
      const result = await extractRecords(minimalTranscript, {
        sessionId: 'session-1',
        cwd: '/tmp/project',
        project: '/tmp/project'
      }, DEFAULT_CONFIG)

      expect(result.records).toEqual([])
      expect(result.tokenUsage).toEqual(emptyTokenUsage())
      expect(result.error?.kind).toBe('api_error')
      if (result.error?.kind !== 'api_error') throw new Error('expected api_error')
      expect(result.error.status).toBe(429)
      expect(result.error.code).toBe('rate_limit_error')
    } finally {
      consoleError.mockRestore()
    }
  })

  it('preserves error code when status is absent', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const err = Object.assign(new Error('socket hang up'), {
      code: 'ECONNRESET'
    })
    mockedFinalMessage.mockRejectedValueOnce(err)

    try {
      const result = await extractRecords(minimalTranscript, {
        sessionId: 'session-2',
        cwd: '/tmp/project',
        project: '/tmp/project'
      }, DEFAULT_CONFIG)

      expect(result.records).toEqual([])
      expect(result.error?.kind).toBe('api_error')
      if (result.error?.kind !== 'api_error') throw new Error('expected api_error')
      expect(result.error.status).toBeUndefined()
      expect(result.error.code).toBe('ECONNRESET')
      expect(result.error.message).toBe('socket hang up')
    } finally {
      consoleError.mockRestore()
    }
  })
})
