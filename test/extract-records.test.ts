import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAnthropicClient } from '../src/lib/anthropic.js'
import { extractRecords, rateInjectedMemories } from '../src/lib/extract.js'
import { emptyTokenUsage } from '../src/lib/token-usage.js'
import { recordTokenUsageEventsAsync } from '../src/lib/token-usage-events.js'
import { DEFAULT_CONFIG } from '../src/lib/types.js'
import type { Transcript } from '../src/lib/transcript.js'

vi.mock('../src/lib/anthropic.js', () => ({
  CLAUDE_CODE_SYSTEM_PROMPT: 'Claude Code system prompt',
  createAnthropicClient: vi.fn()
}))

vi.mock('../src/lib/token-usage-events.js', () => ({
  recordTokenUsageEventsAsync: vi.fn()
}))

const mockedCreateAnthropicClient = vi.mocked(createAnthropicClient)
const mockedRecordTokenUsageEventsAsync = vi.mocked(recordTokenUsageEventsAsync)
const mockedStream = vi.fn()
const mockedFinalMessage = vi.fn()
const mockedCreate = vi.fn()

const minimalTranscript: Transcript = {
  messages: [{ role: 'user', text: 'capture durable knowledge' }],
  events: [{ type: 'user', text: 'capture durable knowledge' }],
  toolCalls: [],
  toolResults: [],
  parseErrors: 0
}

beforeEach(() => {
  mockedCreateAnthropicClient.mockReset()
  mockedRecordTokenUsageEventsAsync.mockReset()
  mockedStream.mockReset()
  mockedFinalMessage.mockReset()
  mockedCreate.mockReset()
  mockedStream.mockReturnValue({ finalMessage: mockedFinalMessage })
  mockedCreateAnthropicClient.mockResolvedValue({
    messages: {
      stream: mockedStream,
      create: mockedCreate
    }
  } as any)
})

describe('extractRecords', () => {
  it('records extraction token usage with session and planned run ids', async () => {
    mockedFinalMessage.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      usage: {
        input_tokens: 11,
        output_tokens: 4,
        cache_creation_input_tokens: 1,
        cache_read_input_tokens: 2
      },
      content: [{
        type: 'tool_use',
        id: 'tool-1',
        name: 'emit_records',
        input: { records: [] }
      }]
    })

    const result = await extractRecords(minimalTranscript, {
      sessionId: 'session-1',
      runId: 'run-1',
      cwd: '/tmp/project',
      project: '/tmp/project'
    }, DEFAULT_CONFIG)

    expect(result.records).toEqual([])
    expect(mockedRecordTokenUsageEventsAsync).toHaveBeenCalledWith([
      expect.objectContaining({
        source: 'extraction',
        sessionId: 'session-1',
        runId: 'run-1',
        inputTokens: 11,
        outputTokens: 4,
        cacheCreationInputTokens: 1,
        cacheReadInputTokens: 2
      })
    ], { collection: DEFAULT_CONFIG.lancedb.table })
  })

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

describe('rateInjectedMemories', () => {
  it('records usefulness token usage with session and planned run ids', async () => {
    mockedCreate.mockResolvedValueOnce({
      usage: {
        input_tokens: 7,
        output_tokens: 2,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 1
      },
      content: [{
        type: 'tool_use',
        id: 'tool-1',
        name: 'emit_usefulness',
        input: { helpfulIds: ['mem-1'] }
      }]
    })

    const result = await rateInjectedMemories(
      minimalTranscript,
      [{ id: 'mem-1', snippet: 'useful memory', injectedAt: Date.now() }],
      DEFAULT_CONFIG,
      { sessionId: 'session-1', runId: 'run-1' }
    )

    expect(result.helpfulIds).toEqual(['mem-1'])
    expect(mockedRecordTokenUsageEventsAsync).toHaveBeenCalledWith([
      expect.objectContaining({
        source: 'usefulness-rating',
        sessionId: 'session-1',
        runId: 'run-1',
        inputTokens: 7,
        outputTokens: 2,
        cacheReadInputTokens: 1
      })
    ], { collection: DEFAULT_CONFIG.lancedb.table })
  })
})
