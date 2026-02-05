import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Loader2, ChevronDown } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Badge } from '@/components/ui/badge'
import ChatMessage from '@/components/ChatMessage'
import ToolResultCard from '@/components/ToolResultCard'
import type { ChatRole, ChatToolName, ChatToolResult, ChatMessage as ApiChatMessage } from '@/lib/api'
import { streamChat } from '@/lib/api'

interface ChatEntryMessage {
  type: 'message'
  id: string
  role: ChatRole
  content: string
}

interface ChatEntryTool {
  type: 'tool'
  id: string
  name: ChatToolName
  input: unknown
  result?: ChatToolResult
  status: 'pending' | 'complete' | 'error'
}

type ChatEntry = ChatEntryMessage | ChatEntryTool

function formatToolSummary(tool: ChatToolName, input: unknown): string {
  if (!input || typeof input !== 'object') return tool
  const record = input as Record<string, unknown>

  if (tool === 'search_memories') {
    const query = typeof record.query === 'string' ? record.query : ''
    return query ? `search_memories: "${query}"` : 'search_memories'
  }

  if (tool === 'update_memory') {
    const id = typeof record.id === 'string' ? record.id : ''
    return id ? `update_memory: ${id}` : 'update_memory'
  }

  if (tool === 'delete_memories') {
    const ids = Array.isArray(record.ids) ? record.ids.length : 0
    return ids ? `delete_memories: ${ids} ids` : 'delete_memories'
  }

  return tool
}

function ToolCallEntry({ entry }: { entry: ChatEntryTool }) {
  const [open, setOpen] = useState(false)
  const summary = formatToolSummary(entry.name, entry.input)

  return (
    <div className="flex justify-start">
      <Collapsible open={open} onOpenChange={setOpen} className="w-full">
        <div className="w-full rounded-xl border border-border/60 bg-secondary/40 p-3">
          <div className="flex items-center justify-between gap-3">
            <CollapsibleTrigger asChild>
              <button type="button" className="flex items-center gap-2 text-left">
                <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} />
                <div className="text-xs uppercase tracking-wide text-muted-foreground font-medium">{summary}</div>
              </button>
            </CollapsibleTrigger>
            <Badge
              variant={entry.status === 'error' ? 'destructive' : 'secondary'}
              className="text-[10px] uppercase"
            >
              {entry.status === 'pending' ? 'running' : entry.status}
            </Badge>
          </div>
          <CollapsibleContent className="mt-3 space-y-3">
            <pre className="rounded-lg border border-border/60 bg-background/80 p-3 text-xs text-muted-foreground overflow-x-auto">
              {JSON.stringify(entry.input, null, 2)}
            </pre>
            {entry.result ? (
              <ToolResultCard tool={entry.name} result={entry.result} />
            ) : (
              <div className="text-xs text-muted-foreground">Waiting for tool result...</div>
            )}
          </CollapsibleContent>
        </div>
      </Collapsible>
    </div>
  )
}

export default function Chat() {
  const [entries, setEntries] = useState<ChatEntry[]>([])
  const [input, setInput] = useState('')
  const [project, setProject] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const activeAssistantIdRef = useRef<string | null>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [entries, isStreaming])

  useEffect(() => {
    return () => {
      abortRef.current?.abort()
    }
  }, [])

  const appendAssistantText = (text: string) => {
    setEntries(prev => {
      const next = [...prev]
      const activeId = activeAssistantIdRef.current
      const last = next[next.length - 1]
      if (last && last.type === 'message' && last.role === 'assistant' && last.id === activeId) {
        next[next.length - 1] = { ...last, content: last.content + text }
        return next
      }
      const id = crypto.randomUUID()
      activeAssistantIdRef.current = id
      next.push({
        type: 'message',
        id,
        role: 'assistant',
        content: text
      })
      return next
    })
  }

  const handleSend = async () => {
    const trimmed = input.trim()
    if (!trimmed || isStreaming) return

    const userEntry: ChatEntryMessage = {
      type: 'message',
      id: crypto.randomUUID(),
      role: 'user',
      content: trimmed
    }

    const nextEntries = [...entries, userEntry]
    setEntries(nextEntries)
    setInput('')
    setError(null)
    setIsStreaming(true)
    activeAssistantIdRef.current = null

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    const messages: ApiChatMessage[] = nextEntries
      .filter((entry): entry is ChatEntryMessage => entry.type === 'message')
      .map(entry => ({ role: entry.role, content: entry.content }))

    try {
      await streamChat(
        {
          messages,
          project: project.trim() || undefined
        },
        {
          signal: controller.signal,
          onEvent: event => {
            if (controller.signal.aborted) return

            if (event.type === 'text') {
              appendAssistantText(event.text)
            }

            if (event.type === 'tool_use') {
              activeAssistantIdRef.current = null
              setEntries(prev => [
                ...prev,
                {
                  type: 'tool',
                  id: event.id,
                  name: event.name,
                  input: event.input,
                  status: 'pending'
                }
              ])
            }

            if (event.type === 'tool_result') {
              setEntries(prev => prev.map(entry => {
                if (entry.type !== 'tool' || entry.id !== event.tool_use_id) return entry
                return {
                  ...entry,
                  status: event.is_error ? 'error' : 'complete',
                  result: event.result
                }
              }))
            }

            if (event.type === 'error') {
              setError(event.error)
              setIsStreaming(false)
            }

            if (event.type === 'done') {
              setIsStreaming(false)
            }
          }
        }
      )
    } catch (err) {
      if (controller.signal.aborted) return
      const message = err instanceof Error ? err.message : 'Chat request failed'
      setError(message)
      setIsStreaming(false)
    } finally {
      setIsStreaming(false)
    }
  }

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()
    void handleSend()
  }

  return (
    <div className="flex flex-col gap-5 h-[calc(100vh-7rem)]">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Memory Chat</h1>
          <p className="text-sm text-muted-foreground">
            Ask questions, search, or manage memories conversationally.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Input
            value={project}
            onChange={e => setProject(e.target.value)}
            placeholder="Project (optional)"
            className="w-60"
          />
        </div>
      </div>

      <Card className="flex-1 flex flex-col overflow-hidden">
        <CardContent className="flex-1 overflow-y-auto p-4 space-y-3">
          {entries.length === 0 && (
            <div className="text-sm text-muted-foreground">
              Start by asking about recent commands, errors, or procedures.
            </div>
          )}
          {entries.map(entry => (
            entry.type === 'message'
              ? <ChatMessage key={entry.id} role={entry.role} content={entry.content} />
              : <ToolCallEntry key={entry.id} entry={entry} />
          ))}
          <div ref={bottomRef} />
        </CardContent>
        <div className="border-t border-border/60 p-3 space-y-2">
          {error && (
            <div className="text-sm text-destructive">{error}</div>
          )}
          <form onSubmit={handleSubmit} className="flex items-end gap-2">
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              placeholder="Ask the memory assistant..."
              className="flex-1 min-h-[44px] max-h-32 rounded-lg border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  void handleSend()
                }
              }}
              disabled={isStreaming}
            />
            <Button type="submit" disabled={!input.trim() || isStreaming}>
              {isStreaming && <Loader2 className="animate-spin" />}
              {isStreaming ? 'Sending' : 'Send'}
            </Button>
          </form>
          {isStreaming && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Assistant is responding...
            </div>
          )}
        </div>
      </Card>
    </div>
  )
}
