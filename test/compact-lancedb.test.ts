import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '../src/lib/types.js'
import {
  classifyLsofResult,
  main,
  parseCompactArgs,
  parseLsofProcesses,
  requiredFreeBytes
} from '../scripts/compact-lancedb.js'

function createExecutionHarness() {
  const collection = DEFAULT_CONFIG.lancedb.table
  const tablePath = `/tmp/lancedb/${collection}.lance`
  const optimize = vi.fn(async () => ({
    compaction: { fragmentsAdded: 1, fragmentsRemoved: 2 },
    prune: { bytesRemoved: 0, oldVersionsRemoved: 0 }
  }))
  const table = {
    checkoutLatest: vi.fn(async () => {}),
    close: vi.fn(),
    countRows: vi.fn()
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(3),
    optimize,
    stats: vi.fn(async () => ({
      fragmentStats: { numFragments: 2, numSmallFragments: 1 }
    })),
    version: vi.fn()
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(5)
  }
  const connection = {
    close: vi.fn(),
    openTable: vi.fn(async () => table),
    tableNames: vi.fn(async () => [collection])
  }
  const connect = vi.fn(async () => connection)
  const question = vi.fn(async () => `PRUNE ${collection}`)
  const runPreflight = vi.fn(() => ({
    tablePath,
    tableBytes: 1024n,
    availableBytes: 2n * 1024n * 1024n * 1024n,
    requiredFreeBytes: requiredFreeBytes(1024n),
    diskHeadroomOk: true,
    processChecksAvailable: true,
    processes: [],
    errors: []
  }))

  return {
    connect,
    optimize,
    question,
    runtime: {
      connect: connect as never,
      cwd: () => '/tmp/project',
      inputIsTTY: () => true,
      loadConfig: () => DEFAULT_CONFIG,
      outputIsTTY: () => true,
      question,
      resolveLocalTablePath: () => ({ directory: '/tmp/lancedb', tablePath }),
      runPreflight
    }
  }
}

describe('compact-lancedb CLI safety', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('defaults to dry-run without history pruning', () => {
    expect(parseCompactArgs([])).toEqual({ apply: false, help: false })
    expect(parseCompactArgs(['--', '--apply'])).toMatchObject({ apply: true })
  })

  it('requires a conservative pruning retention', () => {
    expect(() => parseCompactArgs(['--apply', '--prune-older-than-days', '0'])).toThrow('at least 7')
    expect(parseCompactArgs(['--apply', '--prune-older-than-days', '30'])).toMatchObject({
      apply: true,
      pruneOlderThanDays: 30
    })
  })

  it('requires free space equal to table size plus fixed headroom', () => {
    expect(requiredFreeBytes(1024n)).toBe(1024n + 512n * 1024n * 1024n)
  })

  it('deduplicates lsof process records and ignores the current process', () => {
    expect(parseLsofProcesses([
      `p${process.pid}`,
      'cself',
      'p123',
      'cnode',
      'p123',
      'cnode'
    ].join('\n'))).toEqual([{ pid: 123, command: 'node', source: 'lsof' }])
  })

  it('treats status 1 with only unrelated lsof mount warnings as no matches', () => {
    const tablePath = '/home/user/.claude-memory/lancedb/cc_memories.lance'
    const unrelatedWarnings = [
      "lsof: WARNING: can't stat() overlay file system /mnt/docker/overlay2/example/merged",
      '      Output information may be incomplete.',
      "lsof: WARNING: can't stat() nsfs file system /run/docker/netns/default",
      '      Output information may be incomplete.'
    ].join('\n')

    expect(classifyLsofResult({ status: 1, stdout: '', stderr: unrelatedWarnings }, tablePath)).toEqual({
      available: true,
      processes: []
    })
    expect(classifyLsofResult({
      status: 1,
      stdout: '',
      stderr: `lsof: status error on ${tablePath}: Permission denied`
    }, tablePath)).toMatchObject({ available: false })
    expect(classifyLsofResult({
      status: 1,
      stdout: '',
      stderr: [
        "lsof: WARNING: can't stat() ext4 file system /home/user/.claude-memory",
        '      Output information may be incomplete.'
      ].join('\n')
    }, tablePath)).toMatchObject({ available: false })
  })

  it('does not open a LanceDB connection during the default dry-run', async () => {
    const harness = createExecutionHarness()

    await main([], harness.runtime)

    expect(harness.connect).not.toHaveBeenCalled()
  })

  it('rejects non-interactive history pruning before opening a connection', async () => {
    const harness = createExecutionHarness()

    await expect(main(['--apply', '--prune-older-than-days', '30'], {
      ...harness.runtime,
      inputIsTTY: () => false
    })).rejects.toThrow('requires an interactive terminal confirmation')

    expect(harness.question).not.toHaveBeenCalled()
    expect(harness.connect).not.toHaveBeenCalled()
  })

  it('passes deleteUnverified false to every optimize call', async () => {
    const optimizeCalls: unknown[][] = []

    for (const argv of [
      ['--apply'],
      ['--apply', '--prune-older-than-days', '30']
    ]) {
      const harness = createExecutionHarness()
      await main(argv, harness.runtime)
      optimizeCalls.push(...harness.optimize.mock.calls)
    }

    expect(optimizeCalls).toHaveLength(2)
    for (const [options] of optimizeCalls) {
      expect(options).toMatchObject({ deleteUnverified: false })
    }
  })
})
