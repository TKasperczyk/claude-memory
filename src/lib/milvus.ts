/**
 * Milvus vector database operations for Claude Memory.
 */

export { escapeFilterValue } from './shared.js'
export type { MemoryStats } from '../../shared/types.js'

export { initMilvus, closeMilvus } from './milvus-client.js'
export {
  insertRecord,
  updateRecord,
  batchUpdateRecords,
  incrementRecordCounters,
  deleteRecord,
  resetCollection,
  getRecord,
  getRecordStats,
  flushCollection,
  getDomainExamples,
  queryRecords,
  fetchRecordsByIds,
  iterateRecords,
  countRecords
} from './milvus-crud.js'
export type { FlushMode, WriteOptions, DomainExample } from './milvus-crud.js'

export {
  hybridSearch,
  findSimilar,
  vectorSearchSimilar,
  buildFilter,
  buildKeywordFilter,
  escapeLikeValue
} from './milvus-search.js'

export { buildMilvusRow, buildEmbeddingInput } from './milvus-records.js'
