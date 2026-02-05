import type { KeyboardEvent } from 'react'

export default function RecordLink({
  id,
  onSelect,
  className,
  stopPropagation = false
}: {
  id: string
  onSelect?: (id: string) => void
  className?: string
  stopPropagation?: boolean
}) {
  const classes = [className, onSelect ? 'transition-base hover:text-foreground' : null]
    .filter(Boolean)
    .join(' ')

  if (!onSelect) {
    return <span className={classes}>{id}</span>
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (stopPropagation && (event.key === 'Enter' || event.key === ' ')) {
      event.stopPropagation()
    }
  }

  return (
    <button
      type="button"
      onClick={(event) => {
        if (stopPropagation) event.stopPropagation()
        onSelect(id)
      }}
      onKeyDown={handleKeyDown}
      className={classes}
    >
      {id}
    </button>
  )
}
