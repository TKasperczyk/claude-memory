import { useCallback, useEffect, useState, type DependencyList } from 'react'

type ApiState<T> = {
  data: T | null
  error: Error | null
  loading: boolean
  reload: () => void
}

export function useApi<T>(fetcher: () => Promise<T>, deps: DependencyList = []): ApiState<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [loading, setLoading] = useState(true)
  const [reloadKey, setReloadKey] = useState(0)

  const reload = useCallback(() => {
    setReloadKey(key => key + 1)
  }, [])

  useEffect(() => {
    let active = true

    const run = async () => {
      setLoading(true)
      setError(null)
      try {
        const result = await fetcher()
        if (!active) return
        setData(result)
      } catch (err) {
        if (!active) return
        setError(err as Error)
      } finally {
        if (!active) return
        setLoading(false)
      }
    }

    run()

    return () => {
      active = false
    }
  // fetcher should be memoized or stable to avoid refetch loops.
  }, [fetcher, reloadKey, ...deps])

  return { data, error, loading, reload }
}
