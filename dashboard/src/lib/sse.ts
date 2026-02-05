export type SseMessage = {
  event: string | null
  data: string
}

export async function readSseStream(
  stream: ReadableStream<Uint8Array>,
  onMessage: (message: SseMessage) => boolean | void,
  options: { signal?: AbortSignal } = {}
): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let eventName: string | null = null
  let dataLines: string[] = []

  const flushEvent = (): boolean | void => {
    const payload = dataLines.join('\n')
    dataLines = []
    const name = eventName
    eventName = null
    if (!payload) return
    return onMessage({ event: name, data: payload })
  }

  while (true) {
    if (options.signal?.aborted) {
      await reader.cancel()
      return
    }
    const { value, done } = await reader.read()
    if (done) {
      buffer += decoder.decode()
      break
    }

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (line.startsWith('event:')) {
        const name = line.slice(6).trim()
        eventName = name.length > 0 ? name : null
        continue
      }
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart())
        continue
      }
      if (line === '') {
        if (flushEvent() === false) {
          await reader.cancel()
          return
        }
      }
    }
  }

  if (buffer) {
    const lines = buffer.split(/\r?\n/)
    buffer = ''
    for (const line of lines) {
      if (line.startsWith('event:')) {
        const name = line.slice(6).trim()
        eventName = name.length > 0 ? name : null
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart())
      } else if (line === '') {
        if (flushEvent() === false) {
          return
        }
      }
    }
  }

  if (dataLines.length > 0) {
    flushEvent()
  }
}
