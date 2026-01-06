import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { fetchMemory, type MemoryRecord } from '@/lib/api'

type SelectedMemoryState = {
  selectedId: string | null
  selected: MemoryRecord | null
  detailLoading: boolean
  detailError: string | null
  handleSelect: (recordOrId: MemoryRecord | string) => void
  handleClose: () => void
}

export function useSelectedMemory(): SelectedMemoryState {
  const [selected, setSelected] = useState<MemoryRecord | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [searchParams, setSearchParams] = useSearchParams()
  const selectedId = searchParams.get('id')

  useEffect(() => {
    let active = true

    const loadSelected = async () => {
      if (!selectedId) {
        if (active) {
          setSelected(null)
          setDetailError(null)
          setDetailLoading(false)
        }
        return
      }

      setDetailLoading(true)
      setDetailError(null)
      setSelected(null)

      try {
        const record = await fetchMemory(selectedId)
        if (active) setSelected(record)
      } catch {
        if (active) {
          setSelected(null)
          setDetailError('Failed to load memory')
        }
      } finally {
        if (active) setDetailLoading(false)
      }
    }

    loadSelected()
    return () => { active = false }
  }, [selectedId])

  const handleSelect = (recordOrId: MemoryRecord | string) => {
    setSelected(null)
    setDetailError(null)
    const id = typeof recordOrId === 'string' ? recordOrId : recordOrId.id
    const next = new URLSearchParams(searchParams)
    next.set('id', id)
    setSearchParams(next)
  }

  const handleClose = () => {
    setSelected(null)
    setDetailError(null)
    setDetailLoading(false)
    if (selectedId) {
      const next = new URLSearchParams(searchParams)
      next.delete('id')
      setSearchParams(next)
    }
  }

  return {
    selectedId,
    selected,
    detailLoading,
    detailError,
    handleSelect,
    handleClose
  }
}
