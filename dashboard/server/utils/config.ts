import type { Request } from 'express'
import type { Config } from '../../../src/lib/types.js'

/**
 * Header name for collection override.
 * Allows evaluation frameworks to use a separate collection without affecting production data.
 */
export const COLLECTION_HEADER = 'x-milvus-collection'

/**
 * Get a config with optional collection override from request header.
 * If X-Milvus-Collection header is present, returns a derived config with that collection.
 * Otherwise returns the base config unchanged.
 */
export function getRequestConfig(req: Request, baseConfig: Config): Config {
  const collectionOverride = req.header(COLLECTION_HEADER)
  if (!collectionOverride || collectionOverride === baseConfig.milvus.collection) {
    return baseConfig
  }
  return {
    ...baseConfig,
    milvus: {
      ...baseConfig.milvus,
      collection: collectionOverride
    }
  }
}
