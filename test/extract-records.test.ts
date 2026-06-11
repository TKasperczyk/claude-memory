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
      error: { type: 'rate_limit_error' },
      requestID: 'req_rate_limit'
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
      expect(result.error.requestId).toBe('req_rate_limit')
    } finally {
      consoleError.mockRestore()
    }
  })

  it('preserves requestID for streaming errors without status', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const err = Object.assign(new Error('stream disconnected'), {
      error: { type: 'api_error' },
      requestID: 'req_stream'
    })
    mockedFinalMessage.mockRejectedValueOnce(err)

    try {
      const result = await extractRecords(minimalTranscript, {
        sessionId: 'session-stream',
        cwd: '/tmp/project',
        project: '/tmp/project'
      }, DEFAULT_CONFIG)

      expect(result.records).toEqual([])
      expect(result.error?.kind).toBe('api_error')
      if (result.error?.kind !== 'api_error') throw new Error('expected api_error')
      expect(result.error.status).toBeUndefined()
      expect(result.error.code).toBe('api_error')
      expect(result.error.requestId).toBe('req_stream')
    } finally {
      consoleError.mockRestore()
    }
  })

  it('does not set requestId when SDK requestID is null', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const err = Object.assign(new Error('socket hang up'), {
      code: 'ECONNRESET',
      requestID: null
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
      expect(result.error.requestId).toBeUndefined()
    } finally {
      consoleError.mockRestore()
    }
  })
})
