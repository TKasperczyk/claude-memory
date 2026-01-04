/**
 * Embedding generation via LMStudio (OpenAI-compatible API).
 */

import { DEFAULT_CONFIG, EMBEDDING_DIM, type Config } from './types.js'
const DEFAULT_TIMEOUT_MS = 30000

let config: Config = DEFAULT_CONFIG

export function initEmbeddings(cfg: Config = DEFAULT_CONFIG): void {
  config = cfg
}

export async function embed(text: string, cfg: Config = config): Promise<number[]> {
  const [embedding] = await requestEmbeddings(text, cfg)
  return embedding
}

export async function embedBatch(texts: string[], cfg: Config = config): Promise<number[][]> {
  if (texts.length === 0) return []
  return requestEmbeddings(texts, cfg)
}

async function requestEmbeddings(
  input: string | string[],
  cfg: Config
): Promise<number[][]> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)

  try {
    const response = await fetch(cfg.embeddings.baseUrl + '/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input,
        model: cfg.embeddings.model
      }),
      signal: controller.signal
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
  } catch (error: unknown) {
    if (isAbortError(error)) {
      throw new Error(`Embedding request timed out after ${DEFAULT_TIMEOUT_MS}ms`)
    }
    throw error
  } finally {
    clearTimeout(timeoutId)
  }
}

function ensureEmbeddingDim(embedding: number[]): void {
  if (embedding.length !== EMBEDDING_DIM) {
    throw new Error(`Embedding dimension mismatch: expected ${EMBEDDING_DIM}, got ${embedding.length}`)
  }
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  return 'name' in error && (error as { name?: unknown }).name === 'AbortError'
}
