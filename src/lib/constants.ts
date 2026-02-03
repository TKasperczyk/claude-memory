// Similarity thresholds - defaults that can be overridden via settings.
export const SIMILARITY_THRESHOLDS = {
  /** Threshold for deduplication during extraction (insert vs update). */
  EXTRACTION_DEDUP: 0.85,
  /** Threshold for consolidation/merge in maintenance. */
  CONSOLIDATION: 0.85,
  /** Threshold for finding similar memories in review (broader search). */
  REVIEW_SIMILAR: 0.5,
  /** Threshold to flag as potential duplicate in review. */
  REVIEW_DUPLICATE_WARNING: 0.8
} as const
