import { useState } from 'react'
import { Play } from 'lucide-react'
import { PageHeader } from '@/App'
import MemoryDetail from '@/components/MemoryDetail'
import { previewContext, type MemoryRecord, type PreviewResponse } from '@/lib/api'

const TYPE_COLORS: Record<string, string> = {
  command: '#2dd4bf',
  error: '#f43f5e',
  discovery: '#60a5fa',
  procedure: '#a78bfa',
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function highlightContext(str: string): string {
  let out = escapeHtml(str)
  out = out.replace(
    /(&lt;\/?prior-knowledge&gt;)/g,
    '<span class="text-type-discovery">$1</span>'
  )
  out = out.replace(
    /(command:|error:|discovery:|procedure:|resolution:|cause:|outcome:|exit:|steps:|verify:|where:|confidence:)/g,
    '<span class="text-muted-foreground">$1</span>'
  )
  return out
}

function getSummary(record: MemoryRecord): string {
  switch (record.type) {
    case 'command': return record.command
    case 'error': return record.errorText
    case 'discovery': return record.what
    case 'procedure': return record.name
  }
}

export default function ContextPreview() {
  const [prompt, setPrompt] = useState('')
  const [cwd, setCwd] = useState('')
  const [result, setResult] = useState<PreviewResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<MemoryRecord | null>(null)

  const handlePreview = async () => {
    const trimmed = prompt.trim()
    setResult(null)
    if (!trimmed) {
      setError('Enter a prompt to preview')
      return
    }

    setLoading(true)
    setError(null)
    try {
      const response = await previewContext({ prompt: trimmed, cwd: cwd.trim() || undefined })
      setResult(response)
    } catch (err) {
      setError((err as Error).message || 'Failed to preview context')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Simulator"
        description="Test what memories would be injected for a given prompt"
      />

      {/* Input form */}
      <div className="p-6 rounded-lg border border-border bg-card space-y-4">
        <div>
          <label className="block text-xs text-muted-foreground mb-1.5">Prompt</label>
          <textarea
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            rows={5}
            placeholder="Enter a prompt to test memory injection…"
            className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm placeholder:text-muted-foreground resize-none focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>

        <div className="flex items-end gap-4">
          <div className="flex-1">
            <label className="block text-xs text-muted-foreground mb-1.5">
              Working directory (optional)
            </label>
            <input
              type="text"
              value={cwd}
              onChange={e => setCwd(e.target.value)}
              placeholder="/home/user/project"
              className="w-full h-9 px-3 rounded-md border border-border bg-background text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <button
            onClick={handlePreview}
            disabled={loading}
            className="flex items-center gap-2 h-9 px-4 rounded-md bg-foreground text-background text-sm font-medium disabled:opacity-50 hover:bg-foreground/90 transition-base"
          >
            <Play className="w-4 h-4" />
            {loading ? 'Running…' : 'Preview'}
          </button>
        </div>

        {error && (
          <div className="text-sm text-destructive">{error}</div>
        )}
      </div>

      {/* Results */}
      {result && (
        <div className="grid lg:grid-cols-2 gap-6">
          {/* Left column: Signals & Matches */}
          <div className="space-y-6">
            {/* Signals */}
            <div className="p-6 rounded-lg border border-border bg-card">
              <h3 className="text-sm font-medium mb-4">Extracted signals</h3>
              <div className="space-y-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Project</span>
                  <span>{result.signals.projectName ?? '—'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Domain</span>
                  <span>{result.signals.domain ?? '—'}</span>
                </div>
                {result.signals.errors.length > 0 && (
                  <div>
                    <span className="text-muted-foreground">Errors</span>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {result.signals.errors.map((e, i) => (
                        <span key={i} className="px-2 py-0.5 rounded text-xs bg-type-error/20 text-type-error">
                          {e}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {result.signals.commands.length > 0 && (
                  <div>
                    <span className="text-muted-foreground">Commands</span>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {result.signals.commands.map((c, i) => (
                        <span key={i} className="px-2 py-0.5 rounded text-xs bg-type-command/20 text-type-command">
                          {c}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Matches */}
            <div className="p-6 rounded-lg border border-border bg-card">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-medium">Search results</h3>
                <span className="text-xs text-muted-foreground">{result.results.length} matches</span>
              </div>
              {result.results.length === 0 ? (
                <p className="text-sm text-muted-foreground">No matches found</p>
              ) : (
                <div className="space-y-2">
                  {result.results.map(match => (
                    <button
                      key={match.record.id}
                      onClick={() => setSelected(match.record)}
                      className="w-full text-left p-3 rounded-md bg-secondary/50 text-sm hover:bg-secondary transition-base"
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span
                          className="w-2 h-2 rounded-full"
                          style={{ backgroundColor: TYPE_COLORS[match.record.type] }}
                        />
                        <span className="text-xs text-muted-foreground">
                          Score {match.score.toFixed(2)} · Sim {match.similarity.toFixed(2)}
                        </span>
                      </div>
                      <div className="truncate">{getSummary(match.record)}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Right column: Injected context */}
          <div className="space-y-6">
            <div className="p-6 rounded-lg border border-border bg-card">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-medium">Injected context</h3>
                <span className="text-xs text-muted-foreground">
                  {result.injectedRecords.length} memories
                </span>
              </div>
              {result.context ? (
                <pre
                  className="p-4 rounded-md bg-secondary text-xs font-mono overflow-x-auto max-h-[400px]"
                  dangerouslySetInnerHTML={{ __html: highlightContext(result.context) }}
                />
              ) : (
                <p className="text-sm text-muted-foreground">No context would be injected</p>
              )}
            </div>

            {result.injectedRecords.length > 0 && (
              <div className="p-6 rounded-lg border border-border bg-card">
                <h3 className="text-sm font-medium mb-4">Injected memories</h3>
                <div className="space-y-2">
                  {result.injectedRecords.map(record => (
                    <button
                      key={record.id}
                      onClick={() => setSelected(record)}
                      className="w-full text-left flex items-start gap-2 text-sm p-2 -mx-2 rounded hover:bg-secondary/50 transition-base"
                    >
                      <span
                        className="w-2 h-2 rounded-full mt-1.5 shrink-0"
                        style={{ backgroundColor: TYPE_COLORS[record.type] }}
                      />
                      <div className="min-w-0">
                        <div className="truncate">{getSummary(record)}</div>
                        <div className="text-xs text-muted-foreground">
                          {record.project ?? '—'} · {record.domain ?? '—'}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <MemoryDetail record={selected} onClose={() => setSelected(null)} />
    </div>
  )
}
