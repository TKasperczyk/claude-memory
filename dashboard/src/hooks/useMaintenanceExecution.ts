import { useCallback, useEffect, useState } from 'react'
import {
  runMaintenance,
  type MaintenanceOperationInfo,
  type MaintenanceProgress,
  type OperationResult
} from '@/lib/api'
import { useMaintenanceExecutionStream } from '@/hooks/useMaintenanceExecutionStream'

type MaintenanceOperation = MaintenanceOperationInfo['key']

export type BulkProgressState = 'pending' | 'running' | 'completed'

type RunningMode = 'preview' | 'run' | null

type OperationProgressState = Record<MaintenanceOperation, MaintenanceProgress>

type OperationProgressMap = OperationProgressState | null

interface UseMaintenanceExecutionResult {
  results: Record<MaintenanceOperation, OperationResult | null>
  running: Record<MaintenanceOperation, boolean>
  runningMode: Record<MaintenanceOperation, RunningMode>
  bulkRunning: boolean
  bulkMode: RunningMode
  bulkProgress: Record<MaintenanceOperation, BulkProgressState> | null
  detailedProgress: OperationProgressMap
  bulkError: string | null
  handleRunOperation: (operation: MaintenanceOperation, dryRun: boolean) => Promise<void>
  handleRunAll: (dryRun: boolean) => void
}

function buildOperationState<T>(
  operations: MaintenanceOperationInfo[],
  fallback: T,
  existing: Record<string, T> = {}
): Record<MaintenanceOperation, T> {
  return Object.fromEntries(
    operations.map(operation => [operation.key, existing[operation.key] ?? fallback])
  ) as Record<MaintenanceOperation, T>
}

function parseSsePayload(event: Event, eventName: string): Record<string, unknown> | null {
  if (!(event instanceof MessageEvent) || typeof event.data !== 'string') {
    return null
  }

  try {
    const payload = JSON.parse(event.data) as unknown
    if (payload && typeof payload === 'object') {
      return payload as Record<string, unknown>
    }
    console.error(`[maintenance] Ignoring malformed SSE payload for "${eventName}" event`)
    return null
  } catch (error) {
    console.error(`[maintenance] Failed to parse SSE payload for "${eventName}" event`, error)
    return null
  }
}

function isOperationResult(value: unknown): value is OperationResult {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<OperationResult>
  return typeof candidate.operation === 'string'
    && typeof candidate.dryRun === 'boolean'
    && Array.isArray(candidate.actions)
    && typeof candidate.summary === 'object'
    && candidate.summary !== null
    && Array.isArray(candidate.candidates)
    && typeof candidate.duration === 'number'
}

function createErrorResult(
  operation: MaintenanceOperation,
  dryRun: boolean,
  message: string
): OperationResult {
  return {
    operation,
    dryRun,
    actions: [],
    summary: {},
    candidates: [],
    duration: 0,
    error: message
  }
}

function removeDetailedProgress(
  previous: OperationProgressMap,
  operation: MaintenanceOperation
): OperationProgressMap {
  if (!previous) return null
  const { [operation]: _removed, ...rest } = previous
  return Object.keys(rest).length > 0 ? (rest as OperationProgressState) : null
}

function supportsOperationProgress(operation: MaintenanceOperation): boolean {
  return operation === 'consolidation' || operation === 'cross-type-consolidation'
}

export function useMaintenanceExecution(
  operations: MaintenanceOperationInfo[]
): UseMaintenanceExecutionResult {
  const [results, setResults] = useState<Record<MaintenanceOperation, OperationResult | null>>({})
  const [running, setRunning] = useState<Record<MaintenanceOperation, boolean>>({})
  const [runningMode, setRunningMode] = useState<Record<MaintenanceOperation, RunningMode>>({})
  const [bulkRunning, setBulkRunning] = useState(false)
  const [bulkMode, setBulkMode] = useState<RunningMode>(null)
  const [bulkProgress, setBulkProgress] = useState<Record<MaintenanceOperation, BulkProgressState> | null>(null)
  const [detailedProgress, setDetailedProgress] = useState<OperationProgressMap>(null)
  const [bulkError, setBulkError] = useState<string | null>(null)

  const { openStream, closeStream } = useMaintenanceExecutionStream()

  useEffect(() => {
    if (operations.length === 0) return
    setResults(prev => buildOperationState(operations, null, prev))
    setRunning(prev => buildOperationState(operations, false, prev))
    setRunningMode(prev => buildOperationState(operations, null, prev))
  }, [operations])

  const setOperationRunning = useCallback((operation: MaintenanceOperation, isRunning: boolean) => {
    setRunning(prev => ({ ...prev, [operation]: isRunning }))
  }, [])

  const handleRunOperation = useCallback(async (operation: MaintenanceOperation, dryRun: boolean) => {
    setOperationRunning(operation, true)
    setRunningMode(prev => ({ ...prev, [operation]: dryRun ? 'preview' : 'run' }))

    if (supportsOperationProgress(operation)) {
      const eventSource = openStream(`/api/maintenance/stream?dryRun=${dryRun}&operation=${operation}`)

      eventSource.addEventListener('detailed-progress', event => {
        const data = parseSsePayload(event, 'detailed-progress')
        if (!data || typeof data.operation !== 'string') return

        const current = data.current
        const total = data.total
        if (
          typeof current !== 'number' ||
          !Number.isFinite(current) ||
          typeof total !== 'number' ||
          !Number.isFinite(total)
        ) {
          return
        }

        const op = data.operation as MaintenanceOperation
        setDetailedProgress(prev => ({
          ...(prev || {}),
          [op]: {
            current,
            total,
            message: typeof data.message === 'string' ? data.message : undefined
          }
        }))
      })

      eventSource.addEventListener('result', event => {
        const data = parseSsePayload(event, 'result')
        if (!data || !isOperationResult(data)) return
        if (data.operation !== operation) return

        setDetailedProgress(prev => removeDetailedProgress(prev, operation))
        setResults(prev => ({ ...prev, [operation]: data }))
      })

      eventSource.addEventListener('error', event => {
        const data = parseSsePayload(event, 'error')
        if (!data) return

        const message = typeof data.error === 'string'
          ? data.error
          : 'Failed to run maintenance operation'
        setResults(prev => ({
          ...prev,
          [operation]: createErrorResult(operation, dryRun, message)
        }))
      })

      eventSource.addEventListener('complete', () => {
        setOperationRunning(operation, false)
        setRunningMode(prev => ({ ...prev, [operation]: null }))
        closeStream()
      })

      eventSource.onerror = () => {
        setOperationRunning(operation, false)
        setRunningMode(prev => ({ ...prev, [operation]: null }))
        setDetailedProgress(prev => removeDetailedProgress(prev, operation))
        closeStream()
      }

      return
    }

    try {
      const result = await runMaintenance(operation, dryRun)
      setResults(prev => ({ ...prev, [operation]: result }))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to run maintenance operation'
      setResults(prev => ({
        ...prev,
        [operation]: createErrorResult(operation, dryRun, message)
      }))
    } finally {
      setOperationRunning(operation, false)
      setRunningMode(prev => ({ ...prev, [operation]: null }))
    }
  }, [closeStream, openStream, setOperationRunning])

  const handleRunAll = useCallback((dryRun: boolean) => {
    if (operations.length === 0) return

    setBulkRunning(true)
    setBulkMode(dryRun ? 'preview' : 'run')
    setBulkError(null)
    setBulkProgress(
      Object.fromEntries(operations.map(op => [op.key, 'pending'])) as Record<MaintenanceOperation, BulkProgressState>
    )

    const eventSource = openStream(`/api/maintenance/stream?dryRun=${dryRun}`)

    eventSource.addEventListener('progress', event => {
      const data = parseSsePayload(event, 'progress')
      if (!data || typeof data.operation !== 'string') return

      const operation = data.operation as MaintenanceOperation
      setBulkProgress(prev => (prev ? { ...prev, [operation]: 'running' } : null))
    })

    eventSource.addEventListener('detailed-progress', event => {
      const data = parseSsePayload(event, 'detailed-progress')
      if (!data || typeof data.operation !== 'string') return

      const current = data.current
      const total = data.total
      if (
        typeof current !== 'number' ||
        !Number.isFinite(current) ||
        typeof total !== 'number' ||
        !Number.isFinite(total)
      ) {
        return
      }

      const operation = data.operation as MaintenanceOperation
      setDetailedProgress(prev => ({
        ...(prev || {}),
        [operation]: {
          current,
          total,
          message: typeof data.message === 'string' ? data.message : undefined
        }
      }))
    })

    eventSource.addEventListener('result', event => {
      const data = parseSsePayload(event, 'result')
      if (!data || !isOperationResult(data) || !data.operation) return

      const operation = data.operation as MaintenanceOperation
      setBulkProgress(prev => (prev ? { ...prev, [operation]: 'completed' } : null))
      setDetailedProgress(prev => removeDetailedProgress(prev, operation))
      setResults(prev => ({ ...prev, [operation]: data }))
    })

    eventSource.addEventListener('error', event => {
      const data = parseSsePayload(event, 'error')
      if (data) {
        setBulkError(typeof data.error === 'string' ? data.error : 'Unknown error')
      }
    })

    eventSource.addEventListener('complete', () => {
      setBulkRunning(false)
      setBulkProgress(null)
      setDetailedProgress(null)
      setBulkMode(null)
      closeStream()
    })

    eventSource.onerror = () => {
      setBulkRunning(false)
      setBulkProgress(null)
      setDetailedProgress(null)
      setBulkMode(null)
      closeStream()
    }
  }, [closeStream, openStream, operations])

  return {
    results,
    running,
    runningMode,
    bulkRunning,
    bulkMode,
    bulkProgress,
    detailedProgress,
    bulkError,
    handleRunOperation,
    handleRunAll
  }
}
