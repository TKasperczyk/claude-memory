import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import TypeBadge from '@/components/TypeBadge'
import { getMemorySummary } from '@/lib/memory-ui'
import type {
  ChatToolName,
  ChatToolResult,
  ChatSearchResult,
  ChatUpdateResult,
  ChatDeleteResult,
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
  return typeof result === 'object' && result !== null && 'results' in result
}

function isUpdateResult(result: ChatToolResult): result is ChatUpdateResult {
  return typeof result === 'object' && result !== null && 'updates' in result
}

function isDeleteResult(result: ChatToolResult): result is ChatDeleteResult {
  return typeof result === 'object' && result !== null && 'deleted' in result
}

function isErrorResult(result: ChatToolResult): result is { error: string } {
  return typeof result === 'object'
    && result !== null
    && 'error' in result
    && !('results' in result)
    && !('updates' in result)
    && !('deleted' in result)
}

function renderSearchResultEntry(entry: SearchResult) {
  const summary = getMemorySummary(entry.record)
  return (
    <div key={entry.record.id} className="rounded-lg border border-border/60 bg-background/70 p-3 space-y-1">
      <div className="flex items-center gap-2">
        <TypeBadge type={entry.record.type} />
        <span className="text-sm font-medium text-foreground/90">{summary}</span>
      </div>
      <div className="text-[11px] text-muted-foreground/80 font-mono truncate">{entry.record.id}</div>
      <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
        <span>Similarity {formatPercent(entry.similarity)}</span>
        <span>Score {entry.score.toFixed(3)}</span>
        {entry.keywordMatch && <span className="text-warning">Keyword match</span>}
      </div>
    </div>
  )
}

export default function ToolResultCard({ tool, result }: ToolResultCardProps) {
  if (isErrorResult(result)) {
    return (
      <Card className="border-destructive/30 bg-destructive/5">
        <CardContent className="p-3 text-sm text-destructive">
          {result.error}
        </CardContent>
      </Card>
    )
  }

  if (tool === 'search_memories' && isSearchResult(result)) {
    return (
      <Card>
        <CardContent className="p-3 space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Search results</div>
            <Badge variant="secondary" className="text-xs">{result.count}</Badge>
          </div>
          {result.results.length === 0 ? (
            <div className="text-sm text-muted-foreground">No matches found.</div>
          ) : (
            <div className="space-y-2">
              {result.results.map(renderSearchResultEntry)}
            </div>
          )}
        </CardContent>
      </Card>
    )
  }

  if (tool === 'update_memory' && isUpdateResult(result)) {
    const updateEntries = Object.entries(result.updates)
    return (
      <Card>
        <CardContent className="p-3 space-y-3">
          <div className="flex items-center gap-2">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Update</div>
            <Badge variant={result.success ? 'secondary' : 'destructive'} className="text-xs">
              {result.success ? 'Success' : 'Failed'}
            </Badge>
          </div>
          <div className="text-xs text-muted-foreground font-mono">{result.id}</div>
          {updateEntries.length > 0 && (
            <div className="text-sm text-foreground/80">
              {updateEntries.map(([key, value]) => (
                <div key={key}>
                  <span className="text-muted-foreground">{key}:</span> {String(value)}
                </div>
              ))}
            </div>
          )}
          {result.record && (
            <div className="text-sm text-foreground/90">
              {getMemorySummary(result.record)}
            </div>
          )}
          {result.error && (
            <div className="text-sm text-destructive">{result.error}</div>
          )}
        </CardContent>
      </Card>
    )
  }

  if (tool === 'delete_memories' && isDeleteResult(result)) {
    return (
      <Card>
        <CardContent className="p-3 space-y-2">
          <div className="flex items-center gap-2">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Delete</div>
            <Badge variant="secondary" className="text-xs">{result.deleted} deleted</Badge>
          </div>
          {result.missing.length > 0 && (
            <div className="text-xs text-muted-foreground">
              Missing: {result.missing.join(', ')}
            </div>
          )}
          {result.error && (
            <div className="text-sm text-destructive">{result.error}</div>
          )}
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardContent className="p-3 text-sm text-muted-foreground">
        Tool result received.
      </CardContent>
    </Card>
  )
}
