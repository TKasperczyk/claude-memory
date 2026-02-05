import type { ChatRole } from '@/lib/api'

interface ChatMessageProps {
  role: ChatRole
  content: string
}

export default function ChatMessage({ role, content }: ChatMessageProps) {
  const isUser = role === 'user'

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[75%] rounded-2xl px-4 py-2 text-sm leading-relaxed whitespace-pre-wrap shadow-sm border ${
          isUser
            ? 'bg-primary text-primary-foreground border-primary/30'
            : 'bg-secondary text-foreground border-border/60'
        }`}
      >
        {content}
      </div>
    </div>
  )
}
