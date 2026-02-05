import { useCallback, useEffect, useRef, useState } from 'react'
import { readSseStream } from '../lib/sse'

export interface UseStreamingReviewOptions<TResult> {
  endpoint: string
  method?: 'POST'
  body?: unknown
  onComplete?: (result: TResult) => void
  onError?: (error: Error) => void
}

export interface UseStreamingReviewReturn<TResult> {
  trigger: () => void
  thinking: string
  isStreaming: boolean
  result: TResult | null
  error: Error | null
  reset: () => void
}

type StreamPayload<TResult> = {
  thinking?: string
  result?: TResult
  error?: string
}

const STREAM_PARAM = 'stream=true'

function withStreamParam(endpoint: string): string {
  if (endpoint.includes('?')) {
    return endpoint.includes('stream=') ? endpoint : `${endpoint}&${STREAM_PARAM}`
  }
  return `${endpoint}?${STREAM_PARAM}`
}

export function useStreamingReview<TResult>(
  options: UseStreamingReviewOptions<TResult>
): UseStreamingReviewReturn<TResult> {
  const { endpoint, method = 'POST', body, onComplete, onError } = options
  const [thinking, setThinking] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [result, setResult] = useState<TResult | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const requestIdRef = useRef(0)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      abortRef.current?.abort()
    }
  }, [])

  const reset = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setThinking('')
    setResult(null)
    setError(null)
    setIsStreaming(false)
  }, [])

  const trigger = useCallback(() => {
    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    let hasResult = false
    let hasError = false

    const isActive = () =>
      mountedRef.current &&
      requestIdRef.current === requestId &&
      !controller.signal.aborted

    const handleError = (err: Error) => {
      if (!isActive()) return
      hasError = true
      setError(err)
      onError?.(err)
    }

    const handleResult = (payload: TResult) => {
      if (!isActive()) return
      hasResult = true
      setResult(payload)
      onComplete?.(payload)
    }

    setThinking('')
    setResult(null)
    setError(null)
    setIsStreaming(true)

    const runFallback = async () => {
      const response = await fetch(endpoint, {
        method,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        signal: controller.signal
      })

      if (!response.ok) {
        const message = await response.text()
        throw new Error(message || `Request failed (${response.status})`)
      }

      const fallbackResult = await response.json() as TResult
      handleResult(fallbackResult)
    }

    const run = async () => {
      let receivedStreamEvent = false
      try {
        const response = await fetch(withStreamParam(endpoint), {
          method,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
          signal: controller.signal
        })

        if (!response.ok) {
          const message = await response.text()
          throw new Error(message || `Request failed (${response.status})`)
        }

        const contentType = response.headers.get('Content-Type') ?? ''
        if (!contentType.includes('text/event-stream')) {
          const fallbackResult = await response.json() as TResult
          handleResult(fallbackResult)
          return
        }

        if (!response.body) {
          throw new Error('Streaming response body missing')
        }

        await readSseStream(
          response.body,
          message => {
            const payload = message.data
            if (!payload) return
            receivedStreamEvent = true

            if (payload === '[DONE]') {
              return false
            }

            let parsed: StreamPayload<TResult>
            try {
              parsed = JSON.parse(payload) as StreamPayload<TResult>
            } catch (err) {
              handleError(err instanceof Error ? err : new Error('Failed to parse stream payload'))
              return false
            }

            if (parsed.thinking) {
              const chunk = parsed.thinking
              setThinking(prev => {
                if (!isActive()) return prev
                return prev + chunk
              })
            }

            if (parsed.result) {
              handleResult(parsed.result)
            }

            if (parsed.error) {
              handleError(new Error(parsed.error))
            }
          },
          { signal: controller.signal }
        )

        if (!isActive()) return

        if (!receivedStreamEvent && !hasResult && !hasError && !controller.signal.aborted) {
          try {
            await runFallback()
            return
          } catch (fallbackErr) {
            handleError(fallbackErr instanceof Error ? fallbackErr : new Error('Streaming failed'))
            return
          }
        }

        if (receivedStreamEvent && !hasResult && !hasError && !controller.signal.aborted) {
          handleError(new Error('Streaming ended without a review result.'))
        }
      } catch (err) {
        if (controller.signal.aborted || !isActive()) return
        if (!receivedStreamEvent) {
          try {
            await runFallback()
            return
          } catch (fallbackErr) {
            handleError(fallbackErr instanceof Error ? fallbackErr : new Error('Streaming failed'))
            return
          }
        }
        handleError(err instanceof Error ? err : new Error('Streaming failed'))
      } finally {
        if (isActive()) {
          setIsStreaming(false)
        }
      }
    }

    void run()
  }, [endpoint, method, body, onComplete, onError])

  return {
    trigger,
    thinking,
    isStreaming,
    result,
    error,
    reset
  }
}
