/**
 * LanceDB operations for Claude Memory.
 *
 * This is the canonical internal API surface. The legacy compatibility barrel
 * lives at `milvus.ts`.
 */

export type { MemoryStats } from '../../shared/types.js'

export { escapeFilterValue } from './shared.js'

export { initLanceDB, closeLanceDB, resolveDirectory } from './lancedb-client.js'

export {
  insertRecord,
  updateRecord,
  batchUpdateRecords,
  incrementRecordCounters,
  deleteRecord,
  deleteByFilter,
  resetCollection,
  getRecord,
  getRecordStats,
  flushCollection,
  queryRecords,
  fetchRecordsByIds,
  iterateRecords,
  countRecords
} from './lancedb-crud.js'
export type { FlushMode, WriteOptions } from './lancedb-crud.js'

export {
  hybridSearch,
  findSimilar,
  vectorSearchSimilar,
  buildFilter,
  buildKeywordFilter,
  escapeLikeValue,
  computeUsageRatio
} from './lancedb-search.js'

export { buildLanceRow, buildEmbeddingInput } from './lancedb-records.js'
