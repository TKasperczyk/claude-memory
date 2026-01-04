import type { RecordType } from '@/lib/api'

const typeStyles: Record<RecordType, { label: string; className: string }> = {
  command: {
    label: 'Command',
    className: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200'
  },
  error: {
    label: 'Error',
    className: 'border-rose-500/40 bg-rose-500/15 text-rose-200'
  },
  discovery: {
    label: 'Discovery',
    className: 'border-sky-500/40 bg-sky-500/15 text-sky-200'
  },
  procedure: {
    label: 'Procedure',
    className: 'border-amber-500/40 bg-amber-500/15 text-amber-200'
  }
}

export default function TypeBadge({ type }: { type: RecordType }) {
  const style = typeStyles[type]
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold uppercase tracking-wide ${style.className}`}
    >
      {style.label}
    </span>
  )
}
