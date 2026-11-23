/**
 * Embedding generation via OpenAI-compatible API (LM Studio, vLLM, etc.).
 */

import https from 'https'
import { DEFAULT_CONFIG, EMBEDDING_DIM, type Config } from './types.js'
import { withTimeout } from './shared.js'
import { createLogger } from './logger.js'
const logger = createLogger('embed')
const DEFAULT_TIMEOUT_MS = 30000

const config: Config = DEFAULT_CONFIG
let insecureHttpsAgent: https.Agent | null = null

function getInsecureHttpsAgent(): https.Agent {
  if (!insecureHttpsAgent) {
    insecureHttpsAgent = new https.Agent({ rejectUnauthorized: false })
  }
  return insecureHttpsAgent
}

async function postJsonInsecureHttps(
  url: string,
  headers: Record<string, string>,
  body: string,
  signal?: AbortSignal
): Promise<{ ok: boolean; status: number; statusText: string; json: () => Promise<unknown> }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Embedding request aborted'))
      return
    }
    let settled = false
    const resolveOnce = (value: { ok: boolean; status: number; statusText: string; json: () => Promise<unknown> }) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }
    const rejectOnce = (error: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }

    const parsedUrl = new URL(url)
    const req = https.request({
      protocol: parsedUrl.protocol,
      hostname: parsedUrl.hostname,
      port: parsedUrl.port ? Number(parsedUrl.port) : undefined,
      path: `${parsedUrl.pathname}${parsedUrl.search}`,
      method: 'POST',
      headers: {
        ...headers,
        'Content-Length': Buffer.byteLength(body)
      },
      agent: getInsecureHttpsAgent()
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer | string) => {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
      })
      res.on('end', () => {
        const status = res.statusCode ?? 0
        const statusText = res.statusMessage ?? ''
        const text = Buffer.concat(chunks).toString('utf-8')
        resolveOnce({
          ok: status >= 200 && status < 300,
          status,
          statusText,
          json: async () => JSON.parse(text) as unknown
        })
      })
      res.on('error', (error) => {
        rejectOnce(error)
      })
      res.on('close', () => {
        if (!res.complete) {
          rejectOnce(new Error('Embedding response connection closed prematurely'))
        }
      })
    })

    const onAbort = () => {
      req.destroy(new Error('Embedding request aborted'))
    }
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort)
    }

    signal?.addEventListener('abort', onAbort, { once: true })
    req.on('error', (error) => {
      rejectOnce(error)
    })
    req.write(body)
    req.end()
  })
}

export async function embed(
  text: string,
  cfg: Config = config,
  options?: { signal?: AbortSignal; timeoutMs?: number }
): Promise<number[]> {
  const [embedding] = await requestEmbeddings(text, cfg, options?.signal, options?.timeoutMs)
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
  signal?: AbortSignal,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<number[][]> {
  logger.debug(`Embedding request → ${cfg.embeddings.baseUrl} model=${cfg.embeddings.model}`)

  const result = await withTimeout(async (timeoutSignal) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (cfg.embeddings.apiKey) {
      headers['Authorization'] = `Bearer ${cfg.embeddings.apiKey}`
    }
    const endpoint = cfg.embeddings.baseUrl + '/embeddings'
    const payload = JSON.stringify({
      input,
      model: cfg.embeddings.model,
      ...(cfg.embeddings.provider ? { provider: cfg.embeddings.provider } : {})
    })
    const response = cfg.embeddings.insecure && /^https:\/\//i.test(endpoint)
      ? await postJsonInsecureHttps(endpoint, headers, payload, timeoutSignal)
      : await fetch(endpoint, {
          method: 'POST',
          headers,
          body: payload,
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
  }, { timeoutMs, signal })

  if (!result.completed) {
    if (result.timedOut) {
      throw new Error(`Embedding request timed out after ${timeoutMs}ms`)
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
