import Skeleton from '@/components/Skeleton'

export default function ReviewSkeleton() {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-3 w-28" />
      </div>
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-4 w-4/6" />
    </div>
  )
}
