/**
 * E2E tests for the extraction flow (post-session hook).
 *
 * Tests the flow: transcript file → parsing → storage
 *
 * Note: The full extraction flow requires Anthropic API (for Haiku extraction).
 * Tests that need the API are skipped if ANTHROPIC_API_KEY is not set.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import path from 'path'
import fs from 'fs'
import { TEST_CONFIG, TEST_PROJECT } from './config.js'
import { checkEmbeddingAvailability } from './embedding-availability.js'
import {
  dropTestCollection,
  countTestRecords,
  createMockTranscript,
  buildTypicalTranscriptEntries,
  buildErrorTranscriptEntries,
  cleanupTempFiles,
  createMockCommandRecord,
  createMockErrorRecord
} from './helpers.js'
import { parseTranscript } from '../src/lib/transcript.js'
import { initMilvus, insertRecord, getRecord, hybridSearch, findSimilar } from '../src/lib/milvus.js'
import { handlePostSession } from '../src/hooks/post-session.js'
import type { SessionEndInput } from '../src/lib/types.js'

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

const embeddingAvailability = await checkEmbeddingAvailability(TEST_CONFIG, { timeoutMs: 800 })
const hasEmbeddings = embeddingAvailability.available
const embeddingSkipNote = embeddingAvailability.reason
  ? `LMStudio unavailable: ${embeddingAvailability.reason}`
  : 'LMStudio unavailable'
const embeddingSkipSuffix = hasEmbeddings ? '' : ` (skipped: ${embeddingSkipNote})`
const extractionSkipReasons = [
  !hasAnthropicAuth ? 'missing Anthropic auth' : null,
  !hasEmbeddings ? embeddingSkipNote : null
].filter((reason): reason is string => Boolean(reason))
const extractionSkipSuffix = extractionSkipReasons.length > 0
  ? ` (skipped: ${extractionSkipReasons.join(', ')})`
  : ''

describe('Extraction E2E', () => {
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

  describe('Transcript Parsing', () => {
    it('should parse a typical session transcript', async () => {
      const entries = buildTypicalTranscriptEntries()
      const transcriptPath = createMockTranscript(entries)

      const transcript = await parseTranscript(transcriptPath)

      expect(transcript.parseErrors).toBe(0)
      expect(transcript.messages.length).toBeGreaterThan(0)
      expect(transcript.toolCalls.length).toBeGreaterThanOrEqual(2)
      expect(transcript.toolResults.length).toBeGreaterThanOrEqual(2)

      // Check for Bash commands
      const bashCalls = transcript.toolCalls.filter(c => c.name === 'Bash')
      expect(bashCalls.length).toBeGreaterThanOrEqual(2)
    })

    it('should parse a transcript with errors', async () => {
      const entries = buildErrorTranscriptEntries()
      const transcriptPath = createMockTranscript(entries)

      const transcript = await parseTranscript(transcriptPath)

      expect(transcript.parseErrors).toBe(0)

      // Should have both failed and successful commands
      const toolResults = transcript.toolResults
      const hasError = toolResults.some(r => r.isError || r.outputText?.includes('error'))
      expect(hasError).toBe(true)
    })

    it('should handle malformed JSONL lines gracefully', async () => {
      const entries = [
        { type: 'user', message: { role: 'user', content: 'hello' } },
        'this is not valid json',
        { type: 'assistant', message: { role: 'assistant', content: 'hi' } }
      ]
      const transcriptPath = createMockTranscript(entries.map((e, i) =>
        typeof e === 'string' ? e : JSON.stringify(e)
      ).join('\n').split('\n').map(line => {
        try { JSON.parse(line); return line }
        catch { return line }
      }))

      // Need to write raw (some invalid JSON)
      const tempDir = '/tmp/claude-memory-test'
      fs.mkdirSync(tempDir, { recursive: true })
      const badPath = path.join(tempDir, 'bad-transcript.jsonl')
      fs.writeFileSync(badPath, `{"type":"user","message":{"role":"user","content":"hello"}}
this is not valid json
{"type":"assistant","message":{"role":"assistant","content":"hi"}}
`)

      const transcript = await parseTranscript(badPath)

      expect(transcript.parseErrors).toBe(1)
      expect(transcript.messages.length).toBeGreaterThanOrEqual(2)
    })

    it('should handle empty transcript', async () => {
      const transcriptPath = createMockTranscript([])

      const transcript = await parseTranscript(transcriptPath)

      expect(transcript.parseErrors).toBe(0)
      expect(transcript.messages.length).toBe(0)
      expect(transcript.toolCalls.length).toBe(0)
    })
  })

  describe.skipIf(!hasEmbeddings)(`Storage Layer${embeddingSkipSuffix}`, () => {
    it('should insert and retrieve a command record', async () => {
      const record = createMockCommandRecord({
        command: 'pnpm build',
        exitCode: 0,
        outcome: 'success'
      })

      await insertRecord(record, TEST_CONFIG)

      const retrieved = await getRecord(record.id, TEST_CONFIG)
      expect(retrieved).not.toBeNull()
      expect(retrieved!.type).toBe('command')
      expect((retrieved as typeof record).command).toBe('pnpm build')
    })

    it('should insert and retrieve an error record', async () => {
      const record = createMockErrorRecord({
        errorText: 'ENOENT: no such file or directory',
        errorType: 'filesystem',
        resolution: 'Create the missing file first'
      })

      await insertRecord(record, TEST_CONFIG)

      const retrieved = await getRecord(record.id, TEST_CONFIG)
      expect(retrieved).not.toBeNull()
      expect(retrieved!.type).toBe('error')
      expect((retrieved as typeof record).errorText).toBe('ENOENT: no such file or directory')
    })

    it('should find similar records', async () => {
      const record1 = createMockCommandRecord({
        command: 'npm run build',
        exitCode: 0,
        outcome: 'success'
      })
      const record2 = createMockCommandRecord({
        command: 'npm run build',
        exitCode: 0,
        outcome: 'success'
      })

      await insertRecord(record1, TEST_CONFIG)

      const matches = await findSimilar(record2, 0.8, 5, TEST_CONFIG)

      // Should find record1 as similar to record2
      expect(matches.length).toBeGreaterThanOrEqual(1)
      expect(matches[0].record.id).toBe(record1.id)
      expect(matches[0].similarity).toBeGreaterThan(0.8)
    })

    it('should perform hybrid search', async () => {
      const record = createMockCommandRecord({
        command: 'systemctl restart nginx',
        exitCode: 0,
        outcome: 'success'
      })

      await insertRecord(record, TEST_CONFIG)

      // Keyword search should find it
      const keywordResults = await hybridSearch({
        query: 'nginx',
        limit: 5,
        vectorWeight: 0,
        keywordWeight: 1
      }, TEST_CONFIG)

      expect(keywordResults.length).toBeGreaterThanOrEqual(1)
      expect(keywordResults[0].keywordMatch).toBe(true)
      expect((keywordResults[0].record as typeof record).command).toContain('nginx')

      // Vector search should also find it
      const vectorResults = await hybridSearch({
        query: 'restart web server service',
        limit: 5,
        vectorWeight: 1,
        keywordWeight: 0
      }, TEST_CONFIG)

      const vectorResult = vectorResults.find(result => result.record.id === record.id)
      expect(vectorResult).toBeDefined()
      expect(vectorResult!.keywordMatch).toBe(false)
      expect(vectorResult!.similarity).toBeGreaterThan(0)
    })

    it('should track success/failure counts', async () => {
      const record = createMockCommandRecord({
        command: 'make test',
        exitCode: 0,
        outcome: 'success',
        successCount: 5,
        failureCount: 2
      })

      await insertRecord(record, TEST_CONFIG)

      const retrieved = await getRecord(record.id, TEST_CONFIG)
      expect(retrieved!.successCount).toBe(5)
      expect(retrieved!.failureCount).toBe(2)
    })
  })

  describe('Post-Session Hook Integration', () => {
    it.skipIf(extractionSkipReasons.length > 0)(
      `should extract and store records from transcript${extractionSkipSuffix}`,
      async () => {
        const entries = buildTypicalTranscriptEntries()
        const transcriptPath = createMockTranscript(entries)

        const hookInput: SessionEndInput = {
          session_id: 'test-session-123',
          transcript_path: transcriptPath,
          cwd: TEST_PROJECT,
          permission_mode: 'default',
          hook_event_name: 'SessionEnd',
          reason: 'prompt_input_exit'
        }

        const result = await handlePostSession(hookInput, TEST_CONFIG)

        expect(result.reason).toBeUndefined()
        expect(result.inserted + result.updated).toBeGreaterThan(0)

        // Check that records were stored
        const count = await countTestRecords()
        expect(count).toBeGreaterThan(0)
      }
    )

    it('should skip extraction when reason is "clear"', async () => {
      const entries = buildTypicalTranscriptEntries()
      const transcriptPath = createMockTranscript(entries)

      const hookInput: SessionEndInput = {
        session_id: 'test-session-456',
        transcript_path: transcriptPath,
        cwd: TEST_PROJECT,
        permission_mode: 'default',
        hook_event_name: 'SessionEnd',
        reason: 'clear'
      }

      const result = await handlePostSession(hookInput, TEST_CONFIG)

      expect(result.reason).toBe('clear')
      expect(result.inserted).toBe(0)
      expect(result.updated).toBe(0)

      // Should not have stored any records
      const count = await countTestRecords()
      expect(count).toBe(0)
    })

    it('should handle missing transcript gracefully', async () => {
      const hookInput: SessionEndInput = {
        session_id: 'test-session-789',
        transcript_path: '/nonexistent/path/transcript.jsonl',
        cwd: TEST_PROJECT,
        permission_mode: 'default',
        hook_event_name: 'SessionEnd',
        reason: 'prompt_input_exit'
      }

      const result = await handlePostSession(hookInput, TEST_CONFIG)

      expect(result.reason).toBe('no_transcript')
      expect(result.inserted).toBe(0)
    })
  })
})
