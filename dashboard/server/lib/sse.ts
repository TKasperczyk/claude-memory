import type { Response } from 'express'

type SseSend = (event: string | null, data: unknown) => void

type SseStreamOptions = {
  onClose?: () => void
}

export type SseStream = {
  abortController: AbortController
  signal: AbortSignal
  send: SseSend
  sendData: (data: unknown) => void
  onThinking: (chunk: string) => void
  done: () => void
  end: () => void
}

function createAbortHandler(res: Response, onClose?: () => void): AbortController {
  const abortController = new AbortController()
  res.on('close', () => {
    abortController.abort()
    onClose?.()
  })
  return abortController
}

function canWrite(res: Response, signal: AbortSignal): boolean {
  return !signal.aborted && !res.writableEnded
}

export function createSseStream(res: Response, options: SseStreamOptions = {}): SseStream {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const abortController = createAbortHandler(res, options.onClose)

  const send: SseSend = (event, data) => {
    if (!canWrite(res, abortController.signal)) return
    if (event) {
      res.write(`event: ${event}\n`)
    }
    res.write(`data: ${JSON.stringify(data)}\n\n`)
  }

  const sendData = (data: unknown) => {
    send(null, data)
  }

  const onThinking = (chunk: string) => {
    if (!chunk || !canWrite(res, abortController.signal)) return
    sendData({ thinking: chunk })
  }

  const done = () => {
    if (!canWrite(res, abortController.signal)) return
    res.write('data: [DONE]\n\n')
  }

  const end = () => {
    res.end()
  }

  return {
    abortController,
    signal: abortController.signal,
    send,
    sendData,
    onThinking,
    done,
    end
  }
}

export function sendSseError(
  stream: Pick<SseStream, 'sendData' | 'done'>,
  error: unknown,
  fallbackMessage: string
): string {
  const message = error instanceof Error ? error.message : String(error)
  const payload = message || fallbackMessage
  stream.sendData({ error: payload })
  stream.done()
  return payload
}
