import type { Config } from '../src/lib/types.js'

const DEFAULT_TIMEOUT_MS = 800

export type EmbeddingAvailability = {
  available: boolean
  reason?: string
}

export async function checkEmbeddingAvailability(
  config: Config,
  options: { timeoutMs?: number } = {}
): Promise<EmbeddingAvailability> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const baseUrl = config.embeddings.baseUrl.replace(/\/$/, '')

  try {
    const response = await fetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: 'ping',
        model: config.embeddings.model
      }),
      signal: controller.signal
    })

    if (!response.ok) {
      return { available: false, reason: `HTTP ${response.status} ${response.statusText}` }
    }

    const data = await response.json().catch(() => null) as {
      data?: Array<{ embedding?: number[] }>
    } | null
    if (!data?.data || !Array.isArray(data.data) || !Array.isArray(data.data[0]?.embedding)) {
      return { available: false, reason: 'Invalid embedding response' }
    }

    return { available: true }
  } catch (error) {
    if (controller.signal.aborted) {
      return { available: false, reason: `timed out after ${timeoutMs}ms` }
    }
    const reason = error instanceof Error ? error.message : String(error)
    return { available: false, reason }
  } finally {
    clearTimeout(timer)
  }
}
