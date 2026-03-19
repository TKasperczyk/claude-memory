import { useCallback, useRef, useState } from 'react'
import {
  fetchExtractionReview,
  fetchExtractionRun,
  type ExtractionReview,
  type ExtractionRun,
  type MemoryRecord
} from '@/lib/api'

export function useExtractionRunData() {
  const [recordsByRun, setRecordsByRun] = useState<Record<string, MemoryRecord[]>>({})
  const [loadingRunIds, setLoadingRunIds] = useState<Record<string, boolean>>({})
  const [runErrors, setRunErrors] = useState<Record<string, string>>({})
  const [reviewsByRun, setReviewsByRun] = useState<Record<string, ExtractionReview | null>>({})
  const [reviewLoading, setReviewLoading] = useState<Record<string, boolean>>({})
  const [reviewErrors, setReviewErrors] = useState<Record<string, string>>({})
  const loadSeqRef = useRef<Record<string, number>>({})

  const invalidateRun = useCallback((runId: string) => {
    setRecordsByRun(prev => {
      const next = { ...prev }
      delete next[runId]
      return next
    })
    setReviewsByRun(prev => {
      const next = { ...prev }
      delete next[runId]
      return next
    })
  }, [])

  const loadRunDetails = useCallback(async (run: ExtractionRun) => {
    const runId = run.runId
    if (recordsByRun[runId]) return

    const loadSeq = (loadSeqRef.current[runId] ?? 0) + 1
    loadSeqRef.current[runId] = loadSeq
    setLoadingRunIds(prev => ({ ...prev, [runId]: true }))
    setRunErrors(prev => ({ ...prev, [runId]: '' }))

    try {
      const response = await fetchExtractionRun(runId)
      if (loadSeqRef.current[runId] !== loadSeq) return
      setRecordsByRun(prev => ({ ...prev, [runId]: response.records }))
    } catch (err) {
      if (loadSeqRef.current[runId] !== loadSeq) return
      const message = err instanceof Error ? err.message : 'Failed to load extraction'
      setRunErrors(prev => ({ ...prev, [runId]: message }))
    } finally {
      if (loadSeqRef.current[runId] === loadSeq) {
        setLoadingRunIds(prev => ({ ...prev, [runId]: false }))
      }
    }
  }, [recordsByRun])

  const loadReview = useCallback(async (run: ExtractionRun) => {
    if (reviewLoading[run.runId]) return
    if (Object.prototype.hasOwnProperty.call(reviewsByRun, run.runId)) return

    setReviewLoading(prev => ({ ...prev, [run.runId]: true }))
    setReviewErrors(prev => ({ ...prev, [run.runId]: '' }))
    try {
      const review = await fetchExtractionReview(run.runId)
      setReviewsByRun(prev => ({ ...prev, [run.runId]: review }))
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load review'
      setReviewErrors(prev => ({ ...prev, [run.runId]: message }))
    } finally {
      setReviewLoading(prev => ({ ...prev, [run.runId]: false }))
    }
  }, [reviewLoading, reviewsByRun])

  const handleReviewUpdate = useCallback((runId: string, review: ExtractionReview) => {
    setReviewsByRun(prev => ({ ...prev, [runId]: review }))
  }, [])

  const handleReviewError = useCallback((runId: string, message: string) => {
    setReviewErrors(prev => ({ ...prev, [runId]: message }))
  }, [])

  return {
    recordsByRun,
    loadingRunIds,
    runErrors,
    reviewsByRun,
    reviewLoading,
    reviewErrors,
    loadRunDetails,
    invalidateRun,
    loadReview,
    handleReviewUpdate,
    handleReviewError
  }
}
