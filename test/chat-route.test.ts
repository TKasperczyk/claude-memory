import fs from 'fs'
import os from 'os'
import path from 'path'
import express from 'express'
import request from 'supertest'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mockState = vi.hoisted(() => ({
  capturedCalls: [] as Array<Record<string, unknown>>,
  streams: [] as Array<Array<Record<string, unknown>>>
}))

vi.mock('../src/lib/anthropic.js', () => ({
  CLAUDE_CODE_SYSTEM_PROMPT: 'Claude Code system prompt',
  createAnthropicClient: vi.fn(async () => ({
    messages: {
      create: vi.fn(async (params: Record<string, unknown>) => {
        mockState.capturedCalls.push(structuredClone(params))
        const events = mockState.streams.shift() ?? []
        return {
          async *[Symbol.asyncIterator]() {
            for (const event of events) yield event
          }
        }
      })
    }
  }))
}))

vi.mock('../src/lib/settings.js', () => ({
  loadSettings: vi.fn(() => ({
    chatModel: 'claude-fable-5-2',
    minScore: 0.5,
    minSemanticSimilarity: 0.4,
    maxRecords: 5,
    maxTokens: 2000,
    mmrLambda: 0.7,
    keywordBonus: 0.1,
    projectMatchBonus: 0.1,
    usageRatioWeight: 0.1,
    enableHaikuRetrieval: false
  }))
}))

vi.mock('../src/lib/memory-stats.js', () => ({
  buildMemoryStats: vi.fn(async () => ({
    total: 10,
    deprecated: 1,
    byType: { discovery: 10 },
    byScope: { project: 10 },
    avgRetrievalCount: 1,
    avgUsageRatio: 0.5
  }))
}))

vi.mock('../src/lib/token-usage-events.js', () => ({
  recordTokenUsageEventsAsync: vi.fn()
}))

vi.mock('../dashboard/server/lib/chat-tools.js', () => ({
  CHAT_TOOLS: [{ name: 'search_memories', description: 'search', input_schema: { type: 'object', properties: {} } }],
  executeChatTool: vi.fn(async () => ({ result: { ok: true }, isError: false }))
}))

vi.mock('../dashboard/server/utils/lancedb.js', () => ({
  ensureConfigInitialized: vi.fn(async (_req: unknown, baseConfig: unknown) => baseConfig)
}))

import { DEFAULT_CONFIG } from '../src/lib/types.js'
import { recordTokenUsageEventsAsync } from '../src/lib/token-usage-events.js'
import { executeChatTool } from '../dashboard/server/lib/chat-tools.js'
import { createChatRouter } from '../dashboard/server/routes/chat.js'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-memory-chat-route-test-'))

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe('POST /api/chat route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockState.capturedCalls = []
    mockState.streams = []
  })

  it('preserves signed thinking blocks, drops unsigned thinking blocks, caches static prompt, records chat tokens, and canonicalizes project', async () => {
    const realProj = path.join(tempDir, 'real-proj')
    const linkProj = path.join(tempDir, 'link-proj')
    fs.mkdirSync(realProj, { recursive: true })
    fs.symlinkSync(realProj, linkProj)
    const canonicalRealProj = fs.realpathSync(realProj)

    mockState.streams = [
      // Turn 1: signed thinking + unsigned thinking + redacted_thinking + tool_use
      [
        {
          type: 'message_start',
          message: { usage: { input_tokens: 120, output_tokens: 10, cache_creation_input_tokens: 50, cache_read_input_tokens: 0 } }
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Reasoning step' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig_valid_123' } },
        { type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: 'Unsigned draft' } },
        { type: 'content_block_start', index: 2, content_block: { type: 'redacted_thinking', data: 'opaque_blob' } },
        { type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 'tu_1', name: 'search_memories', input: {} } },
        { type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '{"query":"foo"}' } },
        { type: 'message_delta', usage: { output_tokens: 45 } }
      ],
      // Turn 2: final answer
      [
        {
          type: 'message_start',
          message: { usage: { input_tokens: 200, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 150 } }
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Done!' } },
        { type: 'message_delta', usage: { output_tokens: 20 } }
      ]
    ]

    const app = express()
    app.use(express.json())
    app.use(createChatRouter({
      configRoot: tempDir,
      installationRoot: tempDir,
      config: DEFAULT_CONFIG,
      memoryTypes: ['command', 'error', 'discovery', 'procedure', 'warning'],
      suggestionAllowedRoots: [tempDir],
      claudeSettingsPath: path.join(tempDir, 'settings.json'),
      claudeConfigPath: path.join(tempDir, 'claude.json')
    }))

    const res = await request(app)
      .post('/api/chat')
      .send({
        project: linkProj,
        messages: [{ role: 'user', content: 'Find foo' }]
      })

    expect(res.status).toBe(200)
    expect(res.text).toContain('event: done')
    expect(mockState.capturedCalls).toHaveLength(2)

    // Turn 1 checks: cache_control on static prompt, thinking headroom on claude-fable-5-2, canonicalized project
    const turn1 = mockState.capturedCalls[0]
    expect(turn1.max_tokens).toBe(26000)
    const systemBlocks = turn1.system as Array<Record<string, unknown>>
    expect(systemBlocks[1]).toMatchObject({ cache_control: { type: 'ephemeral' } })
    expect(String(systemBlocks[2]?.text)).toContain(canonicalRealProj)

    // Tool execution received canonicalized project
    expect(executeChatTool).toHaveBeenCalledWith(
      'search_memories',
      { query: 'foo' },
      expect.objectContaining({ project: canonicalRealProj })
    )

    // Turn 2 checks: signed thinking + redacted_thinking + tool_use preserved, unsigned thinking dropped!
    const turn2Messages = mockState.capturedCalls[1].messages as Array<{ role: string; content: unknown }>
    const assistantBlocks = turn2Messages[1].content as Array<Record<string, unknown>>
    expect(assistantBlocks).toEqual([
      { type: 'thinking', thinking: 'Reasoning step', signature: 'sig_valid_123' },
      { type: 'redacted_thinking', data: 'opaque_blob' },
      { type: 'tool_use', id: 'tu_1', name: 'search_memories', input: { query: 'foo' } }
    ])

    // Token usage recorded for both turns with source='chat'
    expect(recordTokenUsageEventsAsync).toHaveBeenCalledTimes(2)
    expect(recordTokenUsageEventsAsync).toHaveBeenNthCalledWith(
      1,
      [expect.objectContaining({ source: 'chat', model: 'claude-fable-5-2', inputTokens: 120, outputTokens: 45, cacheCreationInputTokens: 50 })],
      { collection: DEFAULT_CONFIG.lancedb.table }
    )
    expect(recordTokenUsageEventsAsync).toHaveBeenNthCalledWith(
      2,
      [expect.objectContaining({ source: 'chat', model: 'claude-fable-5-2', inputTokens: 200, outputTokens: 20, cacheReadInputTokens: 150 })],
      { collection: DEFAULT_CONFIG.lancedb.table }
    )
  })
})
