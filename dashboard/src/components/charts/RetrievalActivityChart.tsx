import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { Skeleton } from '@/components/ui/skeleton'
import type { RetrievalActivity } from '@/lib/api'

const chartConfig = {
  count: {
    label: 'Retrievals',
    color: 'hsl(var(--primary))',
  },
} satisfies ChartConfig

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })
}

interface RetrievalActivityChartProps {
  data: RetrievalActivity | undefined
  isLoading?: boolean
}

export function RetrievalActivityChart({ data, isLoading }: RetrievalActivityChartProps) {
  if (isLoading) {
    return <Skeleton className="h-[200px] w-full" />
  }

  if (!data || data.buckets.length === 0) {
    return (
      <div className="flex h-[200px] items-center justify-center text-sm text-muted-foreground">
        No retrieval activity yet
      </div>
    )
  }

  const chartData = data.buckets.map(bucket => ({
    date: formatDate(bucket.start),
    count: bucket.count,
    timestamp: bucket.start,
  }))

  return (
    <ChartContainer config={chartConfig} className="h-[200px] w-full">
      <AreaChart
        data={chartData}
        margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
      >
        <defs>
          <linearGradient id="fillRetrievals" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--color-count)" stopOpacity={0.3} />
            <stop offset="95%" stopColor="var(--color-count)" stopOpacity={0.05} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey="date"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={32}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          width={40}
          allowDecimals={false}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(_, payload) => {
                if (payload?.[0]?.payload?.timestamp) {
                  return new Date(payload[0].payload.timestamp).toLocaleDateString('en-US', {
                    weekday: 'short',
                    month: 'short',
                    day: 'numeric',
                  })
                }
                return ''
              }}
            />
          }
        />
        <Area
          type="monotone"
          dataKey="count"
          stroke="var(--color-count)"
          fill="url(#fillRetrievals)"
          strokeWidth={2}
        />
      </AreaChart>
    </ChartContainer>
  )
}
