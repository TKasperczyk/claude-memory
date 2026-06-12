export const EXTRACTION_TIMING_STAGES = ['parse', 'slice', 'llm', 'embed', 'store'] as const

export type ExtractionTimingStage = typeof EXTRACTION_TIMING_STAGES[number]

type TimingMap = Partial<Record<string, number>>

function orderedStages(extraStages: readonly string[] = []): string[] {
  return [...EXTRACTION_TIMING_STAGES, ...extraStages]
}

export function formatStageTimings(
  timings: TimingMap | undefined,
  options: { extraStages?: readonly string[]; leadingSpace?: boolean } = {}
): string {
  if (!timings) return ''
  const stages = orderedStages(options.extraStages)
    .map(stage => {
      const value = timings[stage]
      return typeof value === 'number' && Number.isFinite(value)
        ? `${stage}:${Math.max(0, Math.trunc(value))}ms`
        : null
    })
    .filter((entry): entry is string => Boolean(entry))
  if (stages.length === 0) return ''
  const token = `stages=${stages.join(',')}`
  return options.leadingSpace ? ` ${token}` : token
}

export function sumStageTimings(
  timings: TimingMap | undefined,
  options: { extraStages?: readonly string[] } = {}
): number {
  if (!timings) return 0
  return orderedStages(options.extraStages).reduce((sum, stage) => {
    const value = timings[stage]
    return typeof value === 'number' && Number.isFinite(value)
      ? sum + Math.max(0, Math.trunc(value))
      : sum
  }, 0)
}
