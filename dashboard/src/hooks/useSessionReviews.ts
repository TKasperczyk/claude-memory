import { useCallback, useState } from 'react'
import { fetchInjectionReview, type InjectionReview, type SessionRecord } from '@/lib/api'

export function useSessionReviews() {
  const [reviewsBySession, setReviewsBySession] = useState<Record<string, InjectionReview | null>>({})
  const [reviewLoading, setReviewLoading] = useState<Record<string, boolean>>({})
  const [reviewErrors, setReviewErrors] = useState<Record<string, string>>({})

  const loadReview = useCallback(async (session: SessionRecord) => {
    if (reviewLoading[session.sessionId]) return
    if (Object.prototype.hasOwnProperty.call(reviewsBySession, session.sessionId)) return

    setReviewLoading(prev => ({ ...prev, [session.sessionId]: true }))
    setReviewErrors(prev => ({ ...prev, [session.sessionId]: '' }))

    try {
      const review = await fetchInjectionReview(session.sessionId)
      setReviewsBySession(prev => ({ ...prev, [session.sessionId]: review }))
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load review'
      if (message.toLowerCase().includes('review not found')) {
        setReviewsBySession(prev => ({ ...prev, [session.sessionId]: null }))
      } else {
        setReviewErrors(prev => ({ ...prev, [session.sessionId]: message }))
      }
    } finally {
      setReviewLoading(prev => ({ ...prev, [session.sessionId]: false }))
    }
  }, [reviewLoading, reviewsBySession])

  const handleReviewUpdate = useCallback((sessionId: string, review: InjectionReview) => {
    setReviewsBySession(prev => ({ ...prev, [sessionId]: review }))
  }, [])

  const handleReviewError = useCallback((sessionId: string, message: string) => {
    setReviewErrors(prev => ({ ...prev, [sessionId]: message }))
  }, [])

  return {
    reviewsBySession,
    reviewLoading,
    reviewErrors,
    loadReview,
    handleReviewUpdate,
    handleReviewError
  }
}
