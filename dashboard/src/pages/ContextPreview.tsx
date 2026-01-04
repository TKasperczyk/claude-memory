import { useState } from 'react'
import TypeBadge from '@/components/TypeBadge'
import { previewContext, type MemoryRecord, type PreviewResponse } from '@/lib/api'

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function highlightContext(value: string): string {
  let output = escapeHtml(value)
  output = output.replace(
    /(&lt;\/?prior-knowledge&gt;)/g,
    '<span class="text-emerald-300 font-semibold">$1</span>'
  )
  output = output.replace(
    /(command:|error:|discovery:|procedure:|resolution:|cause:|outcome:|exit:|steps:|verify:|where:|confidence:)/g,
    '<span class="text-amber-300">$1</span>'
  )
  output = output.replace(/^(- )/gm, '<span class="text-sky-300">$1</span>')
  return output
}

function recordSummary(record: MemoryRecord): string {
  switch (record.type) {
    case 'command':
      return record.command
    case 'error':
      return record.errorText
    case 'discovery':
      return record.what
    case 'procedure':
      return record.name
  }
}

export default function ContextPreview() {
  const [prompt, setPrompt] = useState('')
  const [cwd, setCwd] = useState('')
  const [result, setResult] = useState<PreviewResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handlePreview = async () => {
    const trimmed = prompt.trim()
    setResult(null)
    if (!trimmed) {
      setError('Enter a prompt to preview.')
      return
    }

    setLoading(true)
    setError(null)
    try {
      const response = await previewContext({ prompt: trimmed, cwd: cwd.trim() || undefined })
      setResult(response)
    } catch (err) {
      setError((err as Error).message || 'Failed to preview context.')
      setResult(null)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-6 animate-fade-up">
      <header className="space-y-2">
        <p className="text-xs uppercase tracking-[0.3em] text-amber-300">Context preview</p>
        <h1 className="text-3xl font-semibold text-white">Simulate memory injection.</h1>
        <p className="max-w-2xl text-sm text-slate-400">
          Draft a prompt and see which memories would be pulled into Claude Code before you send it.
        </p>
      </header>

      <div className="grid gap-4 rounded-2xl border border-white/10 bg-[color:var(--panel)] p-4">
        <label className="text-xs uppercase tracking-[0.2em] text-slate-400">
          Prompt
          <textarea
            value={prompt}
            onChange={event => setPrompt(event.target.value)}
            rows={6}
            placeholder="Paste the prompt you want to run through Claude Memory..."
            className="mt-2 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-amber-400 focus:outline-none"
          />
        </label>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <label className="text-xs uppercase tracking-[0.2em] text-slate-400">
            Optional cwd
            <input
              value={cwd}
              onChange={event => setCwd(event.target.value)}
              placeholder="/home/you/project"
              className="mt-2 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-amber-400 focus:outline-none"
            />
          </label>
          <button
            onClick={handlePreview}
            disabled={loading}
            className="rounded-full border border-amber-400/40 bg-amber-400/10 px-6 py-3 text-xs font-semibold uppercase tracking-[0.3em] text-amber-200 transition hover:border-amber-300 hover:text-amber-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? 'Previewing...' : 'Preview'}
          </button>
        </div>
        {error ? (
          <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">
            {error}
          </div>
        ) : null}
      </div>

      {result ? (
        <div className="grid gap-6 xl:grid-cols-[1.1fr_1fr]">
          <div className="space-y-6">
            <div className="rounded-2xl border border-white/10 bg-[color:var(--panel)] p-5">
              <h2 className="text-lg font-semibold text-white">Signals extracted</h2>
              <div className="mt-4 space-y-3 text-sm text-slate-300">
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Project</p>
                  <p className="mt-1">{result.signals.projectName ?? 'unknown'}</p>
                  <p className="text-xs text-slate-500">{result.signals.projectRoot ?? 'N/A'}</p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Domain</p>
                  <p className="mt-1">{result.signals.domain ?? 'unknown'}</p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Errors</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {result.signals.errors.length ? (
                      result.signals.errors.map((errorSignal, index) => (
                        <span
                          key={`error-${index}`}
                          className="rounded-full border border-rose-400/30 bg-rose-400/10 px-3 py-1 text-xs text-rose-200"
                        >
                          {errorSignal}
                        </span>
                      ))
                    ) : (
                      <span className="text-xs text-slate-500">No error signals detected.</span>
                    )}
                  </div>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Commands</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {result.signals.commands.length ? (
                      result.signals.commands.map((commandSignal, index) => (
                        <span
                          key={`cmd-${index}`}
                          className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1 text-xs text-emerald-200"
                        >
                          {commandSignal}
                        </span>
                      ))
                    ) : (
                      <span className="text-xs text-slate-500">No command signals detected.</span>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-[color:var(--panel)] p-5">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold text-white">Matches</h2>
                <p className="text-xs uppercase tracking-[0.2em] text-slate-400">
                  {result.results.length} results
                </p>
              </div>
              <div className="mt-4 space-y-3">
                {result.results.length ? (
                  result.results.map(match => (
                    <div
                      key={match.record.id}
                      className="rounded-xl border border-white/10 bg-white/5 p-4 text-sm text-slate-200"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <TypeBadge type={match.record.type} />
                        <div className="flex gap-4 text-xs text-slate-400">
                          <span>Score {match.score.toFixed(2)}</span>
                          <span>Sim {match.similarity.toFixed(2)}</span>
                          <span>{match.keywordMatch ? 'Keyword match' : 'Vector match'}</span>
                        </div>
                      </div>
                      <p className="mt-3 text-sm text-slate-100">{recordSummary(match.record)}</p>
                      <p className="mt-1 text-xs text-slate-500">
                        {match.record.project ?? 'unknown'} | {match.record.domain ?? 'unknown'}
                      </p>
                    </div>
                  ))
                ) : (
                  <div className="rounded-xl border border-white/10 bg-white/5 p-6 text-center text-sm text-slate-400">
                    No matches returned from search.
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="space-y-6">
            <div className="rounded-2xl border border-white/10 bg-[color:var(--panel)] p-5">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold text-white">Injected context</h2>
                <p className="text-xs uppercase tracking-[0.2em] text-slate-400">
                  {result.injectedRecords.length} memories
                </p>
              </div>
              <div className="mt-4">
                {result.context ? (
                  <pre
                    className="max-h-[420px] overflow-auto rounded-xl bg-black/50 p-4 text-xs text-slate-100"
                    dangerouslySetInnerHTML={{ __html: highlightContext(result.context) }}
                  />
                ) : (
                  <div className="rounded-xl border border-white/10 bg-white/5 p-6 text-center text-sm text-slate-400">
                    No context injected for this prompt.
                  </div>
                )}
              </div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-[color:var(--panel)] p-5">
              <h2 className="text-lg font-semibold text-white">Injected memories</h2>
              <div className="mt-4 space-y-3">
                {result.injectedRecords.length ? (
                  result.injectedRecords.map(record => (
                    <div
                      key={record.id}
                      className="rounded-xl border border-white/10 bg-white/5 p-4 text-sm text-slate-200"
                    >
                      <TypeBadge type={record.type} />
                      <p className="mt-2 text-sm text-slate-100">{recordSummary(record)}</p>
                      <p className="mt-1 text-xs text-slate-500">
                        {record.project ?? 'unknown'} | {record.domain ?? 'unknown'}
                      </p>
                    </div>
                  ))
                ) : (
                  <div className="rounded-xl border border-white/10 bg-white/5 p-6 text-center text-sm text-slate-400">
                    No memories would be injected.
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
