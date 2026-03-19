import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useLocation } from 'react-router-dom'

const uuid = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('')
import { Loader2, ChevronDown, Send, Sparkles, MessageSquare } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
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

  if (tool === 'create_memory') {
    const type = typeof record.type === 'string' ? record.type : ''
    return type ? `create_memory: ${type}` : 'create_memory'
  }

  if (tool === 'delete_memories') {
    const ids = Array.isArray(record.ids) ? record.ids.length : 0
    return ids ? `delete_memories: ${ids} ids` : 'delete_memories'
  }

  if (tool === 'list_extractions') {
    return 'list_extractions'
  }

  if (tool === 'get_extraction') {
    const runId = typeof record.runId === 'string' ? record.runId.slice(0, 8) : ''
    return runId ? `get_extraction: ${runId}...` : 'get_extraction'
  }

  return tool
}

function ToolCallEntry({ entry }: { entry: ChatEntryTool }) {
  const [open, setOpen] = useState(false)
  const summary = formatToolSummary(entry.name, entry.input)
  const isPending = entry.status === 'pending'

  return (
    <div className="flex justify-start animate-in fade-in-0 slide-in-from-bottom-2 duration-200">
      <Collapsible open={open} onOpenChange={setOpen} className="w-full max-w-[90%]">
        <div className="rounded-xl border border-dashed border-border/80 bg-background p-3">
          <div className="flex items-center justify-between gap-3">
            <CollapsibleTrigger asChild>
              <button type="button" className="flex items-center gap-2 text-left group">
                <div className={`w-5 h-5 rounded-md flex items-center justify-center transition-colors ${isPending ? 'bg-info/20' : entry.status === 'error' ? 'bg-destructive/20' : 'bg-success/20'}`}>
                  <ChevronDown className={`w-3 h-3 transition-transform duration-200 ${isPending ? 'text-info' : entry.status === 'error' ? 'text-destructive' : 'text-success'} ${open ? 'rotate-180' : ''}`} />
                </div>
                <code className="text-xs text-muted-foreground font-mono group-hover:text-foreground transition-colors">{summary}</code>
              </button>
            </CollapsibleTrigger>
            <div className="flex items-center gap-2">
              {isPending && <Loader2 className="w-3 h-3 animate-spin text-info" />}
              <Badge
                variant={entry.status === 'error' ? 'destructive' : 'secondary'}
                className="text-[10px] uppercase font-mono"
              >
                {isPending ? 'running' : entry.status}
              </Badge>
            </div>
          </div>
          <CollapsibleContent className="mt-3 space-y-3">
            <pre className="rounded-lg border border-border bg-secondary/50 p-3 text-xs text-muted-foreground overflow-x-auto font-mono">
              {JSON.stringify(entry.input, null, 2)}
            </pre>
            {entry.result ? (
              <ToolResultCard tool={entry.name} result={entry.result} />
            ) : (
              <div className="text-xs text-muted-foreground/60 italic">Awaiting response...</div>
            )}
          </CollapsibleContent>
        </div>
      </Collapsible>
    </div>
  )
}

interface ChatLocationState {
  extractionRunId?: string
}

export default function Chat() {
  const location = useLocation()
  const locationState = location.state as ChatLocationState | null
  const [entries, setEntries] = useState<ChatEntry[]>([])
  const [input, setInput] = useState('')
  const [project, setProject] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const autoSentRunIdRef = useRef<string | null>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [entries, isStreaming])

  useEffect(() => {
    return () => {
      abortRef.current?.abort()
    }
  }, [])

  // Focus input on mount and after streaming completes
  useEffect(() => {
    if (!isStreaming) {
      inputRef.current?.focus()
    }
  }, [isStreaming])

  // Auto-send when navigated with extraction context
  useEffect(() => {
    const runId = locationState?.extractionRunId
    if (!runId || runId === autoSentRunIdRef.current || isStreaming) return
    const message = `Show me extraction run ${runId} with its review and extracted records. Summarize the extraction quality and any issues found.`
    const timer = setTimeout(() => {
      autoSentRunIdRef.current = runId
      void handleSend(message)
    }, 0)
    return () => clearTimeout(timer)
  }, [locationState, isStreaming]) // eslint-disable-line react-hooks/exhaustive-deps

  const appendAssistantText = (text: string) => {
    setEntries(prev => {
      const last = prev[prev.length - 1]
      // Append to existing assistant message if that's the last entry
      if (last?.type === 'message' && last.role === 'assistant') {
        return [...prev.slice(0, -1), { ...last, content: last.content + text }]
      }
      // Otherwise create a new assistant message
      return [...prev, { type: 'message', id: uuid(), role: 'assistant', content: text }]
    })
  }

  const handleSend = async (overrideMessage?: string) => {
    const trimmed = (overrideMessage ?? input).trim()
    if (!trimmed || isStreaming) return

    const userEntry: ChatEntryMessage = {
      type: 'message',
      id: uuid(),
      role: 'user',
      content: trimmed
    }

    const nextEntries = [...entries, userEntry]
    setEntries(nextEntries)
    setInput('')
    setError(null)
    setIsStreaming(true)

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
    <div className="flex flex-col h-[calc(100vh-7rem)]">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 pb-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-foreground/10 to-foreground/5 border border-border flex items-center justify-center">
            <MessageSquare className="w-4 h-4 text-foreground/70" />
          </div>
          <div>
            <h1 className="text-base font-semibold tracking-tight">Memory Chat</h1>
            <p className="text-xs text-muted-foreground">
              Search and manage memories conversationally
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Input
              value={project}
              onChange={e => setProject(e.target.value)}
              placeholder="Project scope"
              className="w-48 h-8 text-xs pl-3 pr-8 bg-secondary/50"
            />
            {project && (
              <div className="absolute right-2 top-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full bg-success" />
            )}
          </div>
        </div>
      </div>

      {/* Chat area */}
      <Card className="flex-1 flex flex-col overflow-hidden border-border/60">
        <CardContent className="flex-1 overflow-y-auto p-5 space-y-6">
          {entries.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center py-12">
              <div className="w-14 h-14 rounded-2xl bg-secondary/80 border border-border flex items-center justify-center mb-4">
                <Sparkles className="w-6 h-6 text-muted-foreground/60" />
              </div>
              <h2 className="text-sm font-medium text-foreground/80 mb-1">Start a conversation</h2>
              <p className="text-xs text-muted-foreground max-w-xs">
                Ask about commands, errors, or procedures. The assistant can search, update, and delete memories.
              </p>
              <div className="flex flex-wrap justify-center gap-2 mt-4">
                {['What errors occurred recently?', 'Show me npm commands', 'Find git procedures'].map(suggestion => (
                  <button
                    key={suggestion}
                    type="button"
                    onClick={() => setInput(suggestion)}
                    className="px-3 py-1.5 text-xs rounded-full border border-border bg-secondary/50 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          )}
          {entries.map(entry => (
            entry.type === 'message'
              ? <ChatMessage key={entry.id} role={entry.role} content={entry.content} />
              : <ToolCallEntry key={entry.id} entry={entry} />
          ))}
          <div ref={bottomRef} />
        </CardContent>

        {/* Input area */}
        <div className="border-t border-border/60 bg-secondary/30 p-4">
          {error && (
            <div className="mb-3 px-3 py-2 rounded-lg bg-destructive/10 border border-destructive/20 text-sm text-destructive">
              {error}
            </div>
          )}
          <form onSubmit={handleSubmit} className="flex items-end gap-3">
            <div className="flex-1 relative">
              <Textarea
                ref={inputRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                placeholder="Ask about your memories..."
                rows={1}
                className="min-h-[48px] max-h-36 rounded-xl px-4 py-3 pr-12 resize-none"
                onKeyDown={event => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    void handleSend()
                  }
                }}
                disabled={isStreaming}
              />
              <div className="absolute right-3 bottom-3 text-[10px] text-muted-foreground/40 font-mono">
                {isStreaming ? '' : 'enter'}
              </div>
            </div>
            <Button
              type="submit"
              disabled={!input.trim() || isStreaming}
              className="h-12 w-12 rounded-xl p-0"
            >
              {isStreaming ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Send className="w-4 h-4" />
              )}
            </Button>
          </form>
          {isStreaming && (
            <div className="flex items-center gap-2 mt-3 text-xs text-muted-foreground">
              <span className="inline-flex gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/60 animate-pulse" style={{ animationDelay: '0ms' }} />
                <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/60 animate-pulse" style={{ animationDelay: '150ms' }} />
                <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/60 animate-pulse" style={{ animationDelay: '300ms' }} />
              </span>
              <span>Thinking...</span>
            </div>
          )}
        </div>
      </Card>
    </div>
  )
}
