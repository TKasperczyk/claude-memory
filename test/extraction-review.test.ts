import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAnthropicClient } from '../src/lib/anthropic.js'
import { getExtractionRun } from '../src/lib/extraction-log.js'
import { reviewExtraction } from '../src/lib/extraction-review.js'
import { fetchRecordsByIds } from '../src/lib/lancedb.js'
import { loadMemoryWriteHints } from '../src/lib/memory-write-hints.js'
import { loadSettings } from '../src/lib/settings.js'
import { DEFAULT_CONFIG, type MemoryWriteHintEvent } from '../src/lib/types.js'
import { createMockDiscoveryRecord } from './helpers.js'

vi.mock('../src/lib/anthropic.js', () => ({
  CLAUDE_CODE_SYSTEM_PROMPT: 'Claude Code system prompt',
  createAnthropicClient: vi.fn()
}))

vi.mock('../src/lib/extraction-log.js', () => ({
  getExtractionRun: vi.fn()
}))

vi.mock('../src/lib/embed.js', () => ({
  embedBatch: vi.fn()
}))

vi.mock('../src/lib/lancedb.js', () => ({
  escapeFilterValue: vi.fn((value: string) => value),
  fetchRecordsByIds: vi.fn(),
  vectorSearchSimilar: vi.fn()
}))

vi.mock('../src/lib/memory-write-hints.js', () => ({
  loadMemoryWriteHints: vi.fn()
}))

vi.mock('../src/lib/settings.js', () => ({
  loadSettings: vi.fn()
}))

const mockedCreateAnthropicClient = vi.mocked(createAnthropicClient)
const mockedGetExtractionRun = vi.mocked(getExtractionRun)
const mockedFetchRecordsByIds = vi.mocked(fetchRecordsByIds)
const mockedLoadMemoryWriteHints = vi.mocked(loadMemoryWriteHints)
const mockedLoadSettings = vi.mocked(loadSettings)
const mockedCreate = vi.fn()

function runWithHints(memoryWriteHints?: MemoryWriteHintEvent[]) {
  return {
    runId: 'review-run',
    sessionId: 'review-session',
    transcriptPath: '/definitely/missing/review-transcript.jsonl',
    timestamp: 100,
    recordCount: 1,
    parseErrorCount: 0,
    extractedRecordIds: ['record-1'],
    duration: 10,
    memoryWriteHints
  }
}

beforeEach(() => {
  mockedCreateAnthropicClient.mockReset()
  mockedGetExtractionRun.mockReset()
  mockedFetchRecordsByIds.mockReset()
  mockedLoadMemoryWriteHints.mockReset()
  mockedLoadSettings.mockReset()
  mockedCreate.mockReset()

  mockedLoadSettings.mockReturnValue({
    reviewModel: 'claude-sonnet-4-6',
    reviewSimilarThreshold: 0.7,
    reviewDuplicateWarningThreshold: 0.9
  } as ReturnType<typeof loadSettings>)
  mockedFetchRecordsByIds.mockResolvedValue([
    createMockDiscoveryRecord({ id: 'record-1', sourceExcerpt: undefined })
  ])
  mockedCreate.mockResolvedValue({
    content: [{
      type: 'tool_use',
      id: 'review-tool-use',
      name: 'emit_review',
      input: {
        overallRating: 'good',
        accuracyScore: 100,
        issues: [],
        summary: 'Grounded extraction.'
      }
    }]
  })
  mockedCreateAnthropicClient.mockResolvedValue({
    messages: { create: mockedCreate }
  } as any)
})

describe('extraction review memory_write evidence', () => {
  it('uses an empty evidence set instead of later live session hints when the run persisted none', async () => {
    mockedGetExtractionRun.mockReturnValue(runWithHints())
    mockedLoadMemoryWriteHints.mockReturnValue([{
      sessionId: 'review-session',
      timestamp: 200,
      name: 'Later live hint',
      content: 'This evidence belongs to a later run.'
    }])

    await reviewExtraction('review-run', DEFAULT_CONFIG)

    const request = mockedCreate.mock.calls[0][0] as { messages: Array<{ content: string }> }
    expect(mockedLoadMemoryWriteHints).not.toHaveBeenCalled()
    expect(request.messages[0].content).not.toContain('Native memory_write priority anchors:')
    expect(request.messages[0].content).not.toContain('This evidence belongs to a later run.')
  })

  it('embeds only the bounded recent subset of hints persisted on the reviewed run', async () => {
    const memoryWriteHints = Array.from({ length: 101 }, (_, index): MemoryWriteHintEvent => ({
      sessionId: 'review-session',
      timestamp: index,
      name: `review-hint-${index}`
    }))
    mockedGetExtractionRun.mockReturnValue(runWithHints(memoryWriteHints))

    await reviewExtraction('review-run', DEFAULT_CONFIG)

    const request = mockedCreate.mock.calls[0][0] as { messages: Array<{ content: string }> }
    const prompt = request.messages[0].content
    expect(prompt).toContain('"name": "review-hint-100"')
    expect(prompt).not.toContain('"name": "review-hint-0"')
    expect(prompt).toContain('Note: 1 older memory_write hint was omitted due to prompt limits.')
  })
})
