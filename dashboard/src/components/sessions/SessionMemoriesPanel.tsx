import { TYPE_COLORS } from '@/lib/memory-ui'
import type { SessionRecord } from '@/lib/api'
import { groupByType, formatRetrievalTrigger, formatUsageRatio, getUsageColor, parseSnippetTitle } from './utils'
import type { RetrievalContext } from '@/components/MemoryDetail'

export default function SessionMemoriesPanel({
  memories,
  onSelectMemory
}: {
  memories: SessionRecord['memories']
  onSelectMemory: (recordId: string, context?: RetrievalContext | null) => void
}) {
  const typeGroups = groupByType(memories)

  return (
    <div className="rounded-lg border border-border bg-background/40 p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Memories</div>
        <div className="text-[11px] text-muted-foreground">{memories.length}</div>
      </div>
      {memories.length === 0 ? (
        <div className="text-xs text-muted-foreground">None</div>
      ) : (
        <div className="max-h-64 overflow-y-auto space-y-1.5 pr-1">
          {typeGroups.map(group => (
            <div key={group.type} className="rounded bg-secondary/40 overflow-hidden">
              <div
                className="px-2 py-1 flex items-center justify-between border-b"
                style={{
                  backgroundColor: `${TYPE_COLORS[group.type]}10`,
                  borderColor: `${TYPE_COLORS[group.type]}20`,
                }}
              >
                <div className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: TYPE_COLORS[group.type] }} />
                  <span className="text-[11px] font-medium capitalize" style={{ color: TYPE_COLORS[group.type] }}>
                    {group.type}s
                  </span>
                </div>
                <span className="text-[10px] text-muted-foreground tabular-nums">{group.memories.length}</span>
              </div>
              <div className="p-1 space-y-0.5">
                {group.memories.map((memory, index) => {
                  const title = parseSnippetTitle(memory.snippet)
                  const trigger = formatRetrievalTrigger(memory)

                  return (
                    <button
                      key={`${memory.id}-${index}`}
                      type="button"
                      onClick={() => onSelectMemory(memory.id, {
                        prompt: memory.prompt,
                        similarity: memory.similarity,
                        keywordMatch: memory.keywordMatch,
                        score: memory.score
                      })}
                      className="w-full text-left flex items-center gap-1.5 py-1 px-1.5 rounded text-xs cursor-pointer hover:bg-secondary/50 transition-base group"
                    >
                      <span className="flex-1 truncate text-foreground/70 group-hover:text-foreground/90">{title}</span>
                      {trigger && (
                        <span className={`text-[9px] font-mono px-0.5 rounded bg-background/50 shrink-0 ${trigger.color}`} title={trigger.title}>
                          {trigger.label}
                        </span>
                      )}
                      <span className={`text-[10px] font-mono shrink-0 ${getUsageColor(memory.stats)}`}>
                        {formatUsageRatio(memory.stats)}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
