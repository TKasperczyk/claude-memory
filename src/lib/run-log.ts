import { JsonStore, isDefaultCollection } from './file-store.js'
import { loadSettings, type Settings } from './settings.js'

export abstract class RunLog<T extends { runId: string; timestamp: number }> {
  private store: JsonStore
  private feature: string
  private retentionKey: keyof Settings

  constructor(feature: string, retentionKey: keyof Settings) {
    this.store = new JsonStore(feature)
    this.feature = feature
    this.retentionKey = retentionKey
  }

  protected abstract coerce(data: unknown, runId: string): T | null

  save(run: T, collection?: string): void {
    try {
      this.cleanup(collection)
      this.store.write(run.runId, run, {
        collection,
        ensureDir: true,
        pretty: 2
      })
    } catch (error) {
      console.error(`[claude-memory] Failed to write ${this.feature} log:`, error)
    }
  }

  get(runId: string, collection?: string): T | null {
    return this.store.read(runId, {
      collection,
      includeLegacyForDefault: isDefaultCollection(collection),
      errorMessage: `[claude-memory] Failed to read ${this.feature} log:`,
      coerce: (data: unknown) => this.coerce(data, runId),
      fallback: null
    })
  }

  list(collection?: string): T[] {
    try {
      const ids = this.store.list({
        collection,
        includeLegacyForDefault: isDefaultCollection(collection)
      })
      const runs: T[] = []

      for (const runId of ids) {
        const run = this.get(runId, collection)
        if (run) runs.push(run)
      }

      runs.sort((a, b) => b.timestamp - a.timestamp)
      return runs
    } catch (error) {
      console.error(`[claude-memory] Failed to list ${this.feature}:`, error)
      return []
    }
  }

  getLast(collection?: string): T | null {
    const runs = this.list(collection)
    return runs[0] ?? null
  }

  delete(runId: string, collection?: string): boolean {
    try {
      return this.store.delete(runId, {
        collection,
        includeLegacyForDefault: isDefaultCollection(collection)
      })
    } catch (error) {
      console.error(`[claude-memory] Failed to delete ${this.feature} log:`, error)
      throw error
    }
  }

  cleanup(collection?: string): void {
    const settings = loadSettings()
    const daysToKeep = settings[this.retentionKey]
    if (typeof daysToKeep !== 'number') return
    const cutoff = Date.now() - Math.max(daysToKeep, 1) * 24 * 60 * 60 * 1000

    try {
      this.store.cleanupByAge({
        collection,
        cutoffMs: cutoff,
        includeLegacyForDefault: isDefaultCollection(collection)
      })
    } catch (error) {
      console.error(`[claude-memory] Failed to clean up ${this.feature} logs:`, error)
    }
  }
}
