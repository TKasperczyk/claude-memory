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

function configWithExtractionModel(model: string, maxTokens = DEFAULT_CONFIG.extraction.maxTokens) {
  return {
    ...DEFAULT_CONFIG,
    extraction: {
      ...DEFAULT_CONFIG.extraction,
      model,
      maxTokens
    }
  }
}

function extractionToolResponse() {
  return {
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
  }
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
    mockedFinalMessage.mockResolvedValueOnce(extractionToolResponse())

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

  it('classifies refusal stop reasons as api_error failures', async () => {
    mockedFinalMessage.mockResolvedValueOnce({
      stop_reason: 'refusal',
      usage: {
        input_tokens: 8,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0
      },
      content: []
    })

    const result = await extractRecords(minimalTranscript, {
      sessionId: 'session-refusal',
      cwd: '/tmp/project',
      project: '/tmp/project'
    }, configWithExtractionModel('claude-fable-5'))

    expect(result.records).toEqual([])
    expect(result.tokenUsage.inputTokens).toBe(8)
    expect(result.error).toEqual({
      kind: 'api_error',
      code: 'refusal',
      message: 'Anthropic refused to perform extraction.'
    })
  })

  it('omits temperature for extraction requests', async () => {
    mockedFinalMessage.mockResolvedValueOnce(extractionToolResponse())

    await extractRecords(minimalTranscript, {
      sessionId: 'session-opus',
      cwd: '/tmp/project',
      project: '/tmp/project'
    }, configWithExtractionModel('claude-opus-4-8'))

    const request = mockedStream.mock.calls[0][0]
    expect(request.model).toBe('claude-opus-4-8')
    expect(request.max_tokens).toBe(128000)
    expect(request).not.toHaveProperty('temperature')
  })

  it('also omits temperature for Sonnet extraction requests', async () => {
    mockedFinalMessage.mockResolvedValueOnce(extractionToolResponse())

    await extractRecords(minimalTranscript, {
      sessionId: 'session-sonnet',
      cwd: '/tmp/project',
      project: '/tmp/project'
    }, configWithExtractionModel('claude-sonnet-4-6'))

    const request = mockedStream.mock.calls[0][0]
    expect(request.model).toBe('claude-sonnet-4-6')
    expect(request.max_tokens).toBe(64000)
    expect(request).not.toHaveProperty('temperature')
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
    expect(mockedCreate.mock.calls[0][0]).not.toHaveProperty('temperature')
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

  it('treats refusal as no helpful memories for usefulness rating', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockedCreate.mockResolvedValueOnce({
      stop_reason: 'refusal',
      usage: {
        input_tokens: 7,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0
      },
      content: []
    })

    try {
      const result = await rateInjectedMemories(
        minimalTranscript,
        [{ id: 'mem-1', snippet: 'useful memory', injectedAt: Date.now() }],
        configWithExtractionModel('claude-fable-5'),
        { sessionId: 'session-1', runId: 'run-1' }
      )

      expect(result.helpfulIds).toEqual([])
      expect(result.tokenUsage.inputTokens).toBe(7)
    } finally {
      consoleWarn.mockRestore()
    }
  })
})
