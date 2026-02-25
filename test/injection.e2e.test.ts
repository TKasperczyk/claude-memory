/**
 * E2E tests for the injection flow (pre-prompt hook).
 *
 * Tests the flow: user prompt → signal extraction → memory search → context injection
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { TEST_CONFIG, TEST_PROJECT } from './config.js'
import { checkEmbeddingAvailability } from './embedding-availability.js'
import {
  dropTestCollection,
  createMockCommandRecord,
  createMockErrorRecord,
  createMockDiscoveryRecord,
  createMockProcedureRecord,
  createTempProjectFixture,
  cleanupTempFiles
} from './helpers.js'
import { initLanceDB, insertRecord, hybridSearch } from '../src/lib/lancedb.js'
import { buildContext, extractSignals } from '../src/lib/context.js'
import { handlePrePrompt } from '../src/hooks/pre-prompt.js'
import type { UserPromptSubmitInput } from '../src/lib/types.js'

const embeddingAvailability = await checkEmbeddingAvailability(TEST_CONFIG, { timeoutMs: 800 })
const hasEmbeddings = embeddingAvailability.available
const embeddingSkipNote = embeddingAvailability.reason
  ? `LMStudio unavailable: ${embeddingAvailability.reason}`
  : 'LMStudio unavailable'
const embeddingSkipSuffix = hasEmbeddings ? '' : ` (skipped: ${embeddingSkipNote})`

describe('Injection E2E', () => {
  beforeAll(async () => {
    await dropTestCollection()
    await initLanceDB(TEST_CONFIG)
  })

  afterAll(async () => {
    await dropTestCollection()
    cleanupTempFiles()
  })

  beforeEach(async () => {
    await dropTestCollection()
    await initLanceDB(TEST_CONFIG)
  })

  describe('Signal Extraction', () => {
    it('should extract error signals from prompt', () => {
      const prompt = `I'm getting this error:

TypeError: Cannot read property 'map' of undefined
    at Array.map (<anonymous>)
    at processItems (src/index.ts:42:10)

How do I fix it?`

      const signals = extractSignals(prompt, TEST_PROJECT)

      expect(signals.errors.length).toBeGreaterThan(0)
      expect(signals.errors.some(e => e.includes('TypeError'))).toBe(true)
    })

    it('should extract command signals from fenced code blocks', () => {
      const prompt = `I ran this command:

\`\`\`bash
$ npm run build
\`\`\`

And it failed. What should I do?`

      const signals = extractSignals(prompt, TEST_PROJECT)

      expect(signals.commands.length).toBeGreaterThan(0)
      expect(signals.commands.some(c => c.includes('npm run build'))).toBe(true)
    })

    it('should handle prompts with no extractable signals', () => {
      const prompt = 'Hello, how are you today?'
      const signals = extractSignals(prompt, TEST_PROJECT)

      expect(signals.errors.length).toBe(0)
      expect(signals.commands.length).toBe(0)
    })
  })

  describe('Context Formatting', () => {
    it('should format command records', () => {
      const records = [
        createMockCommandRecord({
          command: 'pnpm build',
          exitCode: 0,
          outcome: 'success'
        })
      ]

      const context = buildContext(records, TEST_CONFIG).context

      expect(context).toContain('<prior-knowledge>')
      expect(context).toContain('</prior-knowledge>')
      expect(context).toContain('pnpm build')
      expect(context).toContain('success')
    })

    it('should format error records with resolution', () => {
      const records = [
        createMockErrorRecord({
          errorText: 'ENOENT: no such file or directory',
          resolution: 'Create the file first'
        })
      ]

      const context = buildContext(records, TEST_CONFIG).context

      expect(context).toContain('ENOENT')
      expect(context).toContain('Create the file first')
    })

    it('should format discovery records', () => {
      const records = [
        createMockDiscoveryRecord({
          what: 'The API uses JWT tokens for authentication',
          where: 'src/auth/middleware.ts'
        })
      ]

      const context = buildContext(records, TEST_CONFIG).context

      expect(context).toContain('JWT tokens')
      expect(context).toContain('discovery')
    })

    it('should format procedure records with steps', () => {
      const records = [
        createMockProcedureRecord({
          name: 'Deploy to staging',
          steps: ['pnpm build', 'docker push', 'kubectl apply']
        })
      ]

      const context = buildContext(records, TEST_CONFIG).context

      expect(context).toContain('Deploy to staging')
      expect(context).toContain('pnpm build')
    })

    it('should respect maxRecords limit', () => {
      const records = Array.from({ length: 10 }, (_, i) =>
        createMockCommandRecord({
          command: `command-${i}`,
          exitCode: 0,
          outcome: 'success'
        })
      )

      const limitedConfig = {
        ...TEST_CONFIG,
        injection: { ...TEST_CONFIG.injection, maxRecords: 3 }
      }

      const context = buildContext(records, limitedConfig).context

      // Should only include 3 commands
      const matches = context.match(/command-\d/g) ?? []
      expect(matches.length).toBe(3)
    })

    it('should filter deprecated records', () => {
      const records = [
        createMockCommandRecord({
          command: 'old-command',
          deprecated: true
        }),
        createMockCommandRecord({
          command: 'new-command',
          deprecated: false
        })
      ]

      const context = buildContext(records, TEST_CONFIG).context

      expect(context).not.toContain('old-command')
      expect(context).toContain('new-command')
    })
  })

  describe.skipIf(!hasEmbeddings)(`Memory Search${embeddingSkipSuffix}`, () => {
    it('should support keyword, semantic, and hybrid search', async () => {
      const keywordRecord = createMockCommandRecord({
        command: 'systemctl restart nginx',
        exitCode: 0,
        outcome: 'success'
      })
      const semanticRecord = createMockCommandRecord({
        command: 'docker compose up -d',
        exitCode: 0,
        outcome: 'success'
      })
      const hybridKeywordRecord = createMockCommandRecord({
        command: 'kubectl get pods --all-namespaces',
        exitCode: 0,
        outcome: 'success'
      })
      const hybridSemanticRecord = createMockErrorRecord({
        errorText: 'kubectl get pods failed: pod not found',
        resolution: 'Check namespace with kubectl get ns'
      })

      await insertRecord(keywordRecord, TEST_CONFIG)
      await insertRecord(semanticRecord, TEST_CONFIG)
      await insertRecord(hybridKeywordRecord, TEST_CONFIG)
      await insertRecord(hybridSemanticRecord, TEST_CONFIG)

      const keywordResults = await hybridSearch({
        query: 'nginx',
        limit: 5,
        vectorWeight: 0,
        keywordWeight: 1
      }, TEST_CONFIG)

      const keywordMatch = keywordResults.find(result => result.record.id === keywordRecord.id)
      expect(keywordMatch).toBeDefined()
      expect(keywordMatch!.keywordMatch).toBe(true)

      const semanticResults = await hybridSearch({
        query: 'start containers in background',
        limit: 5,
        vectorWeight: 1,
        keywordWeight: 0
      }, TEST_CONFIG)

      const semanticMatch = semanticResults.find(result => result.record.id === semanticRecord.id)
      expect(semanticMatch).toBeDefined()
      expect(semanticMatch!.similarity).toBeGreaterThan(0)

      const hybridResults = await hybridSearch({
        query: hybridKeywordRecord.command,
        limit: 5,
        vectorWeight: 0.5,
        keywordWeight: 0.5,
        minScore: 0
      }, TEST_CONFIG)

      const hybridKeywordMatch = hybridResults.find(result => result.record.id === hybridKeywordRecord.id)
      const hybridSemanticMatch = hybridResults.find(result => result.record.id === hybridSemanticRecord.id)

      expect(hybridKeywordMatch).toBeDefined()
      expect(hybridKeywordMatch!.keywordMatch).toBe(true)
      expect(hybridSemanticMatch).toBeDefined()
      expect(hybridSemanticMatch!.keywordMatch).toBe(false)
      expect(hybridSemanticMatch!.similarity).toBeGreaterThan(0)
    })

    it('should filter by project', async () => {
      await insertRecord(createMockCommandRecord({
        command: 'pnpm build',
        project: '/project-a'
      }), TEST_CONFIG)

      await insertRecord(createMockCommandRecord({
        command: 'pnpm test',
        project: '/project-b'
      }), TEST_CONFIG)

      const results = await hybridSearch({
        query: 'pnpm',
        project: '/project-a',
        limit: 10,
        keywordWeight: 1,
        vectorWeight: 0
      }, TEST_CONFIG)

      expect(results.every(r => r.record.project === '/project-a')).toBe(true)
    })

    it('should include global records when filtering by project', async () => {
      await insertRecord(createMockCommandRecord({
        command: 'pnpm build',
        project: '/project-a'
      }), TEST_CONFIG)

      await insertRecord(createMockCommandRecord({
        command: 'pnpm install --shamefully-hoist',
        project: '/project-b',
        scope: 'global'
      }), TEST_CONFIG)

      const results = await hybridSearch({
        query: 'pnpm',
        project: '/project-a',
        limit: 10,
        keywordWeight: 1,
        vectorWeight: 0
      }, TEST_CONFIG)

      expect(results.some(r => r.record.scope === 'global')).toBe(true)
      expect(results.every(r => r.record.project === '/project-a' || r.record.scope === 'global')).toBe(true)
    })
  })

  describe('Pre-Prompt Hook Integration', () => {
    it.skipIf(!hasEmbeddings)(`should inject context for matching memories${embeddingSkipSuffix}`, async () => {
      // Pre-populate with known records
      const commandRecord = createMockCommandRecord({
        command: 'pnpm prisma migrate deploy',
        exitCode: 0,
        outcome: 'success'
      })
      const errorRecord = createMockErrorRecord({
        errorText: 'ECONNREFUSED 127.0.0.1:5432',
        errorType: 'connection',
        resolution: 'Start PostgreSQL with: sudo systemctl start postgresql'
      })

      await insertRecord(commandRecord, TEST_CONFIG)
      await insertRecord(errorRecord, TEST_CONFIG)

      const hookInput: UserPromptSubmitInput = {
        session_id: 'test-session-inject-1',
        transcript_path: '',
        cwd: TEST_PROJECT,
        permission_mode: 'default',
        hook_event_name: 'UserPromptSubmit',
        prompt: `I am getting ECONNREFUSED 127.0.0.1:5432 when running migrations.

\`\`\`bash
$ pnpm prisma migrate deploy
\`\`\`

How do I fix it?`
      }

      const result = await handlePrePrompt(hookInput, TEST_CONFIG)

      expect(result.timedOut).toBe(false)
      expect(result.context).not.toBeNull()
      expect(result.context).toContain('<prior-knowledge>')
      expect(result.context).toContain('ECONNREFUSED')
      expect(result.context).toContain('pnpm prisma migrate deploy')
      expect(result.context).toContain('postgresql')
      expect(result.results.map(entry => entry.record.id)).toEqual(
        expect.arrayContaining([commandRecord.id, errorRecord.id])
      )
    })

    it('should handle empty prompt gracefully', async () => {
      const hookInput: UserPromptSubmitInput = {
        session_id: 'test-session-inject-2',
        transcript_path: '',
        cwd: TEST_PROJECT,
        permission_mode: 'default',
        hook_event_name: 'UserPromptSubmit',
        prompt: ''
      }

      const result = await handlePrePrompt(hookInput, TEST_CONFIG)

      expect(result.context).toBeNull()
      expect(result.results.length).toBe(0)
    })

    it.skipIf(!hasEmbeddings)(`should handle no matching memories${embeddingSkipSuffix}`, async () => {
      const hookInput: UserPromptSubmitInput = {
        session_id: 'test-session-inject-3',
        transcript_path: '',
        cwd: TEST_PROJECT,
        permission_mode: 'default',
        hook_event_name: 'UserPromptSubmit',
        prompt: 'How do I cook pasta?'
      }

      const result = await handlePrePrompt(hookInput, TEST_CONFIG)

      expect(result.results.length).toBe(0)
      expect(result.context).toBeNull()
    })

    it.skipIf(!hasEmbeddings)(`should complete within reasonable time${embeddingSkipSuffix}`, async () => {
      const hookInput: UserPromptSubmitInput = {
        session_id: 'test-session-inject-4',
        transcript_path: '',
        cwd: TEST_PROJECT,
        permission_mode: 'default',
        hook_event_name: 'UserPromptSubmit',
        prompt: 'What is the meaning of life?'
      }

      const start = Date.now()
      const result = await handlePrePrompt(hookInput, TEST_CONFIG)
      const elapsed = Date.now() - start

      expect(result.timedOut).toBe(false)
      // Should complete within the 4s internal timeout + buffer
      expect(elapsed).toBeLessThan(10000)
    })
  })
})
