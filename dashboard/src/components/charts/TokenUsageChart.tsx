import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { Skeleton } from '@/components/ui/skeleton'
import type { TokenUsageActivity } from '@/lib/api'

const chartConfig = {
  totalTokens: {
    label: 'Tokens',
    color: 'hsl(var(--primary))',
  },
} satisfies ChartConfig

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}k`
  return String(value)
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })
}

interface TokenUsageChartProps {
  data: TokenUsageActivity | undefined
  isLoading?: boolean
}

export function TokenUsageChart({ data, isLoading }: TokenUsageChartProps) {
  if (isLoading) {
    return <Skeleton className="h-[200px] w-full" />
  }

  if (!data || data.buckets.length === 0) {
    return (
      <div className="flex h-[200px] items-center justify-center text-sm text-muted-foreground">
        No token usage yet
      </div>
    )
  }

  const chartData = data.buckets.map(bucket => ({
    date: formatDate(bucket.start),
    totalTokens: bucket.totalTokens,
    timestamp: bucket.start,
  }))

  return (
    <ChartContainer config={chartConfig} className="h-[200px] w-full">
      <AreaChart
        data={chartData}
        margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
      >
        <defs>
          <linearGradient id="fillTokenUsage" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--color-totalTokens)" stopOpacity={0.3} />
            <stop offset="95%" stopColor="var(--color-totalTokens)" stopOpacity={0.05} />
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
          width={55}
          allowDecimals={false}
          tickFormatter={formatTokenCount}
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
          dataKey="totalTokens"
          stroke="var(--color-totalTokens)"
          fill="url(#fillTokenUsage)"
          strokeWidth={2}
        />
      </AreaChart>
    </ChartContainer>
  )
}
