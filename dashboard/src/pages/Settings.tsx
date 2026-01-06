import { useEffect, useMemo, useState } from 'react'
import { RotateCcw, Save } from 'lucide-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { PageHeader } from '@/App'
import ButtonSpinner from '@/components/ButtonSpinner'
import { useSettings } from '@/hooks/queries'
import { resetSettings, updateSettings, type RetrievalSettings } from '@/lib/api'

const DEFAULT_SETTINGS: RetrievalSettings = {
  minSemanticSimilarity: 0.70,
  minScore: 0.45,
  minSemanticOnlyScore: 0.65,
  maxRecords: 5,
  maxTokens: 2000,
  mmrLambda: 0.7,
  usageRatioWeight: 0.2
}

type SettingsKey = keyof RetrievalSettings
type FormState = Record<SettingsKey, string>
type SettingsField = {
  key: SettingsKey
  label: string
  description: string
  defaultValue: number
  step: number
  min?: number
  max?: number
  kind: 'float' | 'int'
}

const SETTINGS_FIELDS: SettingsField[] = [
  {
    key: 'minSemanticSimilarity',
    label: 'Min semantic similarity',
    description: 'Drop semantic matches below this cosine similarity.',
    defaultValue: DEFAULT_SETTINGS.minSemanticSimilarity,
    step: 0.01,
    min: 0,
    max: 1,
    kind: 'float'
  },
  {
    key: 'minScore',
    label: 'Min hybrid score',
    description: 'Threshold for non-keyword matches in hybrid retrieval.',
    defaultValue: DEFAULT_SETTINGS.minScore,
    step: 0.01,
    min: 0,
    max: 1,
    kind: 'float'
  },
  {
    key: 'minSemanticOnlyScore',
    label: 'Min semantic-only score',
    description: 'Score cutoff when only semantic search is used.',
    defaultValue: DEFAULT_SETTINGS.minSemanticOnlyScore,
    step: 0.01,
    min: 0,
    max: 1,
    kind: 'float'
  },
  {
    key: 'maxRecords',
    label: 'Max records',
    description: 'Maximum memories injected per prompt.',
    defaultValue: DEFAULT_SETTINGS.maxRecords,
    step: 1,
    min: 1,
    kind: 'int'
  },
  {
    key: 'maxTokens',
    label: 'Max tokens',
    description: 'Token budget for the injected context block.',
    defaultValue: DEFAULT_SETTINGS.maxTokens,
    step: 50,
    min: 1,
    kind: 'int'
  },
  {
    key: 'mmrLambda',
    label: 'MMR lambda',
    description: 'Balance relevance vs. diversity (1.0 = relevance).',
    defaultValue: DEFAULT_SETTINGS.mmrLambda,
    step: 0.01,
    min: 0,
    max: 1,
    kind: 'float'
  },
  {
    key: 'usageRatioWeight',
    label: 'Usage ratio weight',
    description: 'Boost memories with high usefulness ratings.',
    defaultValue: DEFAULT_SETTINGS.usageRatioWeight,
    step: 0.01,
    min: 0,
    max: 1,
    kind: 'float'
  }
]

function toFormState(settings: RetrievalSettings): FormState {
  return {
    minSemanticSimilarity: String(settings.minSemanticSimilarity),
    minScore: String(settings.minScore),
    minSemanticOnlyScore: String(settings.minSemanticOnlyScore),
    maxRecords: String(settings.maxRecords),
    maxTokens: String(settings.maxTokens),
    mmrLambda: String(settings.mmrLambda),
    usageRatioWeight: String(settings.usageRatioWeight)
  }
}

function parseFormState(state: FormState): RetrievalSettings | null {
  const parsed = {} as RetrievalSettings

  for (const field of SETTINGS_FIELDS) {
    const rawInput = state[field.key].trim()
    if (rawInput === '') return null
    const rawValue = Number(rawInput)
    if (!Number.isFinite(rawValue)) return null

    if (field.kind === 'int') {
      const value = Math.trunc(rawValue)
      if (field.min !== undefined && value < field.min) return null
      if (field.max !== undefined && value > field.max) return null
      parsed[field.key] = value
    } else {
      if (field.min !== undefined && rawValue < field.min) return null
      if (field.max !== undefined && rawValue > field.max) return null
      parsed[field.key] = rawValue
    }
  }

  return parsed
}

export default function Settings() {
  const queryClient = useQueryClient()
  const { data: settings, error, isPending } = useSettings()
  const [form, setForm] = useState<FormState>(() => toFormState(DEFAULT_SETTINGS))
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  useEffect(() => {
    if (settings) {
      setForm(toFormState(settings))
    }
  }, [settings])

  useEffect(() => {
    if (!message) return
    const timer = setTimeout(() => setMessage(null), 3500)
    return () => clearTimeout(timer)
  }, [message])

  const initialForm = useMemo(() => (settings ? toFormState(settings) : null), [settings])
  const isDirty = initialForm
    ? SETTINGS_FIELDS.some(field => form[field.key] !== initialForm[field.key])
    : true

  const saveMutation = useMutation({
    mutationFn: updateSettings,
    onSuccess: data => {
      queryClient.setQueryData(['settings'], data)
      setForm(toFormState(data))
      setMessage({ type: 'success', text: 'Settings saved.' })
    },
    onError: err => {
      setMessage({ type: 'error', text: (err as Error).message || 'Failed to save settings.' })
    }
  })

  const resetMutation = useMutation({
    mutationFn: resetSettings,
    onSuccess: data => {
      queryClient.setQueryData(['settings'], data)
      setForm(toFormState(data))
      setMessage({ type: 'success', text: 'Settings reset to defaults.' })
    },
    onError: err => {
      setMessage({ type: 'error', text: (err as Error).message || 'Failed to reset settings.' })
    }
  })

  const handleSave = () => {
    const parsed = parseFormState(form)
    if (!parsed) {
      setMessage({ type: 'error', text: 'Enter valid values for all settings.' })
      return
    }
    saveMutation.mutate(parsed)
  }

  const handleReset = () => {
    resetMutation.mutate()
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="Tune retrieval thresholds and injection limits"
      />

      <div className="p-6 rounded-xl border border-border bg-card space-y-6">
        <div className="text-xs text-muted-foreground">
          Stored in <span className="font-mono">~/.claude-memory/settings.json</span>
        </div>

        {error && (
          <div className="text-sm text-destructive">
            Failed to load settings. Showing defaults.
          </div>
        )}

        {isPending && !settings && (
          <div className="text-sm text-muted-foreground">
            Loading settings...
          </div>
        )}

        <div className="grid gap-5 md:grid-cols-2">
          {SETTINGS_FIELDS.map(field => (
            <div key={field.key} className="space-y-2">
              <div>
                <label className="block text-sm font-medium">{field.label}</label>
                <p className="text-xs text-muted-foreground">{field.description}</p>
                <p className="text-xs text-muted-foreground">
                  Default: {field.defaultValue}
                </p>
              </div>
              <input
                type="number"
                value={form[field.key]}
                onChange={e => setForm(prev => ({ ...prev, [field.key]: e.target.value }))}
                step={field.step}
                min={field.min}
                max={field.max}
                disabled={isPending}
                className="w-full h-9 px-3 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-60"
              />
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={handleSave}
          disabled={isPending || saveMutation.isPending || !isDirty}
          className="flex items-center gap-2 h-9 px-4 rounded-md bg-foreground text-background text-sm font-medium disabled:opacity-50 hover:bg-foreground/90 transition-base"
        >
          {saveMutation.isPending ? <ButtonSpinner size="sm" /> : <Save className="w-4 h-4" />}
          {saveMutation.isPending ? 'Saving...' : 'Save settings'}
        </button>

        <button
          onClick={handleReset}
          disabled={isPending || resetMutation.isPending}
          className="flex items-center gap-2 h-9 px-4 rounded-md border border-border text-sm font-medium text-foreground hover:bg-secondary/60 transition-base disabled:opacity-50"
        >
          {resetMutation.isPending ? <ButtonSpinner size="sm" /> : <RotateCcw className="w-4 h-4" />}
          {resetMutation.isPending ? 'Resetting...' : 'Reset to defaults'}
        </button>

        {message && (
          <div className={`text-sm ${message.type === 'success' ? 'text-emerald-400' : 'text-destructive'}`}>
            {message.text}
          </div>
        )}
      </div>
    </div>
  )
}
