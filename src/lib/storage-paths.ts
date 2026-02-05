import { getCollectionKey } from './retrieval-events.js'
import { DEFAULT_CONFIG } from './types.js'

export function isDefaultCollection(collection?: string): boolean {
  return getCollectionKey(collection) === getCollectionKey(DEFAULT_CONFIG.milvus.collection)
}
