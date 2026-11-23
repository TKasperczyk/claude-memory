/**
 * LanceDB operations for Claude Memory.
 *
 * Canonical internal API surface for vector database operations.
 */

export type { MemoryStats } from '../../shared/types.js'

export { escapeFilterValue } from './shared.js'

export { initLanceDB, closeLanceDB, compactTable, ensureFtsIndex, resolveDirectory } from './lancedb-client.js'

export {
  insertRecord,
  updateRecord,
  batchUpdateRecords,
  backfillSearchText,
  incrementRecordCounters,
  deleteRecord,
  deleteByFilter,
  deleteRecordsByIds,
  resetCollection,
  getRecord,
  resolveMemoryRecord,
  getRecordStats,
  flushCollection,
  queryRecords,
  fetchRecordsByIds,
  iterateRecords,
  countRecords
} from './lancedb-crud.js'
export type {
  BackfillSearchTextResult,
  BatchUpdateFailure,
  BatchUpdateOptions,
  BatchUpdateResult,
  FlushMode,
  MemoryRecordResolution,
  WriteOptions
} from './lancedb-crud.js'

export {
  hybridSearch,
  bm25Search,
  findSimilar,
  vectorSearchSimilar,
  buildFilter,
  buildKeywordFilter,
  escapeLikeValue,
  computeUsageRatio,
  computeSmoothedUsageRatio
} from './lancedb-search.js'

export { buildLanceRow, buildEmbeddingInput } from './lancedb-records.js'
