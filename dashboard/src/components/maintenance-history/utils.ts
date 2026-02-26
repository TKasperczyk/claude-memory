import { TIME_FILTERS as EXTRACTION_TIME_FILTERS } from '@/components/extractions/utils'
import { ACTION_STYLES } from '@/components/maintenance/shared'
import type { MaintenanceRun, MaintenanceTrigger } from '@/lib/api'

const DAY_MS = 24 * 60 * 60 * 1000

export const TIME_FILTERS = EXTRACTION_TIME_FILTERS

export type TimeFilterKey = typeof TIME_FILTERS[number]['key']

export function triggerLabel(trigger: MaintenanceTrigger): string {
  switch (trigger) {
    case 'cli':
      return 'CLI'
    case 'dashboard':
      return 'Dashboard'
    case 'auto':
      return 'Auto'
    default:
      return trigger
  }
}

export function triggerColor(trigger: MaintenanceTrigger): string {
  switch (trigger) {
    case 'cli':
      return 'bg-blue-500/15 text-blue-700 dark:text-blue-300'
    case 'dashboard':
      return 'bg-purple-500/15 text-purple-700 dark:text-purple-300'
    case 'auto':
      return 'bg-green-500/15 text-green-700 dark:text-green-300'
    default:
      return 'bg-muted-foreground/15 text-muted-foreground'
  }
}

export { ACTION_STYLES }

export function groupRunsByDate(runs: MaintenanceRun[]): Array<{ name: 'Today' | 'Yesterday' | 'Older'; runs: MaintenanceRun[] }> {
  const now = Date.now()
  const todayStart = new Date(now)
  todayStart.setHours(0, 0, 0, 0)
  const todayMs = todayStart.getTime()
  const yesterdayMs = todayMs - DAY_MS

  const groups: Record<'Today' | 'Yesterday' | 'Older', MaintenanceRun[]> = {
    Today: [],
    Yesterday: [],
    Older: []
  }

  for (const run of runs) {
    if (run.timestamp >= todayMs) {
      groups.Today.push(run)
      continue
    }
    if (run.timestamp >= yesterdayMs) {
      groups.Yesterday.push(run)
      continue
    }
    groups.Older.push(run)
  }

  const orderedGroups: Array<{ name: 'Today' | 'Yesterday' | 'Older'; runs: MaintenanceRun[] }> = [
    { name: 'Today', runs: groups.Today },
    { name: 'Yesterday', runs: groups.Yesterday },
    { name: 'Older', runs: groups.Older }
  ]

  return orderedGroups.filter(group => group.runs.length > 0)
}
