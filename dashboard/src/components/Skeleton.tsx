import { Skeleton as ShadcnSkeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import type { HTMLAttributes } from 'react'

export default function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <ShadcnSkeleton
      className={cn('bg-secondary/60', className)}
      {...props}
    />
  )
}
