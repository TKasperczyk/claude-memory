import type { ExtractionReview, ExtractionReviewIssue } from '@/lib/api'

export const RATING_STYLES: Record<ExtractionReview['overallRating'], { badge: string; label: string }> = {
  good: {
    badge: 'bg-success/15 text-success',
    label: 'Good'
  },
  mixed: {
    badge: 'bg-foreground/10 text-foreground/70',
    label: 'Mixed'
  },
  poor: {
    badge: 'bg-muted-foreground/15 text-muted-foreground',
    label: 'Poor'
  }
}

export const SEVERITY_STYLES: Record<ExtractionReviewIssue['severity'], string> = {
  critical: 'bg-destructive/15 text-destructive',
  major: 'bg-warning/15 text-warning',
  minor: 'bg-muted-foreground/15 text-muted-foreground'
}

export const ISSUE_LABELS: Record<ExtractionReviewIssue['type'], string> = {
  inaccurate: 'Inaccurate',
  partial: 'Partial',
  hallucinated: 'Hallucinated',
  missed: 'Missed',
  duplicate: 'Duplicate'
}

export const TIME_FILTERS = [
  { key: 'all', label: 'All time', ms: Number.POSITIVE_INFINITY },
  { key: '12h', label: '12h', ms: 12 * 60 * 60 * 1000 },
  { key: '24h', label: '24h', ms: 24 * 60 * 60 * 1000 },
  { key: '7d', label: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
  { key: '30d', label: '30d', ms: 30 * 24 * 60 * 60 * 1000 }
] as const

export type TimeFilterKey = typeof TIME_FILTERS[number]['key']

export function truncateSessionId(sessionId: string): string {
  if (sessionId.length <= 10) return sessionId
  return `${sessionId.slice(0, 10)}...`
}

/**
 * Extract project name from transcript path.
 * Path format: /home/user/.claude/projects/-home-user-Programming-project-name/session.jsonl
 * The project directory is encoded with dashes replacing path separators.
 */
export function extractProjectFromPath(transcriptPath: string | undefined): string {
  if (!transcriptPath) return 'Unknown'

  // Split path and find the projects directory segment
  const parts = transcriptPath.split(/[\\/]/)
  const projectsIdx = parts.findIndex(p => p === 'projects')
  if (projectsIdx === -1 || projectsIdx >= parts.length - 1) return 'Unknown'

  // Get the encoded project directory (e.g., "-home-user-Programming-project-name")
  const encodedDir = parts[projectsIdx + 1]
  if (!encodedDir || encodedDir.startsWith('.')) return 'Unknown'

  // Split by dash and filter common path segments to find the project name
  const segments = encodedDir.split('-').filter(Boolean)
  const commonPrefixes = ['home', 'users', 'programming', 'projects', 'code', 'dev', 'src', 'work']

  // Filter out all common prefixes and user-like segments (single short words at the start)
  const projectParts: string[] = []
  let foundProject = false
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i].toLowerCase()
    if (commonPrefixes.includes(seg)) {
      // Stop when we hit a common path segment from the end
      break
    }
    projectParts.unshift(segments[i])
    foundProject = true
  }

  if (!foundProject || projectParts.length === 0) {
    // Fallback: just use the last segment
    return segments[segments.length - 1] || 'Unknown'
  }

  return projectParts.join('-')
}

export function getAccuracyBadge(
  score: number | null | undefined
): { badge: string; text: string; label: string; title: string } {
  if (typeof score !== 'number') {
    return {
      badge: 'bg-muted-foreground/15 text-muted-foreground',
      text: 'text-muted-foreground',
      label: '—',
      title: 'Accuracy unavailable'
    }
  }

  const label = String(score)
  const title = `Accuracy score ${score}/100`

  if (score >= 85) {
    return { badge: 'bg-success/15 text-success', text: 'text-success', label, title }
  }
  if (score >= 60) {
    return { badge: 'bg-warning/15 text-warning', text: 'text-warning', label, title }
  }
  return { badge: 'bg-destructive/15 text-destructive', text: 'text-destructive', label, title }
}
