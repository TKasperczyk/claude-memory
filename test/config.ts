import { DEFAULT_CONFIG, createConfig } from '../src/lib/types.js'

/**
 * Test configuration - inherits from DEFAULT_CONFIG, only overrides collection name.
 * This ensures tests use the same models/endpoints as production.
 */
export const TEST_CONFIG = createConfig({
  milvus: {
    ...DEFAULT_CONFIG.milvus,
    collection: 'cc_memories_e2e_test'
  }
})

export const TEST_PROJECT = '/tmp/e2e-test-project'
export const TEST_CWD = '/tmp/e2e-test-project'
