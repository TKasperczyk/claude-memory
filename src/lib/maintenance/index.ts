export type { MaintenanceCandidateGroup, MaintenanceCandidateRecord } from '../../../shared/types.js'

export { GLOBAL_PROMOTION_MIN_CONFIDENCE } from './operations.js'

export type { ContradictionPair } from './conflicts.js'

export {
  findStaleRecords,
  findGlobalCandidates,
  findLowUsageRecords,
  findLowUsageHighRetrieval,
  findStaleUnusedRecords,
  checkValidity
} from './scans.js'

export {
  markDeprecated,
  promoteToGlobal,
  checkGlobalPromotion,
  isConfidenceSufficient,
  runWarningSynthesis
} from './operations.js'

export {
  findSimilarClusters,
  findCrossTypeClusters,
  consolidateCluster,
  resolveMergeGroups,
  pickConsolidationFallback,
  pickCrossTypeFallback,
  llmVerifyConsolidation,
  selectCrossTypeRepresentative
} from './consolidation.js'

export {
  findContradictionPairs,
  checkContradiction,
  runConflictResolution
} from './conflicts.js'
