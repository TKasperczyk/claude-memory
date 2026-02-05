import type {
  MaintenanceAction,
  MaintenanceCandidateGroup,
  MaintenanceProgress
} from '../../../../shared/types.js'

export interface MaintenanceRunResult {
  actions: MaintenanceAction[]
  summary: Record<string, number>
  candidates: MaintenanceCandidateGroup[]
  error?: string
}

export type ProgressCallback = (progress: MaintenanceProgress) => void
