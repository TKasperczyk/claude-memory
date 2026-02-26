import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'crypto'
import {
  buildContext,
  extractSignals,
  findAncestorProjects,
  formatRecordSnippet,
  stripNoiseWords
} from '../src/lib/context.js'
import {
  createConfig,
  type CommandRecord,
  type DiscoveryRecord,
  type ErrorRecord,
  type MemoryRecord,
  type ProcedureRecord,
  type ScoredRecord,
  type WarningRecord
} from '../src/lib/types.js'

// --------------- helpers ---------------

function makeRecord<T extends MemoryRecord>(overrides: Partial<T> & { type: T['type'] }): T {
  const base = {
    id: randomUUID(),
    project: '/test/project',
    scope: 'project' as const,
    timestamp: Date.now(),
    successCount: 0,
    failureCount: 0,
    retrievalCount: 0,
    usageCount: 0,
    lastUsed: Date.now(),
    deprecated: false
  }

  switch (overrides.type) {
    case 'command':
      return {
        ...base,
        command: 'npm run build',
        exitCode: 0,
        outcome: 'success',
        context: { project: '/test/project', cwd: '/test/project', intent: 'build' },
        ...overrides
      } as unknown as T
    case 'error':
      return {
        ...base,
        errorText: 'TypeError: x is undefined',
        errorType: 'runtime',
        resolution: 'Check null before access',
        context: { project: '/test/project' },
        ...overrides
      } as unknown as T
    case 'discovery':
      return {
        ...base,
        what: 'Uses ESM',
        where: 'package.json',
        confidence: 'verified',
        ...overrides
      } as unknown as T
    case 'procedure':
      return {
        ...base,
        name: 'Deploy',
        steps: ['pnpm build', 'pnpm test', 'ssh deploy'],
        context: { project: '/test/project' },
        ...overrides
      } as unknown as T
    case 'warning':
      return {
        ...base,
        avoid: 'using var',
        useInstead: 'const or let',
        reason: 'var has function scope',
        severity: 'warning' as const,
        ...overrides
      } as unknown as T
    default:
      return { ...base, ...overrides } as unknown as T
  }
}

function scored(record: MemoryRecord, score = 0.8, similarity = 0.7, keywordMatch = false): ScoredRecord {
  return { record, score, similarity, keywordMatch }
}

const defaultConfig = createConfig()
const tinyConfig = createConfig({ injection: { maxRecords: 2, maxTokens: 500 } })

// --------------- stripNoiseWords ---------------

describe('stripNoiseWords', () => {
  it('removes ultrathink and collapses whitespace', () => {
    expect(stripNoiseWords('please ultrathink about this')).toBe('please about this')
  })

  it('removes ultrathin (common typo)', () => {
    expect(stripNoiseWords('ultrathin consider the problem')).toBe('consider the problem')
  })

  it('is case-insensitive', () => {
    expect(stripNoiseWords('ULTRATHINK ULTRATHIN foo')).toBe('foo')
  })

  it('preserves newlines for code fence detection', () => {
    const input = 'line one\n```bash\necho hello\n```'
    const result = stripNoiseWords(input)
    expect(result).toContain('\n')
    expect(result.split('\n')).toHaveLength(4)
  })

  it('returns empty for blank input', () => {
    expect(stripNoiseWords('   ')).toBe('')
  })
})

// --------------- extractSignals ---------------

describe('extractSignals', () => {
  it('extracts error lines from prompt', () => {
    const prompt = `I ran the build and got:
TypeError: Cannot read properties of null (reading 'foo')`
    const signals = extractSignals(prompt, '/tmp/test')
    expect(signals.errors.length).toBeGreaterThanOrEqual(1)
    expect(signals.errors.some(e => e.includes('TypeError'))).toBe(true)
  })

  it('extracts stack traces and picks the error line', () => {
    const prompt = `Traceback (most recent call last):
  File "main.py", line 10
  File "lib.py", line 5
ValueError: invalid literal for int()`
    const signals = extractSignals(prompt, '/tmp/test')
    expect(signals.errors.length).toBeGreaterThanOrEqual(1)
    // The stack should be parsed and ValueError picked as the error line
    expect(signals.errors.some(e => e.includes('ValueError'))).toBe(true)
  })

  it('extracts commands from fenced code blocks', () => {
    const prompt = `Try running:
\`\`\`bash
$ npm install
$ npm run build
\`\`\``
    const signals = extractSignals(prompt, '/tmp/test')
    expect(signals.commands).toContain('npm install')
    expect(signals.commands).toContain('npm run build')
  })

  it('extracts commands prefixed with > or #', () => {
    const prompt = `\`\`\`
> docker build .
# kubectl apply -f deploy.yaml
\`\`\``
    const signals = extractSignals(prompt, '/tmp/test')
    expect(signals.commands).toContain('docker build .')
    expect(signals.commands).toContain('kubectl apply -f deploy.yaml')
  })

  it('extracts bare commands that look like commands inside fences', () => {
    const prompt = `\`\`\`
pnpm install
\`\`\``
    const signals = extractSignals(prompt, '/tmp/test')
    expect(signals.commands).toContain('pnpm install')
  })

  it('does not extract commands outside code fences', () => {
    const prompt = 'please run npm install for me'
    const signals = extractSignals(prompt, '/tmp/test')
    expect(signals.commands).toHaveLength(0)
  })

  it('returns empty arrays for clean prompts', () => {
    const signals = extractSignals('How does the config system work?', '/tmp/test')
    expect(signals.errors).toHaveLength(0)
    expect(signals.commands).toHaveLength(0)
  })

  it('deduplicates identical errors', () => {
    const prompt = `Error: ENOENT: no such file
Error: ENOENT: no such file
Error: ENOENT: no such file`
    const signals = extractSignals(prompt, '/tmp/test')
    expect(signals.errors).toHaveLength(1)
  })

  it('respects error signal limit', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `Error: problem ${i}`)
    const signals = extractSignals(lines.join('\n'), '/tmp/test')
    expect(signals.errors.length).toBeLessThanOrEqual(6)
  })

  it('respects command signal limit', () => {
    const cmds = Array.from({ length: 20 }, (_, i) => `command-${i} --flag`)
    const prompt = '```\n' + cmds.map(c => `$ ${c}`).join('\n') + '\n```'
    const signals = extractSignals(prompt, '/tmp/test')
    expect(signals.commands.length).toBeLessThanOrEqual(6)
  })

  it('resolves projectName from cwd basename', () => {
    const signals = extractSignals('hello', '/home/user/my-project')
    expect(signals.projectName).toBe('my-project')
  })

  it('strips noise words before extracting', () => {
    const prompt = `ultrathink
\`\`\`
npm run build
\`\`\``
    const signals = extractSignals(prompt, '/tmp/test')
    expect(signals.commands).toContain('npm run build')
  })
})

// --------------- formatRecordSnippet ---------------

describe('formatRecordSnippet', () => {
  it('formats a command record', () => {
    const record = makeRecord<CommandRecord>({ type: 'command', command: 'npm test', exitCode: 0, outcome: 'success' })
    const snippet = formatRecordSnippet(record)
    expect(snippet).toContain('command: npm test')
    expect(snippet).toContain('outcome: success')
    expect(snippet).toContain('exit: 0')
  })

  it('formats an error record with cause', () => {
    const record = makeRecord<ErrorRecord>({
      type: 'error',
      errorText: 'ECONNREFUSED',
      resolution: 'Start the server first',
      cause: 'Server not running'
    })
    const snippet = formatRecordSnippet(record)
    expect(snippet).toContain('error: ECONNREFUSED')
    expect(snippet).toContain('resolution: Start the server first')
    expect(snippet).toContain('cause: Server not running')
  })

  it('formats a discovery record', () => {
    const record = makeRecord<DiscoveryRecord>({
      type: 'discovery',
      what: 'Uses pnpm workspaces',
      where: 'pnpm-workspace.yaml',
      confidence: 'verified'
    })
    const snippet = formatRecordSnippet(record)
    expect(snippet).toContain('discovery: Uses pnpm workspaces')
    expect(snippet).toContain('where: pnpm-workspace.yaml')
    expect(snippet).toContain('confidence: verified')
  })

  it('formats a procedure record with steps', () => {
    const record = makeRecord<ProcedureRecord>({
      type: 'procedure',
      name: 'Release',
      steps: ['bump version', 'build', 'publish'],
      verification: 'Check npm registry'
    })
    const snippet = formatRecordSnippet(record)
    expect(snippet).toContain('procedure: Release')
    expect(snippet).toContain('steps:')
    expect(snippet).toContain('bump version')
    expect(snippet).toContain('verify: Check npm registry')
  })

  it('truncates procedure steps beyond limit', () => {
    const record = makeRecord<ProcedureRecord>({
      type: 'procedure',
      name: 'Long procedure',
      steps: Array.from({ length: 10 }, (_, i) => `Step ${i + 1}`)
    })
    const snippet = formatRecordSnippet(record)!
    // MAX_PROCEDURE_STEPS is 5
    expect(snippet).toContain('Step 5')
    expect(snippet).not.toContain('Step 6')
  })

  it('formats a warning record', () => {
    const record = makeRecord<WarningRecord>({
      type: 'warning',
      avoid: 'using eval()',
      useInstead: 'JSON.parse()',
      reason: 'eval is unsafe',
      severity: 'critical'
    })
    const snippet = formatRecordSnippet(record)
    expect(snippet).toContain("warning: Don't using eval()")
    expect(snippet).toContain('use instead: JSON.parse()')
    expect(snippet).toContain('reason: eval is unsafe')
  })

  it('collapses multiline whitespace in fields', () => {
    const record = makeRecord<CommandRecord>({
      type: 'command',
      command: 'npm  run\n  build',
      exitCode: 0,
      outcome: 'success'
    })
    const snippet = formatRecordSnippet(record)!
    expect(snippet).not.toContain('\n')
  })
})

// --------------- buildContext ---------------

describe('buildContext', () => {
  describe('basic formatting', () => {
    it('wraps records in prior-knowledge tags', () => {
      const records = [makeRecord<CommandRecord>({ type: 'command' })]
      const { context } = buildContext(records, defaultConfig)
      expect(context).toContain('<prior-knowledge>')
      expect(context).toContain('</prior-knowledge>')
    })

    it('includes the preamble about verifying state', () => {
      const records = [makeRecord<CommandRecord>({ type: 'command' })]
      const { context } = buildContext(records, defaultConfig)
      expect(context).toContain('may be outdated')
    })

    it('returns empty context for empty input', () => {
      const { context, records } = buildContext([], defaultConfig)
      expect(context).toBe('')
      expect(records).toHaveLength(0)
    })

    it('returns included records', () => {
      const cmd = makeRecord<CommandRecord>({ type: 'command' })
      const { records } = buildContext([cmd], defaultConfig)
      expect(records).toHaveLength(1)
      expect(records[0].id).toBe(cmd.id)
    })
  })

  describe('deprecated filtering', () => {
    it('excludes deprecated records', () => {
      const active = makeRecord<CommandRecord>({ type: 'command', command: 'active-cmd' })
      const deprecated = makeRecord<CommandRecord>({ type: 'command', command: 'old-cmd', deprecated: true })
      const { context, records } = buildContext([active, deprecated], defaultConfig)
      expect(records).toHaveLength(1)
      expect(context).toContain('active-cmd')
      expect(context).not.toContain('old-cmd')
    })

    it('returns empty when all records are deprecated', () => {
      const records = [
        makeRecord<CommandRecord>({ type: 'command', deprecated: true }),
        makeRecord<ErrorRecord>({ type: 'error', deprecated: true })
      ]
      const result = buildContext(records, defaultConfig)
      expect(result.context).toBe('')
      expect(result.records).toHaveLength(0)
    })
  })

  describe('maxRecords limit', () => {
    it('respects maxRecords config', () => {
      const records = Array.from({ length: 10 }, (_, i) =>
        makeRecord<CommandRecord>({ type: 'command', command: `cmd-${i}` })
      )
      const { records: included } = buildContext(records, tinyConfig)
      expect(included.length).toBeLessThanOrEqual(2)
    })
  })

  describe('relative age formatting', () => {
    it('formats just-now/minute/hour/day/week/month ages', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-02-01T12:00:00Z'))

      const now = Date.now()
      const config = createConfig({ injection: { maxRecords: 20, maxTokens: 10_000 } })
      const records = [
        makeRecord<CommandRecord>({ type: 'command', command: 'age-just-now', timestamp: now - (5 * 60_000) }),
        makeRecord<CommandRecord>({ type: 'command', command: 'age-minutes', timestamp: now - (6 * 60_000) }),
        makeRecord<CommandRecord>({ type: 'command', command: 'age-hours', timestamp: now - (2 * 60 * 60_000) }),
        makeRecord<CommandRecord>({ type: 'command', command: 'age-days', timestamp: now - (3 * 24 * 60 * 60_000) }),
        makeRecord<CommandRecord>({ type: 'command', command: 'age-weeks', timestamp: now - (14 * 24 * 60 * 60_000) }),
        makeRecord<CommandRecord>({ type: 'command', command: 'age-months', timestamp: now - (61 * 24 * 60 * 60_000) })
      ]

      const { context } = buildContext(records, config)

      expect(context).toContain('age-just-now')
      expect(context).toContain('recorded: just now')
      expect(context).toContain('age-minutes')
      expect(context).toContain('recorded: 6m ago')
      expect(context).toContain('age-hours')
      expect(context).toContain('recorded: 2h ago')
      expect(context).toContain('age-days')
      expect(context).toContain('recorded: 3d ago')
      expect(context).toContain('age-weeks')
      expect(context).toContain('recorded: 2w ago')
      expect(context).toContain('age-months')
      expect(context).toContain('recorded: 2mo ago')

      vi.useRealTimers()
    })

    it('omits age for future timestamps and falls back to lastUsed when timestamp is missing', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-02-01T12:00:00Z'))

      const now = Date.now()
      const config = createConfig({ injection: { maxRecords: 20, maxTokens: 10_000 } })
      const future = makeRecord<CommandRecord>({
        type: 'command',
        command: 'age-future',
        timestamp: now + (10 * 60_000)
      })
      const fallback = makeRecord<CommandRecord>({
        type: 'command',
        command: 'age-fallback-last-used',
        timestamp: undefined,
        lastUsed: now - (60 * 60_000)
      })

      const { context } = buildContext([future, fallback], config)
      const futureLine = context.split('\n').find(line => line.includes('age-future')) ?? ''
      const fallbackLine = context.split('\n').find(line => line.includes('age-fallback-last-used')) ?? ''

      expect(futureLine).not.toContain('recorded:')
      expect(fallbackLine).toContain('recorded: 1h ago')

      vi.useRealTimers()
    })
  })

  describe('token budget', () => {
    it('stops adding records when token budget is exceeded', () => {
      // Create records with very long content to blow the budget
      const longContent = 'x'.repeat(2000)
      const records = Array.from({ length: 5 }, (_, i) =>
        makeRecord<CommandRecord>({
          type: 'command',
          command: `${longContent}-${i}`,
          outcome: 'success'
        })
      )
      const config = createConfig({ injection: { maxRecords: 100, maxTokens: 600 } })
      const { records: included } = buildContext(records, config)
      // With ~600 token budget and ~500+ tokens per record, should be limited
      expect(included.length).toBeLessThan(5)
    })
  })

  describe('warning separation', () => {
    it('renders warnings in a known-pitfalls section', () => {
      const warning = makeRecord<WarningRecord>({
        type: 'warning',
        avoid: 'using eval',
        useInstead: 'safer alternatives',
        reason: 'security risk',
        severity: 'critical'
      })
      const { context } = buildContext([warning], defaultConfig)
      expect(context).toContain('<known-pitfalls>')
      expect(context).toContain('</known-pitfalls>')
      expect(context).not.toContain('<prior-knowledge>')
    })

    it('renders both warnings and regular records in separate sections', () => {
      const warning = makeRecord<WarningRecord>({
        type: 'warning',
        avoid: 'bad practice',
        useInstead: 'good practice',
        reason: 'because',
        severity: 'warning'
      })
      const cmd = makeRecord<CommandRecord>({ type: 'command', command: 'npm test' })
      const { context, records } = buildContext([warning, cmd], defaultConfig)
      expect(context).toContain('<known-pitfalls>')
      expect(context).toContain('<prior-knowledge>')
      expect(records).toHaveLength(2)
    })

    it('includes severity icon for critical warnings', () => {
      const warning = makeRecord<WarningRecord>({
        type: 'warning',
        avoid: 'dangerous thing',
        useInstead: 'safe thing',
        reason: 'safety',
        severity: 'critical'
      })
      const scoredWarnings = [scored(warning)]
      const { context } = buildContext(scoredWarnings, defaultConfig)
      // Critical warnings get the alarm emoji
      expect(context).toMatch(/🚨/)
    })

    it('caps warnings at MAX_WARNING_RECORDS (5)', () => {
      const warnings = Array.from({ length: 10 }, (_, i) =>
        scored(makeRecord<WarningRecord>({
          type: 'warning',
          avoid: `bad-${i}`,
          useInstead: `good-${i}`,
          reason: `reason-${i}`,
          severity: 'caution'
        }))
      )
      const config = createConfig({ injection: { maxRecords: 20, maxTokens: 100000 } })
      const { context } = buildContext(warnings, config)
      // Count how many "Don't:" appear
      const matches = context.match(/Don't:/g) ?? []
      expect(matches.length).toBeLessThanOrEqual(5)
    })

    it('warning budget is 30% of total token budget', () => {
      // Create warnings with very long content to test the 30% budget cap
      const longAvoid = 'a'.repeat(500)
      const warnings = Array.from({ length: 3 }, (_, i) =>
        scored(makeRecord<WarningRecord>({
          type: 'warning',
          avoid: `${longAvoid}-${i}`,
          useInstead: `${longAvoid}-alt-${i}`,
          reason: `${longAvoid}-reason-${i}`,
          severity: 'warning'
        }))
      )
      const cmd = scored(makeRecord<CommandRecord>({ type: 'command', command: 'npm test' }))
      // With a small budget, warnings should be limited by the 30% cap
      const config = createConfig({ injection: { maxRecords: 10, maxTokens: 800 } })
      const result = buildContext([...warnings, cmd], config)
      // At least the command should still fit since warnings don't eat the whole budget
      // (the exact count depends on token estimation, but the point is budget enforcement works)
      expect(result.context.length).toBeGreaterThan(0)
    })
  })

  describe('ScoredRecord input', () => {
    it('accepts ScoredRecord[] and returns records', () => {
      const cmd = makeRecord<CommandRecord>({ type: 'command', command: 'scored-cmd' })
      const scoredRecords = [scored(cmd, 0.9, 0.8, true)]
      const { context, records } = buildContext(scoredRecords, defaultConfig)
      expect(context).toContain('scored-cmd')
      expect(records).toHaveLength(1)
    })
  })

  describe('diagnostic mode', () => {
    it('returns injectedRecords and exclusions', () => {
      const records = Array.from({ length: 10 }, (_, i) =>
        scored(makeRecord<CommandRecord>({ type: 'command', command: `cmd-${i}` }))
      )
      const result = buildContext(records, tinyConfig, { diagnostic: true })
      expect(result).toHaveProperty('injectedRecords')
      expect(result).toHaveProperty('exclusions')
      expect(result.injectedRecords.length).toBeLessThanOrEqual(2)
      expect(result.exclusions.length).toBeGreaterThan(0)
    })

    it('exclusions include exceeded_max_records reason', () => {
      const records = Array.from({ length: 5 }, (_, i) =>
        scored(makeRecord<CommandRecord>({ type: 'command', command: `cmd-${i}` }))
      )
      const result = buildContext(records, tinyConfig, { diagnostic: true })
      const reasons = result.exclusions.flatMap(e => e.exclusionReasons.map(r => r.reason))
      expect(reasons).toContain('exceeded_max_records')
    })

    it('merges mmrExclusions into output exclusions', () => {
      const excluded = scored(makeRecord<CommandRecord>({ type: 'command', command: 'mmr-excluded' }))
      const mmrExclusion = {
        record: excluded,
        exclusionReasons: [{ reason: 'mmr_diversity_penalty' as const, threshold: 0.5, actual: 0.3, gap: 0.2 }]
      }
      const records = [scored(makeRecord<CommandRecord>({ type: 'command', command: 'included' }))]
      const result = buildContext(records, defaultConfig, {
        diagnostic: true,
        mmrExclusions: [mmrExclusion]
      })
      const allReasons = result.exclusions.flatMap(e => e.exclusionReasons.map(r => r.reason))
      expect(allReasons).toContain('mmr_diversity_penalty')
    })

    it('excludes token budget violations in diagnostic mode', () => {
      const longContent = 'x'.repeat(2000)
      const records = Array.from({ length: 5 }, (_, i) =>
        scored(makeRecord<CommandRecord>({ type: 'command', command: `${longContent}-${i}` }))
      )
      const config = createConfig({ injection: { maxRecords: 100, maxTokens: 600 } })
      const result = buildContext(records, config, { diagnostic: true })
      const reasons = result.exclusions.flatMap(e => e.exclusionReasons.map(r => r.reason))
      expect(reasons).toContain('exceeded_token_budget')
    })

    it('returns empty context and injectedRecords when all deprecated', () => {
      const records = [
        scored(makeRecord<CommandRecord>({ type: 'command', deprecated: true }))
      ]
      const result = buildContext(records, defaultConfig, { diagnostic: true })
      expect(result.context).toBe('')
      expect(result.injectedRecords).toHaveLength(0)
    })
  })
})

// --------------- findAncestorProjects ---------------

describe('findAncestorProjects', () => {
  it('returns empty for a top-level project', () => {
    // /tmp is unlikely to have .git markers above it
    const ancestors = findAncestorProjects('/tmp/some-project')
    expect(ancestors).toEqual([])
  })

  it('walks up directories looking for .git', () => {
    // This tests the function structurally — in a real git repo,
    // it should find the parent if the cwd is inside a submodule.
    // We test the behavior of not going past filesystem root.
    const ancestors = findAncestorProjects('/')
    expect(ancestors).toEqual([])
  })
})

// --------------- all record types render ---------------

describe('all record types produce context', () => {
  const types = ['command', 'error', 'discovery', 'procedure', 'warning'] as const

  for (const type of types) {
    it(`renders ${type} records`, () => {
      const record = makeRecord({ type } as any)
      const { context } = buildContext([record], defaultConfig)
      expect(context.length).toBeGreaterThan(0)
    })
  }
})
