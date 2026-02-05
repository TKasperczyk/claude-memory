import Markdown from 'react-markdown'
import type { ChatRole } from '@/lib/api'

interface ChatMessageProps {
  role: ChatRole
  content: string
}

export default function ChatMessage({ role, content }: ChatMessageProps) {
  const isUser = role === 'user'

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} animate-in fade-in-0 slide-in-from-bottom-2 duration-200`}>
      <div className={`relative max-w-[80%] ${isUser ? 'mr-1' : 'ml-1'}`}>
        {/* Role indicator */}
        <div className={`absolute -top-4 ${isUser ? 'right-0' : 'left-0'} text-[10px] uppercase tracking-wider text-muted-foreground/50 font-medium`}>
          {isUser ? 'you' : 'assistant'}
        </div>

        {/* Message bubble */}
        <div
          className={`rounded-2xl px-4 py-3 text-sm leading-relaxed ${
            isUser
              ? 'bg-foreground text-background rounded-br-md whitespace-pre-wrap'
              : 'bg-secondary/80 text-foreground border border-border/50 rounded-bl-md'
          }`}
        >
          {isUser ? content : (
            <Markdown
              components={{
                p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
                em: ({ children }) => <em className="italic">{children}</em>,
                ul: ({ children }) => <ul className="list-disc list-inside mb-2 last:mb-0 space-y-1">{children}</ul>,
                ol: ({ children }) => <ol className="list-decimal list-inside mb-2 last:mb-0 space-y-1">{children}</ol>,
                li: ({ children }) => <li>{children}</li>,
                code: ({ children }) => (
                  <code className="px-1.5 py-0.5 rounded bg-background/50 text-xs font-mono">{children}</code>
                ),
                pre: ({ children }) => (
                  <pre className="my-2 p-3 rounded-lg bg-background/50 overflow-x-auto text-xs font-mono">{children}</pre>
                ),
                a: ({ href, children }) => (
                  <a href={href} className="text-info hover:underline" target="_blank" rel="noopener noreferrer">{children}</a>
                ),
              }}
            >
              {content}
            </Markdown>
          )}
        </div>
      </div>
    </div>
  )
}
