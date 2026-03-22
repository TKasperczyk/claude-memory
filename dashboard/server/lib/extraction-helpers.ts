import { listExtractionRuns, getExtractionRun } from '../../../src/lib/extraction-log.js'
import { getReview } from '../../../src/lib/review-storage.js'
import { fetchRecordsByIds } from '../../../src/lib/lancedb.js'
import type { Config, MemoryRecord } from '../../../src/lib/types.js'
import type { ExtractionReview, ExtractionRun } from '../../../shared/types.js'

export interface PaginatedExtractionRuns {
  runs: ExtractionRun[]
  count: number
  total: number
  offset: number
  limit: number
}

export function paginateExtractionRuns(table: string, limit: number, offset: number, sessionId?: string): PaginatedExtractionRuns {
  let runs = listExtractionRuns(table)
  if (sessionId) {
    const search = sessionId.toLowerCase()
    runs = runs.filter(run => run.sessionId.toLowerCase().includes(search))
  }
  const page = runs.slice(offset, offset + limit)
  return { runs: page, count: page.length, total: runs.length, offset, limit }
}

export interface ExtractionRunDetail {
  run: ExtractionRun
  records?: MemoryRecord[]
  review?: ExtractionReview | null
}

export async function loadExtractionRunDetail(
  runId: string,
  config: Config,
  options: { includeRecords?: boolean; includeReview?: boolean } = {}
): Promise<ExtractionRunDetail | null> {
  const { includeRecords = true, includeReview = true } = options
  const table = config.lancedb.table
  const run = getExtractionRun(runId, table)
  if (!run) return null

  let records: MemoryRecord[] | undefined
  if (includeRecords) {
    const insertedIds = run.extractedRecordIds ?? []
    const updatedIds = run.updatedRecordIds ?? []
    const ids = Array.from(new Set([...insertedIds, ...updatedIds]))
    records = ids.length > 0 ? await fetchRecordsByIds(ids, config) : []
  }

  let review: ExtractionReview | null | undefined
  if (includeReview) {
    review = getReview(runId, table)
  }

  return { run, records, review }
}
