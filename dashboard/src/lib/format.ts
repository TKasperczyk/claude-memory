export function formatDuration(durationMs: number): string {
  if (!durationMs || durationMs <= 0) return '0ms'
  if (durationMs < 1000) return `${durationMs}ms`
  return `${(durationMs / 1000).toFixed(1)}s`
}

export function formatDateTime(timestamp?: number): string {
  if (!timestamp) return '—'
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp)
}

export function formatRelativeTimeShort(
  timestamp?: number,
  options: { includeAgo?: boolean } = {}
): string {
  if (!timestamp) return '—'
  const diff = Date.now() - timestamp
  const mins = Math.floor(diff / 60000)
  const hours = Math.floor(mins / 60)
  const days = Math.floor(hours / 24)
  const suffix = options.includeAgo ? ' ago' : ''
  if (days > 0) return `${days}d${suffix}`
  if (hours > 0) return `${hours}h${suffix}`
  if (mins > 0) return `${mins}m${suffix}`
  return 'now'
}

export function formatRelativeTimeLong(timestamp?: number): string {
  if (!timestamp) return '—'
  const diff = Date.now() - timestamp
  const mins = Math.floor(diff / 60000)
  const hours = Math.floor(mins / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days} day${days > 1 ? 's' : ''} ago`
  if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''} ago`
  if (mins > 0) return `${mins} minute${mins > 1 ? 's' : ''} ago`
  return 'just now'
}

export function truncateText(value: string, maxLength: number, options: { ellipsis?: string } = {}): string {
  const ellipsis = options.ellipsis ?? '...'
  if (value.length <= maxLength) return value
  return value.slice(0, maxLength - ellipsis.length) + ellipsis
}
