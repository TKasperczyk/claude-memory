import type { NextFunction, Request, Response } from 'express'
import { isValidTableName } from '../../../src/lib/shared.js'
import type { Config } from '../../../src/lib/types.js'
import type { ServerContext } from '../context.js'

/**
 * Header name for LanceDB table override.
 * Allows evaluation frameworks to use a separate table without affecting production data.
 */
export const COLLECTION_HEADER = 'x-lancedb-table'

export class InvalidTableHeaderError extends Error {
  readonly status = 400

  constructor(value: string) {
    super(`Invalid ${COLLECTION_HEADER} header "${value}": must match /^[a-zA-Z0-9_-]{1,64}$/`)
    this.name = 'InvalidTableHeaderError'
  }
}

export function resolveBaseConfig(context: ServerContext): Config {
  return context.getConfig ? context.getConfig() : context.config
}

/**
 * Express middleware that validates X-LanceDB-Table when provided.
 */
export function validateCollectionHeaderMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const raw = req.header(COLLECTION_HEADER)
  if (raw !== undefined) {
    const trimmed = raw.trim()
    if (!trimmed || !isValidTableName(trimmed)) {
      res.status(400).json({
        error: `Invalid ${COLLECTION_HEADER} header: must match /^[a-zA-Z0-9_-]{1,64}$/`
      })
      return
    }
  }
  next()
}

/**
 * Get a config with optional table override from request header.
 * If X-LanceDB-Table header is present, validates it and returns a derived config with that table.
 * Otherwise returns the base config unchanged.
 */
export function getRequestConfig(req: Request, baseConfig: Config): Config {
  const rawOverride = req.header(COLLECTION_HEADER)
  if (rawOverride === undefined) {
    return baseConfig
  }
  const collectionOverride = rawOverride.trim()
  if (!collectionOverride || !isValidTableName(collectionOverride)) {
    throw new InvalidTableHeaderError(rawOverride)
  }
  if (collectionOverride === baseConfig.lancedb.table) {
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
