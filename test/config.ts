import type { Config } from '../src/lib/types.js'

/**
 * Test configuration using isolated test collection.
 */
export const TEST_CONFIG: Config = {
  milvus: {
    address: 'localhost:19530',
    collection: 'cc_memories_e2e_test'
  },
  embeddings: {
    baseUrl: 'http://127.0.0.1:1234/v1',
    model: 'text-embedding-qwen3-embedding-8b'
  },
  extraction: {
    model: 'claude-haiku-4-20250514',
    maxTokens: 4000
  },
  injection: {
    maxRecords: 5,
    maxTokens: 2000
  }
}

export const TEST_PROJECT = '/tmp/e2e-test-project'
export const TEST_CWD = '/tmp/e2e-test-project'
