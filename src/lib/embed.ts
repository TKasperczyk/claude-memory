/**
 * Embedding generation via LMStudio (OpenAI-compatible API).
 */

import { DEFAULT_CONFIG, EMBEDDING_DIM, type Config } from './types.js'
import { withTimeout } from './shared.js'
const DEFAULT_TIMEOUT_MS = 30000

const config: Config = DEFAULT_CONFIG

export async function embed(
  text: string,
  cfg: Config = config,
  options?: { signal?: AbortSignal }
): Promise<number[]> {
  const [embedding] = await requestEmbeddings(text, cfg, options?.signal)
  return embedding
}

export async function embedBatch(
  texts: string[],
  cfg: Config = config,
  options?: { signal?: AbortSignal }
): Promise<number[][]> {
  if (texts.length === 0) return []
  return requestEmbeddings(texts, cfg, options?.signal)
}

async function requestEmbeddings(
  input: string | string[],
  cfg: Config,
  signal?: AbortSignal
): Promise<number[][]> {
  const result = await withTimeout(async (timeoutSignal) => {
    const response = await fetch(cfg.embeddings.baseUrl + '/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input,
        model: cfg.embeddings.model
      }),
      signal: timeoutSignal
    })

    if (!response.ok) {
      throw new Error(`Embedding request failed: ${response.status} ${response.statusText}`)
    }

    const data = await response.json() as { data?: Array<{ embedding?: number[] }> }
    if (!data.data || !Array.isArray(data.data)) {
      throw new Error('Embedding response missing data')
    }

    const embeddings = data.data.map((item, index) => {
      if (!item.embedding || !Array.isArray(item.embedding)) {
        throw new Error(`Embedding response missing vector at index ${index}`)
      }
      ensureEmbeddingDim(item.embedding)
      return item.embedding
    })

    if (typeof input === 'string' && embeddings.length !== 1) {
      throw new Error(`Expected single embedding, received ${embeddings.length}`)
    }

    return embeddings
  }, { timeoutMs: DEFAULT_TIMEOUT_MS, signal })

  if (!result.completed) {
    if (result.timedOut) {
      throw new Error(`Embedding request timed out after ${DEFAULT_TIMEOUT_MS}ms`)
    }
    throw new Error('Embedding request aborted')
  }

  return result.value
}

export function ensureEmbeddingDim(embedding: number[]): void {
  if (embedding.length !== EMBEDDING_DIM) {
    throw new Error(`Embedding dimension mismatch: expected ${EMBEDDING_DIM}, got ${embedding.length}`)
  }
}
