import { MilvusClient } from '@zilliz/milvus2-sdk-node'
import { DEFAULT_CONFIG, type Config } from './types.js'
import {
  createCollection,
  ensureConsolidationCheckField,
  ensureConflictField,
  ensureGeneralizationFields,
  ensureGlobalCheckField,
  ensureScopeField,
  ensureSourceFields,
  ensureUsageFields,
  ensureWarningSynthesisField
} from './milvus-schema.js'

// Single-client module: switching configs replaces the active client for the process.
let client: MilvusClient | null = null
let activeConfig: Config | null = null

export async function initMilvus(config: Config = DEFAULT_CONFIG): Promise<void> {
  const nextClient = new MilvusClient({ address: config.milvus.address })
  client = nextClient
  activeConfig = config

  const hasCollection = await nextClient.hasCollection({
    collection_name: config.milvus.collection
  })

  if (!hasCollection.value) {
    await createCollection(nextClient, config)
  } else {
    await ensureUsageFields(nextClient, config)
    await ensureScopeField(nextClient, config)
    await ensureGeneralizationFields(nextClient, config)
    await ensureGlobalCheckField(nextClient, config)
    await ensureConsolidationCheckField(nextClient, config)
    await ensureConflictField(nextClient, config)
    await ensureWarningSynthesisField(nextClient, config)
    await ensureSourceFields(nextClient, config)
  }

  // Release first in case collection is in an inconsistent state
  try {
    await nextClient.releaseCollection({
      collection_name: config.milvus.collection
    })
  } catch {
    // Ignore - collection might not be loaded
  }

  await nextClient.loadCollection({
    collection_name: config.milvus.collection
  })
}

export async function closeMilvus(): Promise<void> {
  if (!client) return
  try {
    await client.closeConnection()
  } catch (error) {
    console.error('[claude-memory] Failed to close Milvus connection:', error)
  } finally {
    client = null
    activeConfig = null
  }
}

export async function ensureClient(config: Config): Promise<MilvusClient> {
  if (!client || !activeConfig || !isSameConfig(activeConfig, config)) {
    await initMilvus(config)
  }
  if (!client) throw new Error('Milvus client not initialized')
  return client
}

function isSameConfig(a: Config, b: Config): boolean {
  return a.milvus.address === b.milvus.address && a.milvus.collection === b.milvus.collection
}
