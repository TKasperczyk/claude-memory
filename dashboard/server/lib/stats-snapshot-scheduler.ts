import { buildMemoryStats } from '../../../src/lib/memory-stats.js'
import { saveStatsSnapshotIfNeeded } from '../../../src/lib/stats-snapshots.js'
import { DAY_MS, startOfDayUtc } from '../../../src/lib/time-buckets.js'
import type { Config } from '../../../src/lib/types.js'
import { createLogger } from './logger.js'

const logger = createLogger('stats-snapshots')

export function startStatsSnapshotScheduler(config: Config): void {
  const runSnapshot = async (): Promise<void> => {
    try {
      const stats = await buildMemoryStats(config)
      const snapshot = saveStatsSnapshotIfNeeded(stats, { collection: config.lancedb.table })
      if (snapshot) {
        logger.info('Captured stats snapshot', { timestamp: snapshot.timestamp })
      }
    } catch (error) {
      logger.error('Failed to capture stats snapshot', error)
    }
  }

  const scheduleNext = (): void => {
    const now = Date.now()
    const nextRun = startOfDayUtc(now) + DAY_MS
    const delay = Math.max(0, nextRun - now)
    setTimeout(async () => {
      await runSnapshot()
      scheduleNext()
    }, delay)
  }

  void runSnapshot()
  scheduleNext()
}
