import type { Request } from 'express'
import { ensureClient } from '../../../src/lib/lancedb-client.js'
import type { Config } from '../../../src/lib/types.js'
import { getRequestConfig } from './config.js'

/**
 * Ensure LanceDB is initialized for the given config.
 * Handles table override via X-LanceDB-Table header.
 */
export async function ensureConfigInitialized(
  req: Request,
  baseConfig: Config
): Promise<Config> {
  const config = getRequestConfig(req, baseConfig)
  await ensureClient(config)
  return config
}
