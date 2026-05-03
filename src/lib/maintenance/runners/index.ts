export type { MaintenanceRunResult, ProgressCallback } from './types.js'

export {
  runStaleCheck,
  runLowUsageDeprecation,
  runStaleUnusedDeprecation,
  runLowUsageCheck
} from './deprecation-runners.js'

export {
  runQualityDeprecation
} from './quality-deprecation-runner.js'

export {
  runConsolidation,
  runCrossTypeConsolidation
} from './consolidation-runners.js'

export {
  runGlobalPromotion
} from './promotion-runner.js'

export { runRelationDiscovery } from './relations.js'

export { runWarningSynthesis } from './warning-synthesis-runner.js'

export { runPromotionSuggestions } from './promotion-suggestions-runner.js'
