import { randomUUID } from 'crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appendSessionTracking,
  loadSessionTracking,
  markInjectedForSuppression,
  removeSessionTracking,
  updateSessionRetrievalState
} from '../src/lib/session-tracking.js'
import { EMBEDDING_DIM } from '../src/lib/types.js'

const SESSION_ID = 'topic-suppression-clear-test'
const activeSessions = new Set<string>()
const activeCollections = new Set<string>()

function testEmbedding(): number[] {
  const embedding = new Array<number>(EMBEDDING_DIM).fill(0)
  embedding[0] = 1
  return embedding
}

afterEach(() => {
  for (const collection of activeCollections) {
    for (const sessionId of activeSessions) {
      removeSessionTracking(sessionId, collection)
    }
  }
  activeSessions.clear()
  activeCollections.clear()
})

describe('session tracking suppression state', () => {
  function testCollection(): string {
    const collection = `session-tracking-test-${randomUUID()}`
    activeCollections.add(collection)
    return collection
  }

  function testSessionId(name: string): string {
    const sessionId = `${name}-${randomUUID()}`
    activeSessions.add(sessionId)
    return sessionId
  }

  it('removes topic suppression state with the session record', () => {
    const collection = testCollection()
    const sessionId = testSessionId(SESSION_ID)

    updateSessionRetrievalState(sessionId, {
      recentlyInjectedIds: ['memory-1'],
      previousPromptEmbedding: testEmbedding(),
      lastPromptAt: '2026-04-27T00:00:00.000Z'
    }, collection)

    expect(loadSessionTracking(sessionId, collection)).toMatchObject({
      recentlyInjectedIds: ['memory-1'],
      previousPromptEmbedding: testEmbedding(),
      lastPromptAt: '2026-04-27T00:00:00.000Z'
    })

    removeSessionTracking(sessionId, collection)

    expect(loadSessionTracking(sessionId, collection)).toBeNull()
  })

  it('appends injected IDs atomically and caps the window', () => {
    const collection = testCollection()
    const sessionId = testSessionId('atomic-window')

    markInjectedForSuppression(sessionId, ['memory-1'], 3, collection)
    markInjectedForSuppression(sessionId, ['memory-2', 'memory-3'], 3, collection)
    markInjectedForSuppression(sessionId, ['memory-4'], 3, collection)

    expect(loadSessionTracking(sessionId, collection)?.recentlyInjectedIds).toEqual([
      'memory-2',
      'memory-3',
      'memory-4'
    ])
  })

  it('refreshes duplicate injected IDs to the most-recent position', () => {
    const collection = testCollection()
    const sessionId = testSessionId('duplicate-refresh')

    markInjectedForSuppression(sessionId, ['memory-1', 'memory-2', 'memory-3'], 5, collection)
    markInjectedForSuppression(sessionId, ['memory-2'], 5, collection)

    expect(loadSessionTracking(sessionId, collection)?.recentlyInjectedIds).toEqual([
      'memory-1',
      'memory-3',
      'memory-2'
    ])
  })

  it('keeps the suppression window empty when window size is zero', () => {
    const collection = testCollection()
    const sessionId = testSessionId('window-disabled')

    markInjectedForSuppression(sessionId, ['memory-1'], 0, collection)

    expect(loadSessionTracking(sessionId, collection)?.recentlyInjectedIds).toEqual([])
  })

  it('treats malformed prompt embeddings as null when loading session state', () => {
    const collection = testCollection()
    const sessionId = testSessionId('malformed-embedding')

    updateSessionRetrievalState(sessionId, {
      previousPromptEmbedding: [1],
      lastPromptAt: '2026-04-27T00:00:00.000Z'
    }, collection)

    expect(loadSessionTracking(sessionId, collection)?.previousPromptEmbedding).toBeNull()
  })

  it('preserves existing tracked fields when updating retrieval state', () => {
    const collection = testCollection()
    const sessionId = testSessionId('preserve-existing')

    appendSessionTracking(sessionId, [{
      id: 'memory-existing',
      snippet: 'command: pnpm test',
      type: 'command',
      injectedAt: 1
    }], '/repo', 'run tests', 'injected', collection)

    updateSessionRetrievalState(sessionId, {
      previousPromptEmbedding: testEmbedding(),
      lastPromptAt: '2026-04-27T00:00:00.000Z'
    }, collection)
    markInjectedForSuppression(sessionId, ['memory-new'], 5, collection)

    const record = loadSessionTracking(sessionId, collection)
    expect(record?.cwd).toBe('/repo')
    expect(record?.memories).toHaveLength(1)
    expect(record?.memories[0]).toMatchObject({ id: 'memory-existing', snippet: 'command: pnpm test' })
    expect(record?.prompts).toHaveLength(1)
    expect(record?.recentlyInjectedIds).toEqual(['memory-new'])
    expect(record?.previousPromptEmbedding).toEqual(testEmbedding())
  })

  it('skips injected ID append when the retrieval state version is stale', () => {
    const collection = testCollection()
    const sessionId = testSessionId('stale-version')

    const promptState = updateSessionRetrievalState(sessionId, {
      previousPromptEmbedding: testEmbedding(),
      lastPromptAt: '2026-04-27T00:00:00.000Z'
    }, collection)

    markInjectedForSuppression(sessionId, ['memory-stale'], 5, collection, {
      expectedRetrievalStateVersion: (promptState?.retrievalStateVersion ?? 0) - 1
    })

    expect(loadSessionTracking(sessionId, collection)?.recentlyInjectedIds).toEqual([])
  })
})
