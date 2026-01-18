import type { ReactNode, MouseEvent } from 'react'

interface ListItemProps {
  children: ReactNode
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void
  selected?: boolean
  compact?: boolean
  className?: string
}

/**
 * A styled list item button with consistent styling across the dashboard.
 * Matches the session list entry styling with:
 * - Selected state: highlighted border, ring, shadow
 * - Unselected state: subtle border with hover effects
 * - compact: smaller padding for dense lists
 */
export default function ListItem({
  children,
  onClick,
  selected = false,
  compact = false,
  className = ''
}: ListItemProps) {
  const sizeClasses = compact ? 'rounded px-2 py-1.5' : 'rounded-lg px-3 py-2'

  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left border transition-base ${sizeClasses} ${
        selected
          ? 'border-foreground/50 bg-secondary shadow-sm ring-1 ring-foreground/15'
          : 'border-border bg-secondary/80 hover:bg-secondary hover:border-foreground/30'
      } ${className}`}
    >
      {children}
    </button>
  )
}
