import ReviewSkeleton from '@/components/ReviewSkeleton'
import Skeleton from '@/components/Skeleton'

export function RecordsSkeleton() {
  const items = Array.from({ length: 3 })

  return (
    <div className="space-y-2">
      {items.map((_, index) => (
        <div key={index} className="rounded-md border border-border bg-secondary/30 px-3 py-2 space-y-2">
          <div className="flex items-center gap-2">
            <Skeleton className="h-2 w-2 rounded-full" />
            <Skeleton className="h-3 w-12" />
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-3 w-3 ml-auto" />
          </div>
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-3 w-full" />
        </div>
      ))}
    </div>
  )
}

export function ExtractionListSkeleton() {
  const cards = Array.from({ length: 4 })

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)] xl:grid-cols-[minmax(0,380px)_minmax(0,1fr)] 2xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
      <div className="rounded-xl border border-border bg-card p-3">
        <div className="flex items-center justify-between mb-2">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 w-6" />
        </div>
        <div className="space-y-2">
          {cards.map((_, index) => (
            <div key={index} className="rounded-lg border border-border bg-card p-3 space-y-2">
              <div className="flex items-center gap-3">
                <Skeleton className="h-2.5 w-2.5 rounded-full" />
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-3 w-16 ml-auto" />
              </div>
              <Skeleton className="h-3 w-40" />
              <div className="flex gap-2">
                <Skeleton className="h-5 w-14" />
                <Skeleton className="h-5 w-20" />
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="rounded-xl border border-border bg-card p-4 space-y-3">
        <div className="rounded-lg border border-border bg-background/50 p-3 space-y-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-48" />
          <div className="flex gap-3">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-3 w-14" />
          </div>
        </div>
        <ReviewSkeleton />
        <div className="rounded-lg border border-border bg-background/40 p-3">
          <RecordsSkeleton />
        </div>
      </div>
    </div>
  )
}
