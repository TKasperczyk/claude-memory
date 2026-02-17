import { useCallback, useState } from 'react'

export function useCopyToClipboard(resetDelay = 1500) {
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const copy = useCallback(async (id: string, text: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
      } else {
        const textarea = document.createElement('textarea')
        textarea.value = text
        textarea.style.position = 'fixed'
        textarea.style.opacity = '0'
        document.body.appendChild(textarea)
        textarea.select()
        document.execCommand('copy')
        document.body.removeChild(textarea)
      }
      setCopiedId(id)
      setTimeout(() => setCopiedId(null), resetDelay)
    } catch (error) {
      console.error('Failed to copy:', error)
    }
  }, [resetDelay])

  const isCopied = useCallback((id: string) => copiedId === id, [copiedId])

  return { copy, isCopied }
}
