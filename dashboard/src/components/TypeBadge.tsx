import type { RecordType } from '@/lib/api'

const typeConfig: Record<RecordType, { label: string; dotClass: string }> = {
  command: { label: 'Command', dotClass: 'bg-type-command' },
  error: { label: 'Error', dotClass: 'bg-type-error' },
  discovery: { label: 'Discovery', dotClass: 'bg-type-discovery' },
  procedure: { label: 'Procedure', dotClass: 'bg-type-procedure' },
}

interface TypeBadgeProps {
  type: RecordType
  showLabel?: boolean
}

export default function TypeBadge({ type, showLabel = true }: TypeBadgeProps) {
  const config = typeConfig[type]

  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`w-2 h-2 rounded-full ${config.dotClass}`} />
      {showLabel && (
        <span className="text-xs text-muted-foreground">{config.label}</span>
      )}
    </span>
  )
}

// Compact version for tables
export function TypeDot({ type }: { type: RecordType }) {
  const config = typeConfig[type]
  return (
    <span
      className={`w-2 h-2 rounded-full ${config.dotClass}`}
      title={config.label}
    />
  )
}
