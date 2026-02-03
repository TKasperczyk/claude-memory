import type { ReactNode } from 'react'
import { Area, AreaChart, ResponsiveContainer } from 'recharts'

interface StatsCardProps {
  label: string
  value: ReactNode
  subtext?: string
  sparklineData?: number[]
  sparklineColor?: string
}

export default function StatsCard({ label, value, subtext, sparklineData, sparklineColor = 'hsl(var(--primary))' }: StatsCardProps) {
  const hasSparkline = sparklineData && sparklineData.length > 1

  // Calculate trend from sparkline data
  const trend = hasSparkline ? (() => {
    const first = sparklineData[0]
    const last = sparklineData[sparklineData.length - 1]
    if (first === 0) return null
    const change = ((last - first) / first) * 100
    return Math.abs(change) < 0.1 ? null : change
  })() : null

  return (
    <div className="relative p-4 rounded-lg bg-muted/30 border border-border/40 overflow-hidden">
      <div className="relative z-10">
        <div className="text-xs font-medium text-muted-foreground mb-1">
          {label}
        </div>
        <div className="flex items-end gap-2">
          <div className="text-2xl font-semibold tabular-nums tracking-tight">{value}</div>
          {trend !== null && (
            <div className={`text-[11px] font-medium mb-1 ${trend >= 0 ? 'text-success' : 'text-destructive'}`}>
              {trend >= 0 ? '+' : ''}{trend.toFixed(1)}%
            </div>
          )}
        </div>
        {subtext && (
          <div className="text-[11px] text-muted-foreground/70 mt-0.5">{subtext}</div>
        )}
      </div>
      {hasSparkline && (
        <div className="absolute inset-x-0 bottom-0 h-12 opacity-30">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={sparklineData.map((v, i) => ({ value: v, index: i }))}>
              <defs>
                <linearGradient id={`sparkline-${label.replace(/\s/g, '')}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={sparklineColor} stopOpacity={0.4} />
                  <stop offset="100%" stopColor={sparklineColor} stopOpacity={0} />
                </linearGradient>
              </defs>
              <Area
                type="monotone"
                dataKey="value"
                stroke={sparklineColor}
                strokeWidth={1.5}
                fill={`url(#sparkline-${label.replace(/\s/g, '')})`}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}
