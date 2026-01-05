import type { ReactNode } from 'react'

interface StatsCardProps {
  label: string
  value: ReactNode
  subtext?: string
}

export default function StatsCard({ label, value, subtext }: StatsCardProps) {
  return (
    <div className="relative">
      <div className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide mb-2">
        {label}
      </div>
      <div className="text-3xl font-semibold tabular-nums tracking-tight">{value}</div>
      {subtext && (
        <div className="text-xs text-muted-foreground mt-1">{subtext}</div>
      )}
    </div>
  )
}
