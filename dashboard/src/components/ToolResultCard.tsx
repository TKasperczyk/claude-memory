import { Search, Pencil, Trash2, AlertCircle, List, FileText, Plus } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import TypeBadge from '@/components/TypeBadge'
import { formatRelativeTimeShort } from '@/lib/format'
import { getMemorySummary } from '@/lib/memory-ui'
import type {
  ChatToolName,
  ChatToolResult,
  ChatSearchResult,
  ChatCreateResult,
  ChatUpdateResult,
  ChatDeleteResult,
  ChatListExtractionsResult,
  ChatGetExtractionResult,
  SearchResult
} from '@/lib/api'

interface ToolResultCardProps {
  tool: ChatToolName
  result: ChatToolResult
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function isSearchResult(result: ChatToolResult): result is ChatSearchResult {
  return typeof result === 'object' && result !== null && 'results' in result && 'query' in result
}

function isCreateResult(result: ChatToolResult): result is ChatCreateResult {
  return typeof result === 'object' && result !== null && 'record' in result && 'success' in result && !('updates' in result)
}

function isUpdateResult(result: ChatToolResult): result is ChatUpdateResult {
  return typeof result === 'object' && result !== null && 'updates' in result
}

function isDeleteResult(result: ChatToolResult): result is ChatDeleteResult {
  return typeof result === 'object' && result !== null && 'deleted' in result
}

function isListExtractionsResult(result: ChatToolResult): result is ChatListExtractionsResult {
  return typeof result === 'object' && result !== null && 'runs' in result && 'total' in result
}

function isGetExtractionResult(result: ChatToolResult): result is ChatGetExtractionResult {
  return typeof result === 'object' && result !== null && 'run' in result && !('runs' in result)
}

function isErrorResult(result: ChatToolResult): result is { error: string } {
  return typeof result === 'object'
    && result !== null
    && 'error' in result
    && !('results' in result)
    && !('updates' in result)
    && !('deleted' in result)
    && !('run' in result)
    && !('runs' in result)
    && !('record' in result)
}

function renderSearchResultEntry(entry: SearchResult, index: number) {
  const summary = getMemorySummary(entry.record)
  return (
    <div
      key={entry.record.id}
      className="group rounded-lg border border-border/50 bg-secondary/30 p-3 space-y-2 hover:bg-secondary/50 transition-colors"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[10px] font-mono text-muted-foreground/50 w-4 shrink-0">{index + 1}</span>
          <TypeBadge type={entry.record.type} />
          <span className="text-sm text-foreground/90 truncate">{summary}</span>
        </div>
        <Badge variant="outline" className="text-[10px] font-mono shrink-0">
          {formatPercent(entry.similarity)}
        </Badge>
      </div>
      <div className="pl-4 flex items-center gap-3 text-[11px] text-muted-foreground/60">
        <code className="truncate">{entry.record.id}</code>
        {entry.keywordMatch && (
          <span className="px-1.5 py-0.5 rounded bg-warning/10 text-warning text-[10px]">keyword</span>
        )}
      </div>
    </div>
  )
}

export default function ToolResultCard({ tool, result }: ToolResultCardProps) {
  if (isErrorResult(result)) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
        <div className="flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
          <span className="text-sm text-destructive">{result.error}</span>
        </div>
      </div>
    )
  }

  if (tool === 'search_memories' && isSearchResult(result)) {
    return (
      <div className="rounded-lg border border-border/50 bg-card/50 overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2 bg-secondary/30 border-b border-border/50">
          <div className="flex items-center gap-2">
            <Search className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-xs font-medium text-muted-foreground">Search Results</span>
          </div>
          <Badge variant="secondary" className="text-[10px] font-mono">{result.count} found</Badge>
        </div>
        <div className="p-3">
          {result.results.length === 0 ? (
            <div className="text-sm text-muted-foreground/60 italic text-center py-2">No matches found</div>
          ) : (
            <div className="space-y-2">
              {result.results.map((entry, index) => renderSearchResultEntry(entry, index))}
            </div>
          )}
        </div>
      </div>
    )
  }

  if (tool === 'update_memory' && isUpdateResult(result)) {
    const updateEntries = Object.entries(result.updates)
    return (
      <div className="rounded-lg border border-border/50 bg-card/50 overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2 bg-secondary/30 border-b border-border/50">
          <div className="flex items-center gap-2">
            <Pencil className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-xs font-medium text-muted-foreground">Update Memory</span>
          </div>
          <Badge
            variant={result.success ? 'secondary' : 'destructive'}
            className={`text-[10px] font-mono ${result.success ? 'bg-success/10 text-success border-success/20' : ''}`}
          >
            {result.success ? 'success' : 'failed'}
          </Badge>
        </div>
        <div className="p-3 space-y-2">
          <code className="text-[11px] text-muted-foreground/70 block truncate">{result.id}</code>
          {updateEntries.length > 0 && (
            <div className="space-y-1">
              {updateEntries.map(([key, value]) => (
                <div key={key} className="text-sm">
                  <span className="text-muted-foreground/70">{key}:</span>{' '}
                  <span className="text-foreground/80">{String(value)}</span>
                </div>
              ))}
            </div>
          )}
          {result.record && (
            <div className="text-sm text-foreground/80 pt-1 border-t border-border/30">
              {getMemorySummary(result.record)}
            </div>
          )}
          {result.error && (
            <div className="text-sm text-destructive">{result.error}</div>
          )}
        </div>
      </div>
    )
  }

  if (tool === 'create_memory' && isCreateResult(result)) {
    return (
      <div className="rounded-lg border border-border/50 bg-card/50 overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2 bg-secondary/30 border-b border-border/50">
          <div className="flex items-center gap-2">
            <Plus className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-xs font-medium text-muted-foreground">Create Memory</span>
          </div>
          <Badge
            variant={result.success ? 'secondary' : 'destructive'}
            className={`text-[10px] font-mono ${result.success ? 'bg-success/10 text-success border-success/20' : ''}`}
          >
            {result.success ? 'created' : 'failed'}
          </Badge>
        </div>
        <div className="p-3 space-y-1">
          <div className="flex items-center gap-2">
            <TypeBadge type={result.record.type} />
            <span className="text-sm text-foreground/80">{getMemorySummary(result.record)}</span>
          </div>
          <code className="text-[11px] text-muted-foreground/70 block truncate">{result.id}</code>
          {result.error && <div className="text-sm text-destructive">{result.error}</div>}
        </div>
      </div>
    )
  }

  if (tool === 'delete_memories' && isDeleteResult(result)) {
    return (
      <div className="rounded-lg border border-border/50 bg-card/50 overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2 bg-secondary/30 border-b border-border/50">
          <div className="flex items-center gap-2">
            <Trash2 className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-xs font-medium text-muted-foreground">Delete Memories</span>
          </div>
          <Badge variant="secondary" className="text-[10px] font-mono bg-destructive/10 text-destructive border-destructive/20">
            {result.deleted} deleted
          </Badge>
        </div>
        {(result.missing.length > 0 || result.error) && (
          <div className="p-3 space-y-2">
            {result.missing.length > 0 && (
              <div className="text-xs text-muted-foreground/70">
                <span className="text-muted-foreground/50">Missing:</span> {result.missing.join(', ')}
              </div>
            )}
            {result.error && (
              <div className="text-sm text-destructive">{result.error}</div>
            )}
          </div>
        )}
      </div>
    )
  }

  if (tool === 'list_extractions' && isListExtractionsResult(result)) {
    return (
      <div className="rounded-lg border border-border/50 bg-card/50 overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2 bg-secondary/30 border-b border-border/50">
          <div className="flex items-center gap-2">
            <List className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-xs font-medium text-muted-foreground">Extraction Runs</span>
          </div>
          <Badge variant="secondary" className="text-[10px] font-mono">{result.count} of {result.total}</Badge>
        </div>
        <div className="p-3">
          {result.runs.length === 0 ? (
            <div className="text-sm text-muted-foreground/60 italic text-center py-2">No extraction runs found</div>
          ) : (
            <div className="space-y-2">
              {result.runs.map(run => (
                <div key={run.runId} className="rounded-lg border border-border/50 bg-secondary/30 p-2.5 space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <code className="text-[11px] font-mono text-muted-foreground truncate">{run.runId.slice(0, 8)}...</code>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-[10px] font-mono">{run.recordCount} records</Badge>
                      <span className="text-[10px] text-muted-foreground">{formatRelativeTimeShort(run.timestamp)}</span>
                    </div>
                  </div>
                  {run.firstPrompt && (
                    <div className="text-xs text-foreground/70 truncate">{run.firstPrompt}</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    )
  }

  if (tool === 'get_extraction' && isGetExtractionResult(result)) {
    const { run, records, review } = result
    return (
      <div className="rounded-lg border border-border/50 bg-card/50 overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2 bg-secondary/30 border-b border-border/50">
          <div className="flex items-center gap-2">
            <FileText className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-xs font-medium text-muted-foreground">Extraction Detail</span>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-[10px] font-mono">{run.recordCount} records</Badge>
            {review && (
              <Badge
                variant="secondary"
                className={`text-[10px] font-mono ${review.overallRating === 'good' ? 'bg-success/10 text-success' : review.overallRating === 'poor' ? 'bg-destructive/10 text-destructive' : 'bg-warning/10 text-warning'}`}
              >
                {review.overallRating} ({Math.round(review.accuracyScore * 100)}%)
              </Badge>
            )}
          </div>
        </div>
        <div className="p-3 space-y-3">
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>Run: <code className="font-mono">{run.runId.slice(0, 8)}...</code></span>
            <span>Session: <code className="font-mono">{run.sessionId.slice(0, 8)}...</code></span>
            <span>{formatRelativeTimeShort(run.timestamp)}</span>
          </div>
          {records && records.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground/60">Extracted records</div>
              {records.map(record => (
                <div key={record.id} className="flex items-center gap-2 text-xs">
                  <TypeBadge type={record.type} />
                  <span className="text-foreground/80 truncate">{getMemorySummary(record)}</span>
                </div>
              ))}
            </div>
          )}
          {review && review.issues.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground/60">Review issues ({review.issues.length})</div>
              {review.issues.map((issue, i) => (
                <div key={i} className="text-xs rounded border border-border/30 bg-secondary/20 p-2">
                  <div className="flex items-center gap-2 mb-0.5">
                    <Badge variant={issue.severity === 'critical' ? 'destructive' : 'outline'} className="text-[10px]">
                      {issue.severity}
                    </Badge>
                    <span className="text-muted-foreground">{issue.type}</span>
                  </div>
                  <div className="text-foreground/80">{issue.description}</div>
                </div>
              ))}
            </div>
          )}
          {review === null && (
            <div className="text-xs text-muted-foreground/50 italic">No review available for this extraction.</div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-border/50 bg-card/50 p-3">
      <span className="text-sm text-muted-foreground/60 italic">Tool result received</span>
    </div>
  )
}
