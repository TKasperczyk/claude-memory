import type {
  ConflictVerdict,
  MaintenanceAction,
  MaintenanceActionType,
  MaintenanceOperationInfo,
  MaintenanceReview,
  OperationResult
} from '@/lib/api'

export type MaintenanceOperation = MaintenanceOperationInfo['key']

export type ApplyStatus = { state: 'loading' | 'success' | 'error'; message?: string }

export type SettingsRecommendationItem = MaintenanceReview['settingsRecommendations'][number]

export type ConflictStatus = 'kept' | 'deprecated'

export const ACTION_STYLES: Record<MaintenanceActionType, { badge: string; dot: string; label: string }> = {
  deprecate: {
    badge: 'bg-destructive/15 text-destructive',
    dot: 'bg-destructive',
    label: 'Deprecate'
  },
  update: {
    badge: 'bg-info/15 text-info',
    dot: 'bg-info',
    label: 'Update'
  },
  merge: {
    badge: 'bg-primary/15 text-primary',
    dot: 'bg-primary',
    label: 'Merge'
  },
  promote: {
    badge: 'bg-success/15 text-success',
    dot: 'bg-success',
    label: 'Promote'
  },
  suggestion: {
    badge: 'bg-warning/15 text-warning',
    dot: 'bg-warning',
    label: 'Suggestion'
  }
}

export const RATING_STYLES: Record<MaintenanceReview['overallRating'], { badge: string; label: string }> = {
  good: {
    badge: 'bg-success/15 text-success',
    label: 'Good'
  },
  mixed: {
    badge: 'bg-warning/15 text-warning',
    label: 'Mixed'
  },
  poor: {
    badge: 'bg-destructive/15 text-destructive',
    label: 'Poor'
  }
}

export const VERDICT_STYLES: Record<MaintenanceReview['actionVerdicts'][number]['verdict'], { badge: string; label: string }> = {
  correct: {
    badge: 'bg-success/15 text-success',
    label: 'Correct'
  },
  questionable: {
    badge: 'bg-warning/15 text-warning',
    label: 'Questionable'
  },
  incorrect: {
    badge: 'bg-destructive/15 text-destructive',
    label: 'Incorrect'
  }
}

export const SETTINGS_RECOMMENDATION_STYLES: Record<
  MaintenanceReview['settingsRecommendations'][number]['recommendation'],
  { badge: string; label: string }
> = {
  too_aggressive: {
    badge: 'bg-warning/15 text-warning',
    label: 'Too aggressive'
  },
  too_lenient: {
    badge: 'bg-destructive/15 text-destructive',
    label: 'Too lenient'
  },
  appropriate: {
    badge: 'bg-success/15 text-success',
    label: 'Appropriate'
  }
}

export const CONFLICT_STYLES: Record<ConflictVerdict, { badge: string; label: string; ring: string; background: string }> = {
  supersedes: {
    badge: 'bg-success/15 text-success',
    label: 'Supersedes',
    ring: 'ring-success/30',
    background: 'bg-success/5'
  },
  variant: {
    badge: 'bg-info/15 text-info',
    label: 'Variant',
    ring: 'ring-info/30',
    background: 'bg-info/5'
  },
  hallucination: {
    badge: 'bg-destructive/15 text-destructive',
    label: 'Hallucination',
    ring: 'ring-destructive/30',
    background: 'bg-destructive/5'
  }
}

export const CONFLICT_STATUS_STYLES: Record<ConflictStatus, string> = {
  kept: 'bg-success/15 text-success',
  deprecated: 'bg-destructive/15 text-destructive'
}

export function getConflictVerdict(details?: MaintenanceAction['details']): ConflictVerdict | null {
  const verdict = details?.verdict
  if (verdict === 'supersedes' || verdict === 'variant' || verdict === 'hallucination') {
    return verdict
  }
  return null
}

export function formatSummaryKey(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]/g, ' ')
    .toLowerCase()
}

export function buildActionKey(operation: MaintenanceOperation, action: MaintenanceAction, index: number): string {
  const targetFile = typeof action.details?.targetFile === 'string' ? action.details?.targetFile : ''
  const actionType = typeof action.details?.action === 'string' ? action.details?.action : ''
  return `${operation}:${action.recordId ?? 'unknown'}:${actionType}:${targetFile}:${index}`
}

export function buildSettingsRecommendationKey(
  operation: MaintenanceOperation,
  recommendation: SettingsRecommendationItem,
  index: number
): string {
  const suggestedValue = recommendation.suggestedValue === undefined ? 'none' : String(recommendation.suggestedValue)
  return `${operation}:${recommendation.setting}:${suggestedValue}:${index}`
}

function simpleHash(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash
  }
  return Math.abs(hash).toString(16).padStart(8, '0')
}

export async function buildResultId(result: OperationResult): Promise<string> {
  const actionIds = result.actions.map(action => action.recordId).filter(Boolean).join(',')
  const candidateIds = result.candidates
    .map(group => {
      const recordIds = group.records.map(record => record.id).filter(Boolean).join(',')
      return `${group.id}:${recordIds}`
    })
    .join('|')
  const payload = [
    result.operation,
    String(result.dryRun),
    JSON.stringify(result.summary),
    actionIds,
    candidateIds
  ].join('|')

  if (crypto.subtle) {
    const data = new TextEncoder().encode(payload)
    const hashBuffer = await crypto.subtle.digest('SHA-256', data)
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    return hashArray.map(byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 16)
  }

  return simpleHash(payload).slice(0, 16)
}

export function getSuggestionPayload(action: MaintenanceAction): {
  recordId: string
  action: 'new' | 'edit'
  targetFile: string
  diff: string
} | null {
  const details = action.details
  if (!details || typeof details !== 'object') return null
  if (!action.recordId || typeof action.recordId !== 'string') return null
  if (details.action !== 'new' && details.action !== 'edit') return null
  if (typeof details.targetFile !== 'string' || details.targetFile.trim().length === 0) return null
  if (typeof details.diff !== 'string' || details.diff.trim().length === 0) return null

  return {
    recordId: action.recordId,
    action: details.action,
    targetFile: details.targetFile,
    diff: details.diff
  }
}

export function getDiffStats(diff: string): { addedLines: number; deletedLines: number; hasHunk: boolean } {
  const lines = diff.replace(/\r\n/g, '\n').split('\n')
  let inHunk = false
  let hasHunk = false
  let addedLines = 0
  let deletedLines = 0

  for (const line of lines) {
    if (line.startsWith('@@')) {
      inHunk = true
      hasHunk = true
      continue
    }
    if (!inHunk) continue
    if (line.startsWith('+++ ') || line.startsWith('--- ') || line.startsWith('diff ')) continue

    if (line.startsWith('+')) {
      addedLines += 1
      continue
    }
    if (line.startsWith('-')) {
      deletedLines += 1
    }
  }

  return { addedLines, deletedLines, hasHunk }
}
