import { Line, LineChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { Skeleton } from '@/components/ui/skeleton'
import type { StatsHistoryResponse } from '@/lib/api'

const chartConfig = {
  total: {
    label: 'Total Memories',
    color: 'hsl(var(--primary))',
  },
  command: {
    label: 'Commands',
    color: 'hsl(var(--type-command))',
  },
  error: {
    label: 'Errors',
    color: 'hsl(var(--type-error))',
  },
  discovery: {
    label: 'Discoveries',
    color: 'hsl(var(--type-discovery))',
  },
  procedure: {
    label: 'Procedures',
    color: 'hsl(var(--type-procedure))',
  },
} satisfies ChartConfig

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })
}

interface MemoryGrowthChartProps {
  data: StatsHistoryResponse | undefined
  isLoading?: boolean
  showByType?: boolean
}

export function MemoryGrowthChart({ data, isLoading, showByType = false }: MemoryGrowthChartProps) {
  if (isLoading) {
    return <Skeleton className="h-[200px] w-full" />
  }

  if (!data || data.buckets.length === 0) {
    return (
      <div className="flex h-[200px] items-center justify-center text-sm text-muted-foreground">
        No historical data yet
      </div>
    )
  }

  // Filter out buckets without snapshots
  const validBuckets = data.buckets.filter(b => b.snapshot !== null)

  if (validBuckets.length === 0) {
    return (
      <div className="flex h-[200px] items-center justify-center text-sm text-muted-foreground">
        No historical data yet
      </div>
    )
  }

  const chartData = validBuckets.map(bucket => ({
    date: formatDate(bucket.start),
    timestamp: bucket.start,
    total: bucket.snapshot!.total,
    command: bucket.snapshot!.byType.command ?? 0,
    error: bucket.snapshot!.byType.error ?? 0,
    discovery: bucket.snapshot!.byType.discovery ?? 0,
    procedure: bucket.snapshot!.byType.procedure ?? 0,
  }))

  return (
    <ChartContainer config={chartConfig} className="h-[200px] w-full">
      <LineChart
        data={chartData}
        margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
      >
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
        {showByType ? (
          <>
            <Line
              type="monotone"
              dataKey="command"
              stroke="var(--color-command)"
              strokeWidth={2}
              dot={false}
            />
            <Line
              type="monotone"
              dataKey="error"
              stroke="var(--color-error)"
              strokeWidth={2}
              dot={false}
            />
            <Line
              type="monotone"
              dataKey="discovery"
              stroke="var(--color-discovery)"
              strokeWidth={2}
              dot={false}
            />
            <Line
              type="monotone"
              dataKey="procedure"
              stroke="var(--color-procedure)"
              strokeWidth={2}
              dot={false}
            />
          </>
        ) : (
          <Line
            type="monotone"
            dataKey="total"
            stroke="var(--color-total)"
            strokeWidth={2}
            dot={false}
          />
        )}
      </LineChart>
    </ChartContainer>
  )
}
