export function formatDuration(durationMs: number): string {
  if (!durationMs || durationMs <= 0) return '0ms'
  if (durationMs < 1000) return `${durationMs}ms`
  return `${(durationMs / 1000).toFixed(1)}s`
}

export function formatDateTime(timestamp?: number): string {
  if (!timestamp) return '—'
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp)
}
