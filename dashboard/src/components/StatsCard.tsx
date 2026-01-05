import type { ReactNode } from 'react'

interface StatsCardProps {
  label: string
  value: ReactNode
  subtext?: string
}

export default function StatsCard({ label, value, subtext }: StatsCardProps) {
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      {subtext && (
        <div className="text-xs text-muted-foreground">{subtext}</div>
      )}
    </div>
  )
}
