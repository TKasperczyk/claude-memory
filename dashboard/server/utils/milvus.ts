import type { Request } from 'express'
import { ensureClient } from '../../../src/lib/milvus-client.js'
import type { Config } from '../../../src/lib/types.js'
import { getRequestConfig } from './config.js'

/**
 * Ensure Milvus is initialized for the given config.
 * Handles collection override via X-Milvus-Collection header.
 */
export async function ensureConfigInitialized(
  req: Request,
  baseConfig: Config
): Promise<Config> {
  const config = getRequestConfig(req, baseConfig)
  await ensureClient(config)
  return config
}
