import { DEFAULT_CONFIG, createConfig } from '../src/lib/types.js'
import os from 'os'
import path from 'path'

/**
 * Test configuration - inherits from DEFAULT_CONFIG, overrides LanceDB directory/table.
 * This ensures tests use the same models/endpoints as production.
 */
export const TEST_CONFIG = createConfig({
  lancedb: {
    ...DEFAULT_CONFIG.lancedb,
    directory: path.join(os.tmpdir(), `claude-memory-lancedb-test-${process.pid}`),
    table: 'cc_memories_e2e_test'
  }
})

export const TEST_PROJECT = '/tmp/e2e-test-project'
export const TEST_CWD = '/tmp/e2e-test-project'
