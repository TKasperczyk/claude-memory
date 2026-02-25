import type { Request } from 'express'
import type { Config } from '../../../src/lib/types.js'

/**
 * Header name for LanceDB table override.
 * Allows evaluation frameworks to use a separate table without affecting production data.
 */
export const COLLECTION_HEADER = 'x-lancedb-table'

/**
 * Get a config with optional table override from request header.
 * If X-LanceDB-Table header is present, returns a derived config with that table.
 * Otherwise returns the base config unchanged.
 */
export function getRequestConfig(req: Request, baseConfig: Config): Config {
  const collectionOverride = req.header(COLLECTION_HEADER)
  if (!collectionOverride || collectionOverride === baseConfig.lancedb.table) {
    return baseConfig
  }
  return {
    ...baseConfig,
    lancedb: {
      ...baseConfig.lancedb,
      table: collectionOverride
    }
  }
}
