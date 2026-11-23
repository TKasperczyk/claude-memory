import { JsonLinesStore } from './file-store.js'
import type { InjectionStatus } from './types.js'

export interface PrePromptTelemetryTimings {
  totalMs: number
  stage1EmbedMs?: number
  stage1SearchMs?: number
  stage2RerankMs?: number
}

export interface PrePromptTelemetryEvent {
  timestamp: number
  sessionId?: string
  cwd: string
  project?: string
  status: InjectionStatus
  pipeline: 'stage2-rerank' | 'legacy' | 'short-circuit'
  promptLength: number
  errorSignalCount: number
  commandSignalCount: number
  stage1CandidateCount: number
  bm25HitCount: number
  vectorHitCount: number
  suppressedCount: number
  rerankerCalled: boolean
  rerankerAbstained: boolean
  rerankerFallback: boolean
  abstainReason?: string
  injectedCount: number
  injectedIds: string[]
  contextChars: number
  timings: PrePromptTelemetryTimings
}

const TELEMETRY_DIRECTORY = 'pre-prompt-telemetry'
let telemetryStore: JsonLinesStore | null = null

function getStore(): JsonLinesStore {
  if (!telemetryStore) {
    telemetryStore = new JsonLinesStore(TELEMETRY_DIRECTORY)
  }
  return telemetryStore
}

function getDateKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10)
}

export function recordPrePromptTelemetry(
  event: PrePromptTelemetryEvent,
  options?: { collection?: string }
): void {
  try {
    getStore().append(getDateKey(event.timestamp), [event], {
      collection: options?.collection
    })
  } catch (error) {
    console.error('[claude-memory] Failed to record pre-prompt telemetry:', error)
  }
}

export function readPrePromptTelemetry(
  dateKey: string,
  options?: { collection?: string }
): PrePromptTelemetryEvent[] {
  try {
    return getStore().readLines<PrePromptTelemetryEvent>(dateKey, {
      collection: options?.collection
    })
  } catch {
    return []
  }
}

export function resetPrePromptTelemetryStores(): void {
  telemetryStore = null
}
