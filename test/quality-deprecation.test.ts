import { describe, expect, it } from 'vitest'
import { classifyQualityDeprecationCandidate } from '../src/lib/maintenance/runners/quality-deprecation-runner.js'
import {
  createMockCommandRecord,
  createMockDiscoveryRecord,
  createMockErrorRecord,
  createMockWarningRecord
} from './helpers.js'

describe('quality deprecation heuristics', () => {
  it('matches primary tool-result prefixes', () => {
    const record = createMockDiscoveryRecord({
      what: '[Tool Result] {"stdout":"","stderr":""}',
      evidence: 'raw tool output',
      where: 'transcript'
    })

    expect(classifyQualityDeprecationCandidate(record)?.reason).toBe('quality:tool-result-prefix')
  })

  it('matches persisted output pointer records with no substantive content', () => {
    const record = createMockDiscoveryRecord({
      what: '<persisted-output> Output too large. Full output saved to /tmp/run.log',
      evidence: 'raw output pointer',
      where: 'transcript'
    })

    expect(classifyQualityDeprecationCandidate(record)?.reason).toBe('quality:persisted-output-pointer')
  })

  it('matches vague extension errors without a workaround', () => {
    const record = createMockErrorRecord({
      errorText: 'Error: Extension disconnected',
      resolution: 'retry',
      cause: undefined
    })

    expect(classifyQualityDeprecationCandidate(record)?.reason).toBe('quality:vague-extension-error')
  })

  it('matches raw metric dump command output without a summary', () => {
    const record = createMockCommandRecord({
      command: 'python scripts/train_rl.py',
      resolution: undefined,
      truncatedOutput: [
        'Mean reward: -0.2108 +/- 0.1243',
        'equity: $998.31',
        'checkpoint: /tmp/models/ppo_run.zip',
        'loss: 0.013'
      ].join('\n')
    })

    expect(classifyQualityDeprecationCandidate(record)?.reason).toBe('quality:raw-metric-dump')
  })

  it('does not match concise durable discoveries by length alone', () => {
    const record = createMockDiscoveryRecord({
      what: 'VR 180 format requirements',
      where: 'video export docs',
      evidence: 'Needs 180 metadata and stereo layout.',
      confidence: 'verified'
    })

    expect(classifyQualityDeprecationCandidate(record)).toBeNull()
  })

  it('does not match RL outcome discoveries that discuss metrics', () => {
    const record = createMockDiscoveryRecord({
      what: 'PPO RL agent failed to learn a profitable strategy',
      where: 'training run summary',
      evidence: 'Mean reward: -0.2108, which indicates the strategy remained unprofitable.',
      confidence: 'verified'
    })

    expect(classifyQualityDeprecationCandidate(record)).toBeNull()
  })

  it('does not match warnings with actionable extension workarounds', () => {
    const record = createMockWarningRecord({
      avoid: 'Error: Extension disconnected',
      useInstead: 'Use the API polling path because browser extension sessions can disconnect during long waits.',
      reason: 'The extension timeout is transient, but the API polling path survives long-running operations.'
    })

    expect(classifyQualityDeprecationCandidate(record)).toBeNull()
  })

  it('does not match vague extension errors with concise workarounds', () => {
    const record = createMockErrorRecord({
      errorText: 'Error: Extension disconnected',
      resolution: 'Reload the extension'
    })

    expect(classifyQualityDeprecationCandidate(record)).toBeNull()
  })

  it('does not match metric-heavy commands with a durable resolution', () => {
    const record = createMockCommandRecord({
      command: 'python scripts/train_rl.py',
      resolution: 'rerun with --lr 1e-4',
      truncatedOutput: [
        'Mean reward: -2.8 +/- 0.3',
        'equity: $997.20',
        'checkpoint: /tmp/models/ppo_run.zip',
        'loss: 0.041'
      ].join('\n')
    })

    expect(classifyQualityDeprecationCandidate(record)).toBeNull()
  })
})
