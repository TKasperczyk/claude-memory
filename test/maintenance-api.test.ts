import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AUTO_MAINTENANCE_OPERATIONS, runAllMaintenance } from '../src/lib/maintenance-api.js'

const calls = vi.hoisted(() => [] as string[])

function result() {
  return { actions: [], summary: {}, candidates: [] }
}

vi.mock('../src/lib/maintenance/runners/index.js', () => ({
  runStaleCheck: vi.fn(async () => {
    calls.push('stale-check')
    return result()
  }),
  runStaleUnusedDeprecation: vi.fn(async () => {
    calls.push('stale-unused-deprecation')
    return result()
  }),
  runLowUsageDeprecation: vi.fn(async () => {
    calls.push('low-usage-deprecation')
    return result()
  }),
  runLowUsageCheck: vi.fn(async () => {
    calls.push('low-usage')
    return result()
  }),
  runQualityDeprecation: vi.fn(async () => {
    calls.push('quality-deprecation')
    return result()
  }),
  runConsolidation: vi.fn(async () => {
    calls.push('consolidation')
    return result()
  }),
  runCrossTypeConsolidation: vi.fn(async () => {
    calls.push('cross-type-consolidation')
    return result()
  }),
  runRelationDiscovery: vi.fn(async () => {
    calls.push('relation-discovery')
    return result()
  }),
  runGlobalPromotion: vi.fn(async () => {
    calls.push('global-promotion')
    return result()
  }),
  runWarningSynthesis: vi.fn(async () => {
    calls.push('warning-synthesis')
    return result()
  })
}))

vi.mock('../src/lib/maintenance.js', () => ({
  runConflictResolution: vi.fn(async () => {
    calls.push('conflict-resolution')
    return result()
  })
}))

describe('maintenance API run order', () => {
  beforeEach(() => {
    calls.length = 0
  })

  it('runs auto maintenance in replacement-aware order before stale-check', async () => {
    const results = await runAllMaintenance(true)

    expect(results.map(result => result.operation)).toEqual(AUTO_MAINTENANCE_OPERATIONS)
    expect(calls).toEqual(AUTO_MAINTENANCE_OPERATIONS)
    expect(calls.indexOf('consolidation')).toBeLessThan(calls.indexOf('stale-check'))
    expect(calls.indexOf('conflict-resolution')).toBeLessThan(calls.indexOf('stale-check'))
  })
})
