import type { ReactNode } from 'react'

export default function FilterChip({
  active,
  onClick,
  children
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-7 px-2.5 text-[11px] rounded-full border transition-base ${
        active
          ? 'bg-primary text-primary-foreground border-foreground'
          : 'bg-background border-border text-muted-foreground hover:text-foreground'
      }`}
    >
      {children}
    </button>
  )
}
