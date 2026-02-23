import { useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import MemoryDetail from '@/components/MemoryDetail'
import NearMissesPanel from '@/components/NearMissesPanel'
import {
  SettingsPanel,
  buildSettingsOverride,
  toFormState,
  type RetrievalSettingsFormState
} from '@/components/SettingsPanel'
import { RETRIEVAL_FIELDS } from '../../../src/lib/settings-schema.js'
import {
  previewContext,
  updateSettings,
  type MemoryRecord,
  type PreviewResponse,
  type RetrievalSettings,
  type Settings
} from '@/lib/api'
import { TYPE_COLORS, getMemorySummary } from '@/lib/memory-ui'
import { useSettings, useSettingsDefaults } from '@/hooks/queries'

type PreviewLocationState = {
  prompt?: string
  cwd?: string
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

export default function ContextPreview() {
  const queryClient = useQueryClient()
  const location = useLocation()
  const locationState = location.state as PreviewLocationState | null
  const previewPrompt = typeof locationState?.prompt === 'string' ? locationState.prompt : ''
  const previewCwd = typeof locationState?.cwd === 'string' ? locationState.cwd : ''
  const [prompt, setPrompt] = useState('')
  const [cwd, setCwd] = useState('')
  const [result, setResult] = useState<PreviewResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<MemoryRecord | null>(null)
  const [diagnosticEnabled, setDiagnosticEnabled] = useState(false)

  // Settings state
  const { data: savedSettings, isPending: settingsPending } = useSettings()
  const { data: defaultsResponse } = useSettingsDefaults()
  const defaultSettings = defaultsResponse?.settings ?? null
  const [settingsForm, setSettingsForm] = useState<RetrievalSettingsFormState>(() =>
    toFormState(savedSettings ?? defaultSettings ?? null)
  )
  const [saveMessage, setSaveMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  // Sync settings form when saved settings load
  useEffect(() => {
    if (savedSettings) {
      setSettingsForm(toFormState(savedSettings))
    }
  }, [savedSettings])

  const isFormEmpty = useMemo(() => (
    RETRIEVAL_FIELDS.every(field => settingsForm[field.key].trim() === '')
  ), [settingsForm])

  useEffect(() => {
    if (!savedSettings && defaultSettings && isFormEmpty) {
      setSettingsForm(toFormState(defaultSettings))
    }
  }, [defaultSettings, isFormEmpty, savedSettings])

  // Clear save message after delay
  useEffect(() => {
    if (!saveMessage) return
    const timer = setTimeout(() => setSaveMessage(null), 3500)
    return () => clearTimeout(timer)
  }, [saveMessage])

  useEffect(() => {
    if (!previewPrompt && !previewCwd) return
    setPrompt(previewPrompt)
    setCwd(previewCwd)
    setResult(null)
    setError(null)
  }, [previewPrompt, previewCwd])

  // Compute if we have overrides
  const effectiveSettings = savedSettings ?? defaultSettings
  const settingsValidation = useMemo(() => {
    if (!effectiveSettings) {
      return { override: undefined, errors: {}, hasOverride: false, isDirty: false, values: {} }
    }
    return buildSettingsOverride(settingsForm, effectiveSettings as RetrievalSettings)
  }, [effectiveSettings, settingsForm])
  const {
    override: settingsOverride,
    errors: settingsErrors,
    hasOverride,
    isDirty,
    values: parsedValues
  } = settingsValidation
  const hasErrors = Object.keys(settingsErrors).length > 0

  const saveMutation = useMutation<Settings, Error, Partial<Settings>>({
    mutationFn: settings => updateSettings(settings),
    onSuccess: data => {
      queryClient.setQueryData(['settings'], data)
      setSettingsForm(toFormState(data))
      setSaveMessage({ type: 'success', text: 'Settings saved.' })
    },
    onError: err => {
      setSaveMessage({ type: 'error', text: (err as Error).message || 'Failed to save settings.' })
    }
  })

  const handleSaveSettings = () => {
    if (!effectiveSettings) return
    if (hasErrors) {
      setSaveMessage({ type: 'error', text: 'Fix invalid values before applying.' })
      return
    }
    saveMutation.mutate(parsedValues)
  }

  const handleResetSettings = () => {
    if (savedSettings) {
      setSettingsForm(toFormState(savedSettings))
    } else if (defaultSettings) {
      setSettingsForm(toFormState(defaultSettings))
    }
  }

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
      const response = await previewContext({
        prompt: trimmed,
        cwd: cwd.trim() || undefined,
        settings: settingsOverride,
        diagnostic: diagnosticEnabled ? true : undefined
      })
      setResult(response)
    } catch (err) {
      setError((err as Error).message || 'Failed to preview context')
    } finally {
      setLoading(false)
    }
  }

  const handleDiagnosticToggle = (checked: boolean) => {
    setDiagnosticEnabled(checked)
    setResult(null)
    setSelected(null)
    setError(null)
  }

  const previewDisabled = loading || settingsPending

  return (
    <div className="flex-1 min-h-0 overflow-y-auto space-y-5">
      {/* Input form */}
      <Card>
        <CardContent className="p-5 space-y-4">
          <div>
            <label className="block text-[11px] uppercase tracking-wide text-muted-foreground/70 mb-1.5 font-medium">Prompt</label>
            <Textarea
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              rows={5}
              placeholder="Enter a prompt to test memory injection…"
              className="resize-none"
            />
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <div className="flex-1">
              <label className="block text-[11px] uppercase tracking-wide text-muted-foreground/70 mb-1.5 font-medium">
                Working directory (optional)
              </label>
              <Input
                type="text"
                value={cwd}
                onChange={e => setCwd(e.target.value)}
                placeholder="/home/user/project"
              />
            </div>
            <label className="flex items-center gap-2.5 h-9 px-3 rounded-lg border border-border bg-secondary/50 cursor-pointer hover:bg-secondary transition-colors">
              <Checkbox
                checked={diagnosticEnabled}
                onCheckedChange={(checked) => handleDiagnosticToggle(checked === true)}
              />
              <span className="text-sm text-muted-foreground">Diagnostic mode</span>
            </label>
            <Button onClick={handlePreview} disabled={previewDisabled}>
              {loading ? <Loader2 className="animate-spin" /> : <Play className="w-4 h-4" />}
              {loading ? 'Running...' : 'Preview'}
            </Button>
          </div>

          {error && (
            <div className="text-sm text-destructive">{error}</div>
          )}
        </CardContent>
      </Card>

      {/* Retrieval Settings */}
      <SettingsPanel
        fields={RETRIEVAL_FIELDS}
        variant="compact"
        collapsible
        title="Retrieval Settings"
        description="Adjust thresholds and limits for this preview (not saved until you apply)"
        values={settingsForm}
        onChange={(key, value) => setSettingsForm(prev => ({ ...prev, [key]: value }))}
        savedValues={(effectiveSettings ?? undefined) as RetrievalSettings | undefined}
        errors={settingsErrors}
        onSave={handleSaveSettings}
        onReset={handleResetSettings}
        isSaving={saveMutation.isPending}
        saveDisabled={saveMutation.isPending || !hasOverride || hasErrors}
        resetDisabled={!isDirty}
        saveLabel="Apply Settings"
        status={saveMessage}
        disabled={settingsPending}
      />

      {/* Results */}
      {result && (
        <div className="grid lg:grid-cols-2 gap-6">
          {/* Left column: Signals & Matches */}
          <div className="space-y-6">
            {/* Signals */}
            <Card>
              <CardContent className="p-6">
                <h3 className="section-header mb-4">Extracted signals</h3>
                <div className="space-y-3 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Project</span>
                    <span>{result.signals.projectName ?? '—'}</span>
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
              </CardContent>
            </Card>

            {/* Query Info (diagnostic only) */}
            {diagnosticEnabled && result.queryInfo && (
              <Card>
                <CardContent className="p-6">
                  <h3 className="section-header mb-4">
                    Processed queries
                    {result.queryInfo.haikuUsed && (
                      <span className="ml-2 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-primary/10 text-primary font-medium">
                        Haiku
                      </span>
                    )}
                  </h3>
                  <div className="space-y-3 text-sm">
                    <div>
                      <span className="text-muted-foreground text-xs">Semantic query</span>
                      <pre className="mt-1 p-2 rounded bg-secondary text-xs font-mono whitespace-pre-wrap break-words">
                        {result.queryInfo.semanticQuery || '(none)'}
                      </pre>
                    </div>
                    <div>
                      <span className="text-muted-foreground text-xs">Keyword queries</span>
                      {result.queryInfo.keywordQueries.length > 0 ? (
                        <div className="flex flex-wrap gap-1 mt-1">
                          {result.queryInfo.keywordQueries.map((q, i) => (
                            <span key={i} className="px-2 py-1 rounded text-xs bg-secondary font-mono break-all">
                              {q}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <div className="mt-1 text-xs text-muted-foreground">(none)</div>
                      )}
                    </div>
                    <div>
                      <span className="text-muted-foreground text-xs">Effective prompt (after cleanup)</span>
                      <pre className="mt-1 p-2 rounded bg-secondary text-xs font-mono whitespace-pre-wrap break-words max-h-[150px] overflow-y-auto">
                        {result.queryInfo.effectivePrompt || '(none)'}
                      </pre>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Matches */}
            <Card>
              <CardContent className="p-6">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="section-header">Search results</h3>
                  <span className="text-xs text-muted-foreground tabular-nums">{result.results.length} matches</span>
                </div>
                {result.results.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No matches found</p>
                ) : (
                  <div className="space-y-2">
                    {result.results.map(match => (
                      <button
                        key={match.record.id}
                        onClick={() => setSelected(match.record)}
                        className="w-full text-left p-3 rounded-md bg-secondary/30 text-sm cursor-pointer hover:bg-secondary/50 transition-colors"
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
                        <div className="truncate">{getMemorySummary(match.record)}</div>
                      </button>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {diagnosticEnabled && (
              <NearMissesPanel
                nearMisses={result.nearMisses ?? []}
                onSelect={setSelected}
              />
            )}
          </div>

          {/* Right column: Injected context */}
          <div className="space-y-6">
            <Card>
              <CardContent className="p-6">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="section-header">Injected context</h3>
                  <span className="text-xs text-muted-foreground tabular-nums">
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
              </CardContent>
            </Card>

            {result.injectedRecords.length > 0 && (
              <Card>
                <CardContent className="p-6">
                  <h3 className="section-header mb-4">Injected memories</h3>
                  <div className="space-y-2">
                    {result.injectedRecords.map(record => (
                      <button
                        key={record.id}
                        onClick={() => setSelected(record)}
                        className="w-full text-left flex items-start gap-2 text-sm p-2 -mx-2 rounded cursor-pointer hover:bg-secondary/50 transition-colors"
                      >
                        <span
                          className="w-2 h-2 rounded-full mt-1.5 shrink-0"
                          style={{ backgroundColor: TYPE_COLORS[record.type] }}
                        />
                        <div className="min-w-0">
                          <div className="truncate">{getMemorySummary(record)}</div>
                          <div className="text-xs text-muted-foreground">
                            {record.project ?? '—'}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      )}

      <MemoryDetail record={selected} onClose={() => setSelected(null)} />
    </div>
  )
}
