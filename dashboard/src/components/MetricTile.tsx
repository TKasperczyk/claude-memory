import type { ReactNode } from 'react'

interface MetricTileProps {
  label: string
  value: ReactNode
  valueClassName?: string
}

export default function MetricTile({ label, value, valueClassName }: MetricTileProps) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className={`text-sm font-semibold tabular-nums ${valueClassName ?? ''}`}>{value}</span>
    </div>
  )
}
