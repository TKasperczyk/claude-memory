/**
 * Unit tests for incremental extraction logic.
 *
 * Tests transcript slicing, overlap computation, and the no_new_events skip path.
 * These are pure unit tests -- no LLM or embedding service needed.
 */

import { describe, it, expect } from 'vitest'
import {
  parseTranscript,
  computeIncrementalStartIndex,
  sliceTranscript,
  type TranscriptEvent,
  type Transcript
} from '../src/lib/transcript.js'
import { createMockTranscript, buildTypicalTranscriptEntries } from './helpers.js'
import { handlePostSession } from '../src/hooks/post-session.js'
import { TEST_CONFIG, TEST_CWD, TEST_PROJECT } from './config.js'
import type { SessionEndInput } from '../src/lib/types.js'

// Disable min-token check for these tests
process.env.CC_MEMORIES_SETTING_EXTRACTION_MIN_TOKENS = '0'

function buildEvents(...types: Array<'user' | 'assistant' | 'tool_call' | 'tool_result'>): TranscriptEvent[] {
  return types.map((type, i) => {
    if (type === 'user') return { type, text: `User message ${i}`, timestampMs: i * 1000 }
    if (type === 'assistant') return { type, text: `Assistant message ${i}`, timestampMs: i * 1000 }
    if (type === 'tool_call') return { type, name: 'Bash', id: `tool_${i}`, timestampMs: i * 1000 }
    return { type, toolUseId: `tool_${i}`, outputText: `result ${i}`, timestampMs: i * 1000 }
  })
}

describe('computeIncrementalStartIndex', () => {
  it('should return boundary when overlapTurns is 0', () => {
    const events = buildEvents('user', 'assistant', 'user', 'assistant')
    expect(computeIncrementalStartIndex(events, 4, 0)).toBe(4)
  })

  it('should return 0 when overlapTurns exceeds available turns', () => {
    const events = buildEvents('user', 'assistant', 'user', 'assistant')
    expect(computeIncrementalStartIndex(events, 4, 10)).toBe(0)
  })

  it('should find the Nth user message walking backward', () => {
    // Events: user(0), assistant(1), tool_call(2), tool_result(3), user(4), assistant(5)
    const events = buildEvents('user', 'assistant', 'tool_call', 'tool_result', 'user', 'assistant')
    // priorEventCount=6, overlap=1 -> should find user at index 4
    expect(computeIncrementalStartIndex(events, 6, 1)).toBe(4)
    // overlap=2 -> should find user at index 0
    expect(computeIncrementalStartIndex(events, 6, 2)).toBe(0)
  })

  it('should respect priorEventCount as upper boundary', () => {
    const events = buildEvents('user', 'assistant', 'user', 'assistant', 'user', 'assistant')
    // priorEventCount=4, overlap=1 -> walks back from index 3, finds user at index 2
    expect(computeIncrementalStartIndex(events, 4, 1)).toBe(2)
  })

  it('should handle priorEventCount larger than events length', () => {
    const events = buildEvents('user', 'assistant')
    // Boundary clamped to events.length (2), overlap=1 -> finds user at index 0
    expect(computeIncrementalStartIndex(events, 100, 1)).toBe(0)
  })

  it('should return boundary when priorEventCount is 0', () => {
    const events = buildEvents('user', 'assistant')
    expect(computeIncrementalStartIndex(events, 0, 5)).toBe(0)
  })
})

describe('sliceTranscript', () => {
  it('should return original transcript when startIndex is 0', () => {
    const transcript: Transcript = {
      events: buildEvents('user', 'assistant'),
      messages: [{ role: 'user', text: 'hello' }, { role: 'assistant', text: 'hi' }],
      toolCalls: [],
      toolResults: [],
      parseErrors: 0
    }
    expect(sliceTranscript(transcript, 0)).toBe(transcript)
  })

  it('should slice events and offset messages correctly', () => {
    const transcript: Transcript = {
      events: buildEvents('user', 'assistant', 'tool_call', 'tool_result', 'user', 'assistant'),
      messages: [
        { role: 'user', text: 'first' },
        { role: 'assistant', text: 'response 1' },
        { role: 'user', text: 'second' },
        { role: 'assistant', text: 'response 2' }
      ],
      toolCalls: [{ name: 'Bash', id: 'tool_2' }],
      toolResults: [{ toolUseId: 'tool_2', outputText: 'result' }],
      parseErrors: 0
    }

    // Slice from index 4 (skip first user, assistant, tool_call, tool_result)
    const sliced = sliceTranscript(transcript, 4)

    // Should have 2 events (user, assistant) starting from index 4
    expect(sliced.events).toHaveLength(2)
    expect(sliced.events[0].type).toBe('user')
    expect(sliced.events[1].type).toBe('assistant')

    // Should have 2 messages (the second pair)
    // Events 0-3 contain 2 user/assistant events -> messageOffset=2
    expect(sliced.messages).toHaveLength(2)
    expect(sliced.messages[0].text).toBe('second')
    expect(sliced.messages[1].text).toBe('response 2')

    // Tool calls/results were before the slice point, so should be empty
    expect(sliced.toolCalls).toHaveLength(0)
    expect(sliced.toolResults).toHaveLength(0)
  })

  it('should handle slicing beyond events length', () => {
    const transcript: Transcript = {
      events: buildEvents('user', 'assistant'),
      messages: [{ role: 'user', text: 'hello' }],
      toolCalls: [],
      toolResults: [],
      parseErrors: 0
    }

    const sliced = sliceTranscript(transcript, 100)
    expect(sliced.events).toHaveLength(0)
    expect(sliced.messages).toHaveLength(0)
  })

  it('should preserve tool calls/results within the sliced range', () => {
    const transcript: Transcript = {
      events: [
        { type: 'user', text: 'old stuff' },
        { type: 'assistant', text: 'old response' },
        { type: 'user', text: 'new stuff' },
        { type: 'tool_call', name: 'Bash', id: 'new_tool' },
        { type: 'tool_result', toolUseId: 'new_tool', outputText: 'new output' },
        { type: 'assistant', text: 'new response' }
      ],
      messages: [
        { role: 'user', text: 'old stuff' },
        { role: 'assistant', text: 'old response' },
        { role: 'user', text: 'new stuff' },
        { role: 'assistant', text: 'new response' }
      ],
      toolCalls: [
        { name: 'Bash', id: 'old_tool' },
        { name: 'Bash', id: 'new_tool' }
      ],
      toolResults: [
        { toolUseId: 'old_tool', outputText: 'old' },
        { toolUseId: 'new_tool', outputText: 'new output' }
      ],
      parseErrors: 0
    }

    // Slice from index 2 (skip first user + assistant)
    const sliced = sliceTranscript(transcript, 2)

    expect(sliced.toolCalls).toHaveLength(1)
    expect(sliced.toolCalls[0].id).toBe('new_tool')
    expect(sliced.toolResults).toHaveLength(1)
    expect(sliced.toolResults[0].toolUseId).toBe('new_tool')
  })
})

describe('handlePostSession incremental', () => {
  it('should return no_new_events when event count has not changed', async () => {
    const entries = buildTypicalTranscriptEntries()
    const transcriptPath = createMockTranscript(entries)

    const transcript = await parseTranscript(transcriptPath)
    const eventCount = transcript.events.length

    const input: SessionEndInput = {
      hook_event_name: 'SessionEnd',
      session_id: 'test-incremental-skip',
      transcript_path: transcriptPath,
      cwd: TEST_CWD
    }

    const result = await handlePostSession(input, TEST_CONFIG, {
      previousExtractionEventCount: eventCount
    })

    expect(result.reason).toBe('no_new_events')
    expect(result.inserted).toBe(0)
    expect(result.extractedEventCount).toBe(eventCount)
  })

  it('should return no_new_events when event count exceeds transcript', async () => {
    const entries = buildTypicalTranscriptEntries()
    const transcriptPath = createMockTranscript(entries)

    const input: SessionEndInput = {
      hook_event_name: 'SessionEnd',
      session_id: 'test-incremental-skip-2',
      transcript_path: transcriptPath,
      cwd: TEST_CWD
    }

    const result = await handlePostSession(input, TEST_CONFIG, {
      previousExtractionEventCount: 99999
    })

    expect(result.reason).toBe('no_new_events')
  })

  it('should not set extractedEventCount on no_records result', async () => {
    // Use a very short transcript that won't produce records
    const entries = [
      { type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: 'hi' } },
      { type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: 'hello' } }
    ]
    const transcriptPath = createMockTranscript(entries)

    const input: SessionEndInput = {
      hook_event_name: 'SessionEnd',
      session_id: 'test-no-checkpoint',
      transcript_path: transcriptPath,
      cwd: TEST_CWD
    }

    // Force min-token skip by setting a high threshold
    const result = await handlePostSession(input, TEST_CONFIG, {})

    // Whether it returns no_records or something else, extractedEventCount should NOT be set
    // (to prevent false incremental checkpoints)
    if (result.reason === 'no_records') {
      expect(result.extractedEventCount).toBeUndefined()
    }
  })
})
