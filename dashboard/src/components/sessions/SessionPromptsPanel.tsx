import { useEffect, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import ListItem from '@/components/ListItem'
import type { RetrievalContext } from '@/components/MemoryDetail'
import { TYPE_COLORS } from '@/lib/memory-ui'
import type { SessionRecord } from '@/lib/api'
import {
  STATUS_STYLES,
  formatMemoryCount,
  formatRetrievalTrigger,
  formatUsageRatio,
  getPromptMemories,
  getUsageColor,
  parseSnippetTitle,
  type PromptDisplayEntry
} from './utils'

export default function SessionPromptsPanel({
  session,
  promptEntries,
  promptCount,
  onSelectMemory,
  onSendToSimulator
}: {
  session: SessionRecord
  promptEntries: PromptDisplayEntry[] | null
  promptCount: number | null
  onSelectMemory: (recordId: string, context?: RetrievalContext | null) => void
  onSendToSimulator: (prompt: string, cwd?: string) => void
}) {
  const [expandedPromptIndex, setExpandedPromptIndex] = useState<number | null>(null)
  const promptsListRef = useRef<HTMLDivElement>(null)
  const promptsScrollPosRef = useRef<number>(0)

  const prompts = promptEntries ?? []
  const promptsAvailable = promptEntries !== null
  const expandedPrompt = expandedPromptIndex !== null ? prompts[expandedPromptIndex] ?? null : null

  useEffect(() => {
    setExpandedPromptIndex(null)
  }, [session.sessionId])

  // Restore prompts list scroll position when going back from detail view
  useEffect(() => {
    if (expandedPromptIndex === null && promptsListRef.current) {
      promptsListRef.current.scrollTop = promptsScrollPosRef.current
    }
  }, [expandedPromptIndex])

  return (
    <div className="rounded-lg border border-border bg-background/40 p-3 min-h-[296px]">
      {expandedPrompt ? (
        // Prompt detail view
        (() => {
          const promptMemories = getPromptMemories(session, expandedPrompt)
          return (
            <>
              <div className="flex items-center justify-between mb-2">
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => setExpandedPromptIndex(null)}
                  className="text-[11px] uppercase tracking-wide text-muted-foreground hover:text-foreground"
                >
                  <ChevronRight className="w-3 h-3 rotate-180" />
                  Back to prompts
                </Button>
                <div className="flex items-center gap-2">
                  {expandedPrompt.status && (
                    <span className={`px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wide ${STATUS_STYLES[expandedPrompt.status].badge}`}>
                      {STATUS_STYLES[expandedPrompt.status].label}
                    </span>
                  )}
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => onSendToSimulator(expandedPrompt.text, session.cwd)}
                  >
                    Simulator
                  </Button>
                </div>
              </div>
              <div className="max-h-64 overflow-y-auto space-y-3 pr-1">
                <div className="rounded bg-secondary/30 p-3">
                  <pre className="text-xs text-foreground whitespace-pre-wrap font-mono leading-relaxed max-h-32 overflow-y-auto">
                    {expandedPrompt.text.trim() || '(empty prompt)'}
                  </pre>
                </div>
                {promptMemories.length > 0 && (
                  <div className="space-y-2">
                    <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      Injected memories ({promptMemories.length})
                    </div>
                    <div className="space-y-1">
                      {promptMemories.map((memory, idx) => {
                        const title = parseSnippetTitle(memory.snippet)
                        const trigger = formatRetrievalTrigger(memory)
                        return (
                          <ListItem
                            key={`${memory.id}-prompt-${idx}`}
                            onClick={() => onSelectMemory(memory.id, {
                              prompt: memory.prompt,
                              similarity: memory.similarity,
                              keywordMatch: memory.keywordMatch,
                              score: memory.score
                            })}
                            compact
                            className="flex items-center gap-2 group"
                          >
                            <span
                              className="w-2 h-2 rounded-full shrink-0"
                              style={{ backgroundColor: memory.type ? TYPE_COLORS[memory.type] : '#888' }}
                            />
                            <span className="flex-1 truncate text-xs text-foreground/80 group-hover:text-foreground">{title}</span>
                            {trigger && (
                              <span className={`text-[9px] font-mono px-1 rounded bg-background/50 shrink-0 ${trigger.color}`} title={trigger.title}>
                                {trigger.label}
                              </span>
                            )}
                            <span className={`text-[10px] font-mono shrink-0 ${getUsageColor(memory.stats)}`}>
                              {formatUsageRatio(memory.stats)}
                            </span>
                          </ListItem>
                        )
                      })}
                    </div>
                  </div>
                )}
                {promptMemories.length === 0 && (
                  <div className="text-xs text-muted-foreground">No memories injected for this prompt.</div>
                )}
              </div>
            </>
          )
        })()
      ) : (
        // Prompts list view
        <>
          <div className="flex items-center justify-between mb-2">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Prompts</div>
            <div className="text-[11px] text-muted-foreground">
              {promptsAvailable ? prompts.length : (promptCount ?? '—')}
            </div>
          </div>
          {!promptsAvailable ? (
            <div className="text-xs text-muted-foreground">
              Prompt data unavailable for legacy sessions.
            </div>
          ) : prompts.length === 0 ? (
            <div className="text-xs text-muted-foreground">
              No prompts recorded.
            </div>
          ) : (
            <div
              ref={promptsListRef}
              className="max-h-64 overflow-y-auto space-y-1.5 pr-1"
            >
              {prompts.map((prompt, index) => {
                const status = prompt.status
                const statusStyle = status ? STATUS_STYLES[status] : null
                const memoryCountLabel = formatMemoryCount(prompt.memoryCount)
                const promptText = prompt.text.trim().length > 0 ? prompt.text : '(empty)'

                return (
                  <ListItem
                    key={`${session.sessionId}-prompt-${index}`}
                    onClick={() => {
                      // Save scroll position before expanding
                      if (promptsListRef.current) {
                        promptsScrollPosRef.current = promptsListRef.current.scrollTop
                      }
                      setExpandedPromptIndex(index)
                    }}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5 mb-1">
                          {statusStyle && (
                            <span className={`px-1 py-0.5 rounded text-[9px] uppercase tracking-wide ${statusStyle.badge}`}>
                              {statusStyle.label}
                            </span>
                          )}
                          {memoryCountLabel && (
                            <span className="text-[10px] text-muted-foreground">{memoryCountLabel}</span>
                          )}
                        </div>
                        <div className="text-xs text-foreground line-clamp-2">{promptText}</div>
                      </div>
                      <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                    </div>
                  </ListItem>
                )
              })}
            </div>
          )}
        </>
      )}
    </div>
  )
}
