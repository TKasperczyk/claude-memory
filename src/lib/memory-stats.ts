import { iterateRecords } from './lancedb.js'
import { DEFAULT_CONFIG, type Config } from './types.js'
import type { MemoryStatsSummary } from '../../shared/types.js'

export async function buildMemoryStats(
  config: Config = DEFAULT_CONFIG
): Promise<MemoryStatsSummary> {
  const stats: MemoryStatsSummary = {
    total: 0,
    active: 0,
    totalAll: 0,
    byType: {},
    byProject: {},
    byScope: {},
    avgRetrievalCount: 0,
    avgUsageCount: 0,
    avgUsageRatio: 0,
    deprecated: 0
  }

  let totalActive = 0
  let totalAll = 0
  let totalRetrieval = 0
  let totalUsage = 0
  let recordsWithRetrieval = 0

  for await (const record of iterateRecords({}, config)) {
    totalAll += 1
    if (record.deprecated) {
      stats.deprecated += 1
      continue
    }

    totalActive += 1
    stats.byType[record.type] = (stats.byType[record.type] ?? 0) + 1

    const project = record.project ?? 'unknown'
    stats.byProject[project] = (stats.byProject[project] ?? 0) + 1

    const scope = record.scope ?? 'project'
    stats.byScope[scope] = (stats.byScope[scope] ?? 0) + 1

    const retrieval = record.retrievalCount ?? 0
    const usage = record.usageCount ?? 0
    if (retrieval > 0) {
      recordsWithRetrieval += 1
      totalRetrieval += retrieval
      totalUsage += usage
    }
  }

  stats.total = totalActive
  stats.active = totalActive
  stats.totalAll = totalAll

  if (recordsWithRetrieval > 0) {
    stats.avgRetrievalCount = totalRetrieval / recordsWithRetrieval
    stats.avgUsageCount = totalUsage / recordsWithRetrieval
    stats.avgUsageRatio = totalUsage / totalRetrieval
  }

  return stats
}
