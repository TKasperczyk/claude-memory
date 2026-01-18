import ListItem from '@/components/ListItem'
import TypeBadge from '@/components/TypeBadge'
import { type ExclusionReason, type MemoryRecord, type NearMissRecord } from '@/lib/api'
import { getMemorySummary } from '@/lib/memory-ui'

const EXCLUSION_REASON_STYLES: Record<ExclusionReason['reason'], string> = {
  score_below_threshold: 'bg-amber-500/15 text-amber-300',
  semantic_only_score_below_threshold: 'bg-amber-500/15 text-amber-300',
  similarity_below_threshold: 'bg-sky-500/15 text-sky-300',
  mmr_diversity_penalty: 'bg-purple-500/15 text-purple-300',
  exceeded_max_records: 'bg-muted-foreground/15 text-muted-foreground',
  exceeded_token_budget: 'bg-red-500/15 text-red-300'
}

function formatDecimal(value: number, digits = 2): string {
  return value.toFixed(digits)
}

function formatTokenCount(value: number): string {
  return Math.round(value).toLocaleString()
}

function formatShortId(value: string): string {
  if (value.length <= 8) return value
  return `${value.slice(0, 8)}...`
}

function formatExclusionReason(reason: ExclusionReason): string {
  const threshold = formatDecimal(reason.threshold)
  const actual = formatDecimal(reason.actual)
  const gap = formatDecimal(reason.gap)

  switch (reason.reason) {
    case 'score_below_threshold':
      return `Score < ${threshold} (actual: ${actual}, gap: ${gap})`
    case 'semantic_only_score_below_threshold':
      return `Semantic score < ${threshold} (actual: ${actual}, gap: ${gap})`
    case 'similarity_below_threshold':
      return `Similarity < ${threshold} (actual: ${actual}, gap: ${gap})`
    case 'mmr_diversity_penalty': {
      const similarity = reason.similarityScore != null ? formatDecimal(reason.similarityScore) : null
      const similarTo = reason.similarTo ? `to Memory ${formatShortId(reason.similarTo)}` : null
      const similarityDetail = similarity
        ? `, sim: ${similarity}${similarTo ? ` ${similarTo}` : ''}`
        : ''
      return `MMR ${actual} < ${threshold} (gap: ${gap}${similarityDetail})`
    }
    case 'exceeded_max_records': {
      const rank = reason.rank ?? Math.round(reason.actual)
      const limit = Math.round(reason.threshold)
      const overBy = Math.max(0, rank - limit)
      const overByDetail = overBy > 0 ? `, over by ${overBy}` : ''
      return `Rank #${rank} (max: ${limit}${overByDetail})`
    }
    case 'exceeded_token_budget': {
      const projected = reason.projectedTokens ?? reason.actual
      const maxTokens = reason.threshold
      const overBy = Math.max(0, projected - maxTokens)
      const overByDetail = overBy > 0 ? `, over by ${formatTokenCount(overBy)}` : ''
      return `Tokens ${formatTokenCount(projected)} > ${formatTokenCount(maxTokens)}${overByDetail}`
    }
  }
}

export default function NearMissesPanel({
  nearMisses,
  onSelect
}: {
  nearMisses: NearMissRecord[]
  onSelect: (record: MemoryRecord) => void
}) {
  return (
    <div className="p-6 rounded-xl border border-border bg-card">
      <h3 className="section-header mb-4">Near Misses ({nearMisses.length})</h3>
      {nearMisses.length === 0 ? (
        <p className="text-sm text-muted-foreground">No near misses</p>
      ) : (
        <div className="space-y-2">
          {nearMisses.map(miss => {
            const { record, score, similarity } = miss.record
            const summary = getMemorySummary(record)
            return (
              <ListItem key={record.id} onClick={() => onSelect(record)}>
                <div className="flex items-center justify-between gap-3">
                  <TypeBadge type={record.type} />
                  <span className="text-xs text-muted-foreground tabular-nums">
                    Score {formatDecimal(score)} · Sim {formatDecimal(similarity)}
                  </span>
                </div>
                <div className="mt-1 text-sm truncate" title={summary}>
                  {summary}
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {miss.exclusionReasons.map((reason, index) => (
                    <span
                      key={`${record.id}-${index}`}
                      className={`px-2 py-0.5 rounded-full text-[11px] ${EXCLUSION_REASON_STYLES[reason.reason]}`}
                    >
                      {formatExclusionReason(reason)}
                    </span>
                  ))}
                </div>
              </ListItem>
            )
          })}
        </div>
      )}
    </div>
  )
}
