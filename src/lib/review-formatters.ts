import type { MemoryRecord } from './types.js'
import { buildRecordSnippet, truncateSnippet } from './shared.js'

export function formatSimilarRecord(record: MemoryRecord, similarity: number): Record<string, unknown> {
  const summary = truncateSnippet(buildRecordSnippet(record), 160)
  return {
    id: record.id,
    type: record.type,
    similarity: Number(similarity.toFixed(3)),
    summary,
    project: record.project,
    domain: record.domain,
    scope: record.scope
  }
}
