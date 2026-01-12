import { useCallback, useState } from 'react'

export function useCopyToClipboard(resetDelay = 1500) {
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const copy = useCallback(async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedId(id)
      setTimeout(() => setCopiedId(null), resetDelay)
    } catch (error) {
      console.error('Failed to copy:', error)
    }
  }, [resetDelay])

  const isCopied = useCallback((id: string) => copiedId === id, [copiedId])

  return { copy, isCopied }
}
