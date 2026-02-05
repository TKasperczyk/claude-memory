import type { MaintenanceAction } from '@/lib/api'
import RecordLink from './RecordLink'
import {
  CONFLICT_STATUS_STYLES,
  CONFLICT_STYLES,
  getConflictVerdict,
  type ConflictStatus
} from './shared'

function StatusBadge({ status }: { status: ConflictStatus }) {
  return (
    <span className={`text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full ${CONFLICT_STATUS_STYLES[status]}`}>
      {status}
    </span>
  )
}

export default function ActionDetails({
  details,
  onSelect
}: {
  details?: MaintenanceAction['details']
  onSelect?: (id: string) => void
}) {
  if (!details) return null

  const before = typeof details.before === 'string' ? details.before : null
  const after = typeof details.after === 'string' ? details.after : null
  const diff = typeof details.diff === 'string' ? details.diff : null
  const targetFile = typeof details.targetFile === 'string' ? details.targetFile : null
  const action = details.action === 'new' || details.action === 'edit' ? details.action : null
  const decisionReason = typeof details.decisionReason === 'string' ? details.decisionReason : null
  const verdict = getConflictVerdict(details)
  const candidateId = typeof details.candidateId === 'string' ? details.candidateId : null
  const existingId = typeof details.existingId === 'string' ? details.existingId : null
  const isCompleteConflict = Boolean(verdict && candidateId && existingId)
  const conflictStyle = isCompleteConflict && verdict ? CONFLICT_STYLES[verdict] : null
  const deprecatedRecords = Array.isArray(details.deprecatedRecords) ? details.deprecatedRecords : null
  const deprecatedIds = Array.isArray(details.deprecatedIds) ? details.deprecatedIds : null
  const keptId = typeof details.keptId === 'string' ? details.keptId : null
  const newerId = typeof details.newerId === 'string' ? details.newerId : null
  const similarity = typeof details.similarity === 'number' ? details.similarity : null
  const hasDeprecatedRecords = Boolean(deprecatedRecords && deprecatedRecords.length > 0)
  const hasDeprecatedIds = Boolean(!hasDeprecatedRecords && deprecatedIds && deprecatedIds.length > 0)

  if (
    !before
    && !after
    && !diff
    && !hasDeprecatedRecords
    && !hasDeprecatedIds
    && !newerId
    && similarity === null
    && !isCompleteConflict
  ) {
    return null
  }

  const diffLines = diff ? diff.split('\n') : []
  let candidateStatus: ConflictStatus | null = null
  let existingStatus: ConflictStatus | null = null
  let outcomeText: string | null = null

  if (verdict === 'supersedes') {
    candidateStatus = 'kept'
    existingStatus = 'deprecated'
    outcomeText = 'Outcome: New replaces existing.'
  } else if (verdict === 'hallucination') {
    candidateStatus = 'deprecated'
    existingStatus = 'kept'
    outcomeText = 'Outcome: Existing kept, new deprecated.'
  } else if (verdict === 'variant') {
    candidateStatus = 'kept'
    existingStatus = 'kept'
    outcomeText = 'Outcome: Keep both.'
  }

  return (
    <div className="mt-2 text-xs text-muted-foreground space-y-2">
      {isCompleteConflict && verdict && conflictStyle && (
        <div className="rounded-md border border-border/60 bg-background/60 px-3 py-2 space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground/70">
            <span>Conflict resolution</span>
            <span className={`text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full ${conflictStyle.badge}`}>
              {conflictStyle.label}
            </span>
          </div>
          <div className="space-y-1 text-[11px] text-muted-foreground/80">
            {candidateId && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">New</span>
                <RecordLink
                  id={candidateId}
                  onSelect={onSelect}
                  stopPropagation
                  className="font-mono text-[11px] text-muted-foreground"
                />
                {candidateStatus && <StatusBadge status={candidateStatus} />}
              </div>
            )}
            {existingId && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">Existing</span>
                <RecordLink
                  id={existingId}
                  onSelect={onSelect}
                  stopPropagation
                  className="font-mono text-[11px] text-muted-foreground"
                />
                {existingStatus && <StatusBadge status={existingStatus} />}
              </div>
            )}
            {outcomeText && (
              <div className="text-[11px] text-muted-foreground/80">{outcomeText}</div>
            )}
          </div>
        </div>
      )}
      {before && after && (
        <>
          <div className="font-mono">before: {before}</div>
          <div className="font-mono">after: {after}</div>
        </>
      )}
      {hasDeprecatedRecords && deprecatedRecords && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground/70">
            <span>Duplicates being merged</span>
            {keptId && (
              <span className="flex items-center gap-1 normal-case text-muted-foreground/60">
                <span aria-hidden="true">&rarr;</span>
                <span className="text-[10px] uppercase tracking-wide">kept</span>
                <RecordLink
                  id={keptId}
                  onSelect={onSelect}
                  stopPropagation
                  className="font-mono text-[11px] text-muted-foreground"
                />
              </span>
            )}
          </div>
          <div className="space-y-2">
            {deprecatedRecords.map(record => (
              <div
                key={record.id}
                className="rounded-md border border-border/60 bg-secondary/30 px-2 py-1.5"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-muted-foreground/50">&rarr;</span>
                  <RecordLink
                    id={record.id}
                    onSelect={onSelect}
                    stopPropagation
                    className="font-mono text-[11px] line-through text-muted-foreground/70"
                  />
                </div>
                {record.snippet && (
                  <div className="mt-1 text-muted-foreground/60">
                    {record.snippet}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      {hasDeprecatedIds && deprecatedIds && (
        <div className="font-mono">merged: {deprecatedIds.join(', ')}</div>
      )}
      {newerId && (
        <div className="font-mono">kept: {newerId}{similarity !== null ? ` (sim ${similarity.toFixed(2)})` : ''}</div>
      )}
      {(action || targetFile) && (
        <div className="flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground/70">
          {action && (
            <span className="rounded-full border border-border/60 px-2 py-0.5 text-[10px] uppercase tracking-wide">
              {action}
            </span>
          )}
          {targetFile && (
            <span className="font-mono normal-case text-muted-foreground">
              {targetFile}
            </span>
          )}
        </div>
      )}
      {decisionReason && (
        <div className="text-[11px] text-muted-foreground/80">Reason: {decisionReason}</div>
      )}
      {diff && (
        <div className="overflow-hidden rounded-md border border-border/60 bg-background/60">
          <div className="max-h-80 overflow-auto text-[11px] font-mono">
            {diffLines.map((line, index) => {
              const content = line || ' '
              let className = 'whitespace-pre px-3 py-0.5 text-muted-foreground/80'
              if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff')) {
                className = 'whitespace-pre px-3 py-0.5 text-muted-foreground'
              } else if (line.startsWith('@@')) {
                className = 'whitespace-pre px-3 py-0.5 text-muted-foreground'
              } else if (line.startsWith('+')) {
                className = 'whitespace-pre px-3 py-0.5 text-success bg-success/10'
              } else if (line.startsWith('-')) {
                className = 'whitespace-pre px-3 py-0.5 text-destructive bg-destructive/10'
              }
              return (
                <div key={`${index}-${line.slice(0, 8)}`} className={className}>
                  {content}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
