import { useCallback, useEffect, useRef } from 'react'

export interface MaintenanceExecutionStreamHandle {
  openStream: (url: string) => EventSource
  closeStream: () => void
}

export function useMaintenanceExecutionStream(): MaintenanceExecutionStreamHandle {
  const eventSourceRef = useRef<EventSource | null>(null)

  const closeStream = useCallback(() => {
    eventSourceRef.current?.close()
    eventSourceRef.current = null
  }, [])

  const openStream = useCallback((url: string) => {
    closeStream()
    const eventSource = new EventSource(url)
    eventSourceRef.current = eventSource
    return eventSource
  }, [closeStream])

  useEffect(() => {
    return () => {
      closeStream()
    }
  }, [closeStream])

  return { openStream, closeStream }
}
