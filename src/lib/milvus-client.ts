import { MilvusClient } from '@zilliz/milvus2-sdk-node'
import { DEFAULT_CONFIG, type Config } from './types.js'
import { createCollection, ensureSchemaFields } from './milvus-schema.js'

const clientsByConfig = new Map<string, MilvusClient>()
const initByConfig = new Map<string, Promise<MilvusClient>>()
let closeGeneration = 0
let closeInProgress: Promise<void> | null = null

class MilvusInitializationCancelledError extends Error {
  constructor() {
    super('Milvus client initialization cancelled because closeMilvus() is in progress')
    this.name = 'MilvusInitializationCancelledError'
  }
}

function isInitializationCancelledError(error: unknown): boolean {
  return error instanceof MilvusInitializationCancelledError
}

function configKey(config: Config): string {
  return `${config.milvus.address}::${config.milvus.collection}`
}

export async function initMilvus(config: Config = DEFAULT_CONFIG): Promise<void> {
  await ensureClient(config)
}

async function createInitializedClient(config: Config): Promise<MilvusClient> {
  const nextClient = new MilvusClient({ address: config.milvus.address })

  const hasCollection = await nextClient.hasCollection({
    collection_name: config.milvus.collection
  })

  let schemaChanged = false
  if (!hasCollection.value) {
    await createCollection(nextClient, config)
    schemaChanged = true
  } else {
    schemaChanged = await ensureSchemaFields(nextClient, config)
  }

  if (schemaChanged) {
    // Schema changed: release and reload to pick up new fields
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
  } else {
    // Ensure collection is loaded (may be unloaded after Milvus restart
    // or if a previous process was killed mid-init)
    const loadState = await nextClient.getLoadState({
      collection_name: config.milvus.collection
    })
    if (loadState.state !== 'LoadStateLoaded') {
      await nextClient.loadCollection({
        collection_name: config.milvus.collection
      })
    }
  }

  return nextClient
}

export async function closeMilvus(): Promise<void> {
  if (closeInProgress) return closeInProgress

  const closingGeneration = ++closeGeneration
  closeInProgress = (async () => {
    const pendingInits = Array.from(new Set(initByConfig.values()))
    if (pendingInits.length > 0) {
      await Promise.allSettled(pendingInits)
    }

    const clients = Array.from(new Set(clientsByConfig.values()))
    for (const client of clients) {
      try {
        await client.closeConnection()
      } catch (error) {
        console.error('[claude-memory] Failed to close Milvus connection:', error)
      }
    }

    clientsByConfig.clear()
    initByConfig.clear()
  })().finally(() => {
    if (closingGeneration === closeGeneration) {
      closeInProgress = null
    }
  })

  return closeInProgress
}

export async function ensureClient(config: Config): Promise<MilvusClient> {
  if (closeInProgress) {
    await closeInProgress
  }

  const generationAtStart = closeGeneration
  const key = configKey(config)
  const existing = clientsByConfig.get(key)
  if (existing) return existing

  const inFlight = initByConfig.get(key)
  if (inFlight) return inFlight

  const initPromise = createInitializedClient(config)
    .then(async client => {
      if (generationAtStart !== closeGeneration || closeInProgress) {
        try {
          await client.closeConnection()
        } catch (error) {
          console.error('[claude-memory] Failed to close stale Milvus connection:', error)
        }
        throw new MilvusInitializationCancelledError()
      }

      clientsByConfig.set(key, client)
      return client
    })
    .catch(error => {
      if (!isInitializationCancelledError(error)) {
        console.error('[claude-memory] Failed to initialize Milvus client:', error)
      }
      throw error
    })
    .finally(() => {
      const current = initByConfig.get(key)
      if (current === initPromise) {
        initByConfig.delete(key)
      }
    })

  initByConfig.set(key, initPromise)

  try {
    return await initPromise
  } catch (error) {
    const initialized = clientsByConfig.get(key)
    if (initialized) {
      try {
        await initialized.closeConnection()
      } catch (closeError) {
        console.error('[claude-memory] Failed to close Milvus connection after init failure:', closeError)
      } finally {
        clientsByConfig.delete(key)
      }
    }
    throw error
  }
}
