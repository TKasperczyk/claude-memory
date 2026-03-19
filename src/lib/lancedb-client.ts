import fs from 'fs'
import path from 'path'
import { homedir } from 'os'
import { connect, type Connection, type Table } from '@lancedb/lancedb'
import { DEFAULT_CONFIG, type Config } from './types.js'
import { buildTableSchema, ensureSchemaFields } from './lancedb-schema.js'

type LanceContext = {
  conn: Connection
  table: Table
}

const clientsByConfig = new Map<string, LanceContext>()
const initByConfig = new Map<string, Promise<LanceContext>>()
let closeGeneration = 0
let closeInProgress: Promise<void> | null = null

class LanceInitializationCancelledError extends Error {
  constructor() {
    super('LanceDB initialization cancelled because closeLanceDB() is in progress')
    this.name = 'LanceInitializationCancelledError'
  }
}

function isInitializationCancelledError(error: unknown): boolean {
  return error instanceof LanceInitializationCancelledError
}

export function resolveDirectory(directory: string): string {
  const trimmed = directory.trim()
  if (trimmed === '') return path.join(homedir(), '.claude-memory', 'lancedb')
  if (trimmed === '~') return homedir()
  if (trimmed.startsWith('~/')) return path.join(homedir(), trimmed.slice(2))
  return trimmed
}

function configKey(config: Config): string {
  const dir = resolveDirectory(config.lancedb.directory)
  return `${dir}::${config.lancedb.table}`
}

export async function initLanceDB(config: Config = DEFAULT_CONFIG): Promise<void> {
  await ensureClient(config)
}

async function createInitializedClient(config: Config): Promise<LanceContext> {
  const directory = resolveDirectory(config.lancedb.directory)
  const tableName = config.lancedb.table

  try {
    fs.mkdirSync(directory, { recursive: true })
  } catch (error) {
    console.error('[claude-memory] Failed to create LanceDB directory:', directory, error)
    throw error
  }

  const conn = await connect(directory)

  const existing = await conn.tableNames()
  if (!existing.includes(tableName)) {
    const schema = buildTableSchema()
    await conn.createEmptyTable(tableName, schema, { mode: 'create', existOk: true })
    console.error('[claude-memory] Created LanceDB table:', tableName)
  }

  const table = await conn.openTable(tableName)
  await ensureSchemaFields(table, config)

  return { conn, table }
}

export async function closeLanceDB(): Promise<void> {
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
        client.table.close()
      } catch (error) {
        console.error('[claude-memory] Failed to close LanceDB table:', error)
      }
      try {
        client.conn.close()
      } catch (error) {
        console.error('[claude-memory] Failed to close LanceDB connection:', error)
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

export async function ensureClient(config: Config): Promise<LanceContext> {
  if (closeInProgress) {
    await closeInProgress
  }

  const generationAtStart = closeGeneration
  const key = configKey(config)
  const existing = clientsByConfig.get(key)
  if (existing) {
    await existing.table.checkoutLatest()
    return existing
  }

  const inFlight = initByConfig.get(key)
  if (inFlight) return inFlight

  const initPromise = createInitializedClient(config)
    .then(ctx => {
      if (generationAtStart !== closeGeneration || closeInProgress) {
        try {
          ctx.table.close()
        } catch (error) {
          console.error('[claude-memory] Failed to close stale LanceDB table:', error)
        }
        try {
          ctx.conn.close()
        } catch (error) {
          console.error('[claude-memory] Failed to close stale LanceDB connection:', error)
        }
        throw new LanceInitializationCancelledError()
      }

      clientsByConfig.set(key, ctx)
      return ctx
    })
    .catch(error => {
      if (!isInitializationCancelledError(error)) {
        console.error('[claude-memory] Failed to initialize LanceDB:', error)
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
        initialized.table.close()
      } catch (closeError) {
        console.error('[claude-memory] Failed to close LanceDB table after init failure:', closeError)
      }
      try {
        initialized.conn.close()
      } catch (closeError) {
        console.error('[claude-memory] Failed to close LanceDB connection after init failure:', closeError)
      } finally {
        clientsByConfig.delete(key)
      }
    }
    throw error
  }
}
