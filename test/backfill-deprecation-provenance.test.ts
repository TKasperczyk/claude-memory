import { describe, expect, it } from 'vitest'
import { collectDeprecationProvenance } from '../scripts/backfill-deprecation-provenance.js'

describe('deprecation provenance backfill parsing', () => {
  it('extracts earliest provenance and prefers merge metadata over direct deprecations', () => {
    const runs = [
      {
        runId: 'earliest-run',
        timestamp: 1000,
        results: [
          {
            operation: 'stale-unused-deprecation',
            actions: [
              { type: 'deprecate', recordId: 'direct-a', reason: 'stale-unused:30 days old, never used' },
              { type: 'deprecate', recordId: 'merge-over-direct', reason: 'stale-unused:30 days old, never used' }
            ]
          },
          {
            operation: 'consolidation',
            actions: [
              {
                type: 'merge',
                recordId: 'keeper-1',
                reason: 'merge 2 duplicates',
                details: {
                  keptId: 'keeper-1',
                  deprecatedIds: ['merge-a'],
                  deprecatedRecords: [{ id: 'merge-b', snippet: 'duplicate memory' }]
                }
              }
            ]
          }
        ]
      },
      {
        runId: 'middle-run',
        timestamp: 2000,
        results: [
          {
            operation: 'cross-type-consolidation',
            actions: [
              {
                type: 'merge',
                recordId: 'keeper-2',
                reason: 'merge 1 cross-type duplicate',
                details: {
                  keptId: 'keeper-2',
                  deprecatedIds: ['merge-over-direct']
                }
              }
            ]
          },
          {
            operation: 'consolidation',
            actions: [
              {
                type: 'merge',
                recordId: 'keeper-later',
                reason: 'later duplicate merge',
                details: {
                  keptId: 'keeper-later',
                  deprecatedIds: ['merge-a']
                }
              }
            ]
          }
        ]
      },
      {
        runId: 'latest-run',
        timestamp: 3000,
        results: [
          {
            operation: 'low-usage',
            actions: [
              { type: 'deprecate', recordId: 'direct-a', reason: 'low-usage:10% over 10 retrievals' }
            ]
          }
        ]
      }
    ]

    const result = collectDeprecationProvenance(runs)

    expect(result.stats.mergeLogEntries).toBe(4)
    expect(result.stats.directLogEntries).toBe(3)
    expect(result.stats.uniqueRecords).toBe(4)
    expect(result.stats.uniqueMergeRecords).toBe(3)
    expect(result.stats.uniqueDirectRecords).toBe(1)
    expect(result.stats.mergePrecedenceReplacements).toBe(1)

    expect(result.byId.get('direct-a')).toMatchObject({
      kind: 'direct',
      timestamp: 1000,
      reason: 'stale-unused-deprecation:stale-unused:30 days old, never used'
    })
    expect(result.byId.get('merge-a')).toMatchObject({
      kind: 'merge',
      timestamp: 1000,
      reason: 'consolidation:merged-into:keeper-1',
      supersedingRecordId: 'keeper-1'
    })
    expect(result.byId.get('merge-b')).toMatchObject({
      kind: 'merge',
      timestamp: 1000,
      reason: 'consolidation:merged-into:keeper-1',
      supersedingRecordId: 'keeper-1'
    })
    expect(result.byId.get('merge-over-direct')).toMatchObject({
      kind: 'merge',
      timestamp: 2000,
      reason: 'cross-type-consolidation:merged-into:keeper-2',
      supersedingRecordId: 'keeper-2'
    })
  })
})
