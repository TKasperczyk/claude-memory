import { MilvusClient } from '@zilliz/milvus2-sdk-node'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import { TEST_CONFIG, TEST_PROJECT } from './config.js'
import type { CommandRecord, DiscoveryRecord, ErrorRecord, MemoryRecord, ProcedureRecord } from '../src/lib/types.js'

let client: MilvusClient | null = null
const tempFixtureDirs: string[] = []

/**
 * Get Milvus client for test operations.
 */
export function getTestClient(): MilvusClient {
  if (!client) {
    client = new MilvusClient({ address: TEST_CONFIG.milvus.address })
  }
  return client
}

/**
 * Drop the test collection if it exists.
 */
export async function dropTestCollection(): Promise<void> {
  const milvus = getTestClient()

  // Release collection first if loaded
  try {
    await milvus.releaseCollection({
      collection_name: TEST_CONFIG.milvus.collection
    })
  } catch {
    // Ignore - collection might not exist or not be loaded
  }

  const hasCollection = await milvus.hasCollection({
    collection_name: TEST_CONFIG.milvus.collection
  })

  if (hasCollection.value) {
    await milvus.dropCollection({
      collection_name: TEST_CONFIG.milvus.collection
    })
  }

  // Wait a bit for Milvus to clean up
  await sleep(100)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Flush the test collection.
 */
export async function flushTestCollection(): Promise<void> {
  const milvus = getTestClient()
  await milvus.flush({
    collection_names: [TEST_CONFIG.milvus.collection]
  })
}

/**
 * Count records in test collection.
 */
export async function countTestRecords(): Promise<number> {
  const milvus = getTestClient()

  const hasCollection = await milvus.hasCollection({
    collection_name: TEST_CONFIG.milvus.collection
  })

  if (!hasCollection.value) return 0

  await milvus.loadCollection({
    collection_name: TEST_CONFIG.milvus.collection
  })

  const result = await milvus.query({
    collection_name: TEST_CONFIG.milvus.collection,
    filter: 'id != ""',
    output_fields: ['id']
  })

  return result.data?.length ?? 0
}

/**
 * Create a mock command record.
 */
export function createMockCommandRecord(overrides: Partial<CommandRecord> = {}): CommandRecord {
  return {
    id: randomUUID(),
    type: 'command',
    command: 'npm run build',
    exitCode: 0,
    outcome: 'success',
    context: {
      project: TEST_PROJECT,
      cwd: TEST_PROJECT,
      intent: 'build the project'
    },
    project: TEST_PROJECT,
    domain: 'node',
    timestamp: Date.now(),
    successCount: 1,
    failureCount: 0,
    lastUsed: Date.now(),
    deprecated: false,
    ...overrides
  }
}

/**
 * Create a mock error record.
 */
export function createMockErrorRecord(overrides: Partial<ErrorRecord> = {}): ErrorRecord {
  return {
    id: randomUUID(),
    type: 'error',
    errorText: 'TypeError: Cannot read property "x" of undefined',
    errorType: 'runtime',
    resolution: 'Check if object is null before accessing properties',
    context: {
      project: TEST_PROJECT,
      file: 'src/index.ts',
      tool: 'node'
    },
    project: TEST_PROJECT,
    domain: 'node',
    timestamp: Date.now(),
    successCount: 0,
    failureCount: 1,
    lastUsed: Date.now(),
    deprecated: false,
    ...overrides
  }
}

/**
 * Create a mock discovery record.
 */
export function createMockDiscoveryRecord(overrides: Partial<DiscoveryRecord> = {}): DiscoveryRecord {
  return {
    id: randomUUID(),
    type: 'discovery',
    what: 'The project uses ESM modules with .js extensions',
    where: 'package.json type field',
    evidence: 'Found "type": "module" in package.json',
    confidence: 'verified',
    project: TEST_PROJECT,
    domain: 'node',
    timestamp: Date.now(),
    successCount: 1,
    failureCount: 0,
    lastUsed: Date.now(),
    deprecated: false,
    ...overrides
  }
}

/**
 * Create a mock procedure record.
 */
export function createMockProcedureRecord(overrides: Partial<ProcedureRecord> = {}): ProcedureRecord {
  return {
    id: randomUUID(),
    type: 'procedure',
    name: 'Deploy to production',
    steps: [
      'pnpm build',
      'pnpm test',
      'ssh server "cd /opt/app && git pull"',
      'ssh server "systemctl restart app"'
    ],
    context: {
      project: TEST_PROJECT,
      domain: 'deploy'
    },
    verification: 'curl -s https://app.example.com/health returns 200',
    project: TEST_PROJECT,
    domain: 'deploy',
    timestamp: Date.now(),
    successCount: 3,
    failureCount: 0,
    lastUsed: Date.now(),
    deprecated: false,
    ...overrides
  }
}

/**
 * Create a mock transcript JSONL file.
 */
export function createMockTranscript(entries: object[]): string {
  const tempDir = '/tmp/claude-memory-test'
  fs.mkdirSync(tempDir, { recursive: true })
  const filePath = path.join(tempDir, `transcript-${randomUUID()}.jsonl`)
  const content = entries.map(entry => JSON.stringify(entry)).join('\n') + '\n'
  fs.writeFileSync(filePath, content, 'utf-8')
  return filePath
}

/**
 * Create a temp project fixture with marker files for domain detection.
 */
export function createTempProjectFixture(files: Record<string, string> = {}): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-memory-fixture-'))
  tempFixtureDirs.push(tempDir)

  const defaultFiles: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'temp-fixture', private: true }, null, 2),
    'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2020' } }, null, 2)
  }

  const mergedFiles = { ...defaultFiles, ...files }
  for (const [filename, contents] of Object.entries(mergedFiles)) {
    fs.writeFileSync(path.join(tempDir, filename), contents, 'utf-8')
  }

  return tempDir
}

/**
 * Build a typical session transcript with commands and tool results.
 */
export function buildTypicalTranscriptEntries(): object[] {
  const now = new Date().toISOString()

  return [
    {
      type: 'user',
      timestamp: now,
      cwd: TEST_PROJECT,
      message: {
        role: 'user',
        content: 'Build the project and run tests'
      }
    },
    {
      type: 'assistant',
      timestamp: now,
      cwd: TEST_PROJECT,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I\'ll build the project and run the tests.' },
          { type: 'tool_use', id: 'tool_1', name: 'Bash', input: { command: 'npm run build' } }
        ]
      }
    },
    {
      type: 'tool_result',
      timestamp: now,
      cwd: TEST_PROJECT,
      tool_use_id: 'tool_1',
      content: 'Build completed successfully\n',
      toolUseResult: {
        exitCode: 0,
        stdout: 'Build completed successfully\n'
      }
    },
    {
      type: 'assistant',
      timestamp: now,
      cwd: TEST_PROJECT,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Build succeeded. Now running tests.' },
          { type: 'tool_use', id: 'tool_2', name: 'Bash', input: { command: 'npm test' } }
        ]
      }
    },
    {
      type: 'tool_result',
      timestamp: now,
      cwd: TEST_PROJECT,
      tool_use_id: 'tool_2',
      content: 'All 42 tests passed.\n',
      toolUseResult: {
        exitCode: 0,
        stdout: 'All 42 tests passed.\n'
      }
    },
    {
      type: 'assistant',
      timestamp: now,
      cwd: TEST_PROJECT,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'All tests passed! The project built and tested successfully.' }
        ]
      }
    }
  ]
}

/**
 * Build a transcript with an error and resolution.
 */
export function buildErrorTranscriptEntries(): object[] {
  const now = new Date().toISOString()

  return [
    {
      type: 'user',
      timestamp: now,
      cwd: TEST_PROJECT,
      message: {
        role: 'user',
        content: 'Run the build'
      }
    },
    {
      type: 'assistant',
      timestamp: now,
      cwd: TEST_PROJECT,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Running build now.' },
          { type: 'tool_use', id: 'tool_1', name: 'Bash', input: { command: 'npm run build' } }
        ]
      }
    },
    {
      type: 'tool_result',
      timestamp: now,
      cwd: TEST_PROJECT,
      tool_use_id: 'tool_1',
      content: 'error TS2304: Cannot find name \'foo\'.\nsrc/index.ts(10,5): error TS2304\n',
      is_error: true,
      toolUseResult: {
        exitCode: 1,
        stderr: 'error TS2304: Cannot find name \'foo\'.\nsrc/index.ts(10,5): error TS2304\n'
      }
    },
    {
      type: 'assistant',
      timestamp: now,
      cwd: TEST_PROJECT,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'TypeScript error. Let me fix the undefined variable.' },
          { type: 'tool_use', id: 'tool_2', name: 'Edit', input: { file_path: 'src/index.ts', old_string: 'foo', new_string: 'bar' } }
        ]
      }
    },
    {
      type: 'tool_result',
      timestamp: now,
      cwd: TEST_PROJECT,
      tool_use_id: 'tool_2',
      content: 'File edited successfully'
    },
    {
      type: 'assistant',
      timestamp: now,
      cwd: TEST_PROJECT,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Fixed. Running build again.' },
          { type: 'tool_use', id: 'tool_3', name: 'Bash', input: { command: 'npm run build' } }
        ]
      }
    },
    {
      type: 'tool_result',
      timestamp: now,
      cwd: TEST_PROJECT,
      tool_use_id: 'tool_3',
      content: 'Build completed successfully\n',
      toolUseResult: {
        exitCode: 0,
        stdout: 'Build completed successfully\n'
      }
    },
    {
      type: 'assistant',
      timestamp: now,
      cwd: TEST_PROJECT,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Build succeeded after fixing the undefined variable error.' }
        ]
      }
    }
  ]
}

/**
 * Cleanup temp files.
 */
export function cleanupTempFiles(): void {
  const tempDir = '/tmp/claude-memory-test'
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
  for (const dir of tempFixtureDirs) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
  tempFixtureDirs.length = 0
}
