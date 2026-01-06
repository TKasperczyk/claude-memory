import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

export default function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading"
      className={cn('animate-pulse rounded-md bg-secondary/60', className)}
      {...props}
    />
  )
}
