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
  const [loadingRunId, setLoadingRunId] = useState<string | null>(null)
  const [runErrors, setRunErrors] = useState<Record<string, string>>({})
  const [reviewsByRun, setReviewsByRun] = useState<Record<string, ExtractionReview | null>>({})
  const [reviewLoading, setReviewLoading] = useState<Record<string, boolean>>({})
  const [reviewErrors, setReviewErrors] = useState<Record<string, string>>({})
  const loadSeqRef = useRef(0)

  const loadRunDetails = useCallback(async (run: ExtractionRun) => {
    if (recordsByRun[run.runId]) return

    const loadSeq = loadSeqRef.current + 1
    loadSeqRef.current = loadSeq
    setLoadingRunId(run.runId)
    setRunErrors(prev => ({ ...prev, [run.runId]: '' }))

    try {
      const response = await fetchExtractionRun(run.runId)
      if (loadSeqRef.current !== loadSeq) return
      setRecordsByRun(prev => ({ ...prev, [run.runId]: response.records }))
    } catch (err) {
      if (loadSeqRef.current !== loadSeq) return
      const message = err instanceof Error ? err.message : 'Failed to load extraction'
      setRunErrors(prev => ({ ...prev, [run.runId]: message }))
    } finally {
      if (loadSeqRef.current === loadSeq) {
        setLoadingRunId(null)
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
    loadingRunId,
    runErrors,
    reviewsByRun,
    reviewLoading,
    reviewErrors,
    loadRunDetails,
    loadReview,
    handleReviewUpdate,
    handleReviewError
  }
}
