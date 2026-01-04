import type { ReactNode } from 'react'

interface StatsCardProps {
  title: string
  value: ReactNode
  detail?: string
  accentClassName?: string
  children?: ReactNode
}

export default function StatsCard({
  title,
  value,
  detail,
  accentClassName = 'text-emerald-300',
  children
}: StatsCardProps) {
  return (
    <div className="rounded-2xl border border-white/10 bg-[color:var(--panel)] p-5 shadow-[0_20px_50px_-30px_rgba(0,0,0,0.8)]">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[11px] uppercase tracking-[0.28em] text-slate-400">{title}</p>
          <div className={`mt-3 text-3xl font-semibold ${accentClassName}`}>{value}</div>
          {detail ? <p className="mt-2 text-sm text-slate-400">{detail}</p> : null}
        </div>
      </div>
      {children ? <div className="mt-4">{children}</div> : null}
    </div>
  )
}
