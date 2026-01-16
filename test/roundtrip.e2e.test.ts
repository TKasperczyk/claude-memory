/**
 * Round-trip E2E test: full flow from extraction to injection.
 *
 * This test simulates a complete cycle:
 * 1. Create a session with commands/errors
 * 2. Extract and store records (post-session)
 * 3. Query with related prompt (pre-prompt)
 * 4. Verify context injection contains extracted knowledge
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { TEST_CONFIG, TEST_PROJECT } from './config.js'
import {
  dropTestCollection,
  createMockTranscript,
  cleanupTempFiles,
  countTestRecords
} from './helpers.js'
import { initMilvus, insertRecord } from '../src/lib/milvus.js'
import { handlePrePrompt } from '../src/hooks/pre-prompt.js'
import { handlePostSession } from '../src/hooks/post-session.js'
import type { CommandRecord, ErrorRecord, UserPromptSubmitInput, SessionEndInput } from '../src/lib/types.js'
import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// Check for any available auth method (API key, env token, or credential files)
const hasAnthropicAuth = !!(
  process.env.ANTHROPIC_API_KEY ||
  process.env.OPENCODE_API_KEY ||
  process.env.ANTHROPIC_AUTH_TOKEN ||
  existsSync(join(homedir(), '.claude', '.credentials.json')) ||
  existsSync(join(homedir(), '.kira', 'credentials.json'))
)

describe('Round-Trip E2E', () => {
  beforeAll(async () => {
    await dropTestCollection()
    await initMilvus(TEST_CONFIG)
  })

  afterAll(async () => {
    await dropTestCollection()
    cleanupTempFiles()
  })

  beforeEach(async () => {
    await dropTestCollection()
    await initMilvus(TEST_CONFIG)
  })

  describe('Manual Round-Trip (Direct Storage)', () => {
    it('should retrieve injected context for stored command', async () => {
      // Step 1: Store a command record directly
      const commandRecord: CommandRecord = {
        id: randomUUID(),
        type: 'command',
        command: 'kubectl rollout restart deployment/api',
        exitCode: 0,
        outcome: 'success',
        context: {
          project: TEST_PROJECT,
          cwd: TEST_PROJECT,
          intent: 'restart the api pods'
        },
        project: TEST_PROJECT,
        domain: 'kubernetes',
        timestamp: Date.now(),
        successCount: 3,
        failureCount: 0,
        lastUsed: Date.now(),
        deprecated: false
      }

      await insertRecord(commandRecord, TEST_CONFIG)

      // Step 2: Query with related prompt
      const hookInput: UserPromptSubmitInput = {
        session_id: 'roundtrip-test-1',
        transcript_path: '',
        cwd: TEST_PROJECT,
        permission_mode: 'default',
        hook_event_name: 'UserPromptSubmit',
        prompt: 'How do I restart the kubernetes deployment?'
      }

      const result = await handlePrePrompt(hookInput, TEST_CONFIG)

      // Step 3: Verify context contains the command
      expect(result.timedOut).toBe(false)
      expect(result.context).toContain('<prior-knowledge>')
      expect(result.context).toContain('kubectl rollout restart')
    })

    it('should retrieve injected context for stored error resolution', async () => {
      // Step 1: Store an error record
      const errorRecord: ErrorRecord = {
        id: randomUUID(),
        type: 'error',
        errorText: 'FATAL: password authentication failed for user "postgres"',
        errorType: 'authentication',
        resolution: 'Update password in .env file and restart the service',
        context: {
          project: TEST_PROJECT,
          file: '.env',
          tool: 'psql'
        },
        project: TEST_PROJECT,
        domain: 'database',
        timestamp: Date.now(),
        successCount: 0,
        failureCount: 1,
        lastUsed: Date.now(),
        deprecated: false
      }

      await insertRecord(errorRecord, TEST_CONFIG)

      // Step 2: Query with related error
      const hookInput: UserPromptSubmitInput = {
        session_id: 'roundtrip-test-2',
        transcript_path: '',
        cwd: TEST_PROJECT,
        permission_mode: 'default',
        hook_event_name: 'UserPromptSubmit',
        prompt: `I'm getting this error:
FATAL: password authentication failed for user "postgres"
How do I fix it?`
      }

      const result = await handlePrePrompt(hookInput, TEST_CONFIG)

      // Step 3: Verify context contains resolution
      expect(result.timedOut).toBe(false)
      expect(result.context).toContain('<prior-knowledge>')
      expect(result.context).toContain('password')
      expect(result.context).toContain('.env')
    })

    it('should handle multiple related memories', async () => {
      // Store multiple related records
      const records: CommandRecord[] = [
        {
          id: randomUUID(),
          type: 'command',
          command: 'docker compose build',
          exitCode: 0,
          outcome: 'success',
          context: { project: TEST_PROJECT, cwd: TEST_PROJECT, intent: 'build containers' },
          project: TEST_PROJECT,
          domain: 'docker',
          timestamp: Date.now(),
          successCount: 5,
          failureCount: 0,
          lastUsed: Date.now(),
          deprecated: false
        },
        {
          id: randomUUID(),
          type: 'command',
          command: 'docker compose up -d',
          exitCode: 0,
          outcome: 'success',
          context: { project: TEST_PROJECT, cwd: TEST_PROJECT, intent: 'start containers' },
          project: TEST_PROJECT,
          domain: 'docker',
          timestamp: Date.now(),
          successCount: 8,
          failureCount: 1,
          lastUsed: Date.now(),
          deprecated: false
        },
        {
          id: randomUUID(),
          type: 'command',
          command: 'docker compose logs -f api',
          exitCode: 0,
          outcome: 'success',
          context: { project: TEST_PROJECT, cwd: TEST_PROJECT, intent: 'view api logs' },
          project: TEST_PROJECT,
          domain: 'docker',
          timestamp: Date.now(),
          successCount: 3,
          failureCount: 0,
          lastUsed: Date.now(),
          deprecated: false
        }
      ]

      for (const record of records) {
        await insertRecord(record, TEST_CONFIG)
      }

      // Query for docker-related help
      const hookInput: UserPromptSubmitInput = {
        session_id: 'roundtrip-test-3',
        transcript_path: '',
        cwd: TEST_PROJECT,
        permission_mode: 'default',
        hook_event_name: 'UserPromptSubmit',
        prompt: 'How do I work with docker compose in this project?'
      }

      const result = await handlePrePrompt(hookInput, TEST_CONFIG)

      expect(result.timedOut).toBe(false)
      expect(result.context).toContain('<prior-knowledge>')
      expect(result.context).toContain('docker compose')
    })
  })

  describe.skipIf(!hasAnthropicAuth)('Full Round-Trip (With Extraction)', () => {
    it('should extract from transcript and inject in subsequent query', async () => {
      // Step 1: Create a transcript with interesting commands
      const now = new Date().toISOString()
      const transcriptEntries = [
        {
          type: 'user',
          timestamp: now,
          cwd: TEST_PROJECT,
          message: { role: 'user', content: 'Run database migrations' }
        },
        {
          type: 'assistant',
          timestamp: now,
          cwd: TEST_PROJECT,
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Running migrations now.' },
              { type: 'tool_use', id: 'tool_1', name: 'Bash', input: { command: 'npx prisma migrate deploy' } }
            ]
          }
        },
        {
          type: 'tool_result',
          timestamp: now,
          cwd: TEST_PROJECT,
          tool_use_id: 'tool_1',
          content: 'Migrations applied successfully.\n3 migrations applied.\n',
          toolUseResult: {
            exitCode: 0,
            stdout: 'Migrations applied successfully.\n3 migrations applied.\n'
          }
        },
        {
          type: 'assistant',
          timestamp: now,
          cwd: TEST_PROJECT,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Database migrations completed successfully.' }]
          }
        }
      ]

      const transcriptPath = createMockTranscript(transcriptEntries)

      // Step 2: Run post-session to extract
      const extractInput: SessionEndInput = {
        session_id: 'roundtrip-full-1',
        transcript_path: transcriptPath,
        cwd: TEST_PROJECT,
        permission_mode: 'default',
        hook_event_name: 'SessionEnd',
        reason: 'prompt_input_exit'
      }

      const extractResult = await handlePostSession(extractInput, TEST_CONFIG)
      expect(extractResult.reason).toBeUndefined()
      expect(extractResult.inserted + extractResult.updated).toBeGreaterThan(0)

      // Verify records were stored
      const count = await countTestRecords()
      expect(count).toBeGreaterThan(0)

      // Step 3: Query with related prompt
      const injectInput: UserPromptSubmitInput = {
        session_id: 'roundtrip-full-2',
        transcript_path: '',
        cwd: TEST_PROJECT,
        permission_mode: 'default',
        hook_event_name: 'UserPromptSubmit',
        prompt: 'How do I run database migrations in this project?'
      }

      const injectResult = await handlePrePrompt(injectInput, TEST_CONFIG)

      // Step 4: Verify context
      expect(injectResult.timedOut).toBe(false)
      expect(injectResult.context).toContain('<prior-knowledge>')
      expect(injectResult.context).toContain('prisma')
    })
  })

  describe('Edge Cases', () => {
    it('should not inject deprecated records', async () => {
      const record: CommandRecord = {
        id: randomUUID(),
        type: 'command',
        command: 'old-deprecated-command',
        exitCode: 0,
        outcome: 'success',
        context: { project: TEST_PROJECT, cwd: TEST_PROJECT, intent: 'test' },
        project: TEST_PROJECT,
        domain: 'test',
        timestamp: Date.now(),
        successCount: 1,
        failureCount: 0,
        lastUsed: Date.now(),
        deprecated: true // DEPRECATED
      }

      await insertRecord(record, TEST_CONFIG)

      const hookInput: UserPromptSubmitInput = {
        session_id: 'roundtrip-edge-1',
        transcript_path: '',
        cwd: TEST_PROJECT,
        permission_mode: 'default',
        hook_event_name: 'UserPromptSubmit',
        prompt: 'old-deprecated-command'
      }

      const result = await handlePrePrompt(hookInput, TEST_CONFIG)

      // Should not include deprecated command in context
      if (result.context) {
        expect(result.context).not.toContain('old-deprecated-command')
      }
    })

    it('should prioritize exact keyword matches', async () => {
      // Insert a record with specific keyword
      const record: CommandRecord = {
        id: randomUUID(),
        type: 'command',
        command: 'SPECIFIC_UNIQUE_KEYWORD_123',
        exitCode: 0,
        outcome: 'success',
        context: { project: TEST_PROJECT, cwd: TEST_PROJECT, intent: 'test unique' },
        project: TEST_PROJECT,
        domain: 'test',
        timestamp: Date.now(),
        successCount: 1,
        failureCount: 0,
        lastUsed: Date.now(),
        deprecated: false
      }

      await insertRecord(record, TEST_CONFIG)

      // Insert other records that might semantically match
      const otherRecord: CommandRecord = {
        id: randomUUID(),
        type: 'command',
        command: 'SPECIFIC_UNIQUE_KEYWORD_124',
        exitCode: 0,
        outcome: 'success',
        context: { project: TEST_PROJECT, cwd: TEST_PROJECT, intent: 'run similar keyword' },
        project: TEST_PROJECT,
        domain: 'test',
        timestamp: Date.now(),
        successCount: 10,
        failureCount: 0,
        lastUsed: Date.now(),
        deprecated: false
      }

      await insertRecord(otherRecord, TEST_CONFIG)

      const hookInput: UserPromptSubmitInput = {
        session_id: 'roundtrip-edge-2',
        transcript_path: '',
        cwd: TEST_PROJECT,
        permission_mode: 'default',
        hook_event_name: 'UserPromptSubmit',
        prompt: 'SPECIFIC_UNIQUE_KEYWORD_123'
      }

      const result = await handlePrePrompt(hookInput, TEST_CONFIG)

      // Should find the exact keyword match
      expect(result.context).toContain('SPECIFIC_UNIQUE_KEYWORD_123')
      expect(result.results.length).toBeGreaterThan(0)

      const topResult = result.results[0]
      const semanticResult = result.results.find(entry => entry.record.id === otherRecord.id)

      expect(topResult.record.id).toBe(record.id)
      expect(topResult.keywordMatch).toBe(true)
      if (semanticResult) {
        expect(semanticResult.keywordMatch).toBe(false)
        expect(result.results.indexOf(semanticResult)).toBeGreaterThan(0)
      }
    })
  })
})
