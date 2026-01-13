import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'

export interface ThinkingPanelProps {
  thinking: string
  isStreaming: boolean
  className?: string
}

export default function ThinkingPanel({ thinking, isStreaming, className }: ThinkingPanelProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const hasThinking = thinking.trim().length > 0
  const visibilityClass = isStreaming
    ? 'max-h-64 opacity-100'
    : hasThinking
      ? 'max-h-48 opacity-70'
      : 'max-h-0 opacity-0'

  useEffect(() => {
    const node = scrollRef.current
    if (!node) return
    node.scrollTop = node.scrollHeight
  }, [thinking, isStreaming])

  return (
    <div
      className={cn(
        'transition-all duration-300 ease-out overflow-hidden',
        visibilityClass,
        className
      )}
    >
      <div className="rounded-md border border-border bg-secondary/30 px-3 py-2 space-y-2">
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground">
          <span>Thinking...</span>
          {isStreaming && (
            <span className="flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/70 animate-pulse" />
              <span
                className="h-1.5 w-1.5 rounded-full bg-muted-foreground/70 animate-pulse"
                style={{ animationDelay: '150ms' }}
              />
              <span
                className="h-1.5 w-1.5 rounded-full bg-muted-foreground/70 animate-pulse"
                style={{ animationDelay: '300ms' }}
              />
            </span>
          )}
        </div>
        <div
          ref={scrollRef}
          className="max-h-48 overflow-y-auto rounded-md bg-background/60 px-3 py-2 text-xs font-mono text-muted-foreground whitespace-pre-wrap leading-relaxed"
        >
          {thinking || (isStreaming ? '...' : '')}
        </div>
      </div>
    </div>
  )
}
