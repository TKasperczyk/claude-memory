import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
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
              remarkPlugins={[remarkGfm]}
              components={{
                h1: ({ children }) => <h1 className="text-lg font-bold mb-3 mt-4 first:mt-0">{children}</h1>,
                h2: ({ children }) => <h2 className="text-base font-bold mb-2 mt-3 first:mt-0">{children}</h2>,
                h3: ({ children }) => <h3 className="text-sm font-bold mb-2 mt-3 first:mt-0">{children}</h3>,
                h4: ({ children }) => <h4 className="text-sm font-semibold mb-1 mt-2 first:mt-0">{children}</h4>,
                p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
                em: ({ children }) => <em className="italic">{children}</em>,
                ul: ({ children }) => <ul className="list-disc list-inside mb-2 last:mb-0 space-y-1">{children}</ul>,
                ol: ({ children }) => <ol className="list-decimal list-inside mb-2 last:mb-0 space-y-1">{children}</ol>,
                li: ({ children }) => <li>{children}</li>,
                blockquote: ({ children }) => (
                  <blockquote className="border-l-2 border-muted-foreground/30 pl-3 my-2 text-muted-foreground italic">{children}</blockquote>
                ),
                hr: () => <hr className="my-3 border-border/50" />,
                table: ({ children }) => (
                  <div className="my-2 overflow-x-auto rounded-lg border border-border/50">
                    <table className="w-full text-xs">{children}</table>
                  </div>
                ),
                thead: ({ children }) => <thead className="bg-background/50">{children}</thead>,
                tbody: ({ children }) => <tbody className="divide-y divide-border/30">{children}</tbody>,
                tr: ({ children }) => <tr className="divide-x divide-border/30">{children}</tr>,
                th: ({ children }) => <th className="px-3 py-1.5 text-left font-semibold">{children}</th>,
                td: ({ children }) => <td className="px-3 py-1.5">{children}</td>,
                code: ({ children, className }) => {
                  const isBlock = className?.includes('language-')
                  if (isBlock) {
                    return <code className="text-xs font-mono">{children}</code>
                  }
                  return (
                    <code className="px-1.5 py-0.5 rounded bg-background/50 text-xs font-mono">{children}</code>
                  )
                },
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
