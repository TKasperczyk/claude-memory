import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, RotateCcw, Save } from 'lucide-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { PageHeader } from '@/App'
import ButtonSpinner from '@/components/ButtonSpinner'
import { RETRIEVAL_FIELDS, SettingsPanel, type RetrievalSettingsFormState, type SettingsField } from '@/components/SettingsPanel'
import { useSettings, useSettingsDefaults } from '@/hooks/queries'
import { resetSettings, updateSettings, type Settings } from '@/lib/api'

type SettingsKey = keyof Settings
type FormState = Record<SettingsKey, string>

type SettingsGroup = {
  id: string
  label: string
  description?: string
  fields: SettingsField<SettingsKey>[]
}

const MAINTENANCE_GROUPS: SettingsGroup[] = [
  {
    id: 'stale-age',
    label: 'Stale & age',
    description: 'Invalidate outdated records and verify procedures.',
    fields: [
      {
        key: 'staleDays',
        label: 'Stale days',
        description: 'Records unused for this many days are considered stale.',
        step: 1,
        min: 1,
        kind: 'int'
      },
      {
        key: 'discoveryMaxAgeDays',
        label: 'Discovery max age (days)',
        description: 'Discoveries older than this are invalidated.',
        step: 1,
        min: 1,
        kind: 'int'
      },
      {
        key: 'procedureStepCheckCount',
        label: 'Procedure step checks',
        description: 'Number of steps sampled for command validation in procedures.',
        step: 1,
        min: 1,
        kind: 'int'
      }
    ]
  },
  {
    id: 'low-usage',
    label: 'Low usage deprecation',
    description: 'Deprecate memories that are rarely helpful.',
    fields: [
      {
        key: 'lowUsageMinRetrievals',
        label: 'Min retrievals for ratio',
        description: 'Min retrievals before evaluating usage ratio.',
        step: 1,
        min: 1,
        kind: 'int'
      },
      {
        key: 'lowUsageRatioThreshold',
        label: 'Usage ratio threshold',
        description: 'Usage ratio below this triggers deprecation.',
        step: 0.01,
        min: 0,
        max: 1,
        kind: 'float'
      },
      {
        key: 'lowUsageHighRetrievalMin',
        label: 'Zero-usage high retrievals',
        description: 'High retrieval threshold for zero-usage check.',
        step: 1,
        min: 1,
        kind: 'int'
      }
    ]
  },
  {
    id: 'consolidation',
    label: 'Consolidation',
    description: 'Merge near-duplicate memories into a single record.',
    fields: [
      {
        key: 'consolidationSearchLimit',
        label: 'Search limit',
        description: 'Max similar records to fetch per seed.',
        step: 1,
        min: 1,
        kind: 'int'
      },
      {
        key: 'consolidationMaxClusterSize',
        label: 'Max cluster size',
        description: 'Max records allowed in a single cluster.',
        step: 1,
        min: 1,
        kind: 'int'
      },
      {
        key: 'consolidationThreshold',
        label: 'Consolidation threshold',
        description: 'Similarity threshold for merging (0-1).',
        step: 0.01,
        min: 0,
        max: 1,
        kind: 'float'
      },
      {
        key: 'consolidationTextSimilarityRatio',
        label: 'Text similarity ratio',
        description: 'Levenshtein ratio for text-level duplicate detection.',
        step: 0.01,
        min: 0,
        max: 1,
        kind: 'float'
      }
    ]
  },
  {
    id: 'conflict-resolution',
    label: 'Conflict resolution',
    description: 'Compare new memories against existing knowledge.',
    fields: [
      {
        key: 'conflictSimilarityThreshold',
        label: 'Conflict similarity threshold',
        description: 'Similarity to trigger conflict check.',
        step: 0.01,
        min: 0,
        max: 1,
        kind: 'float'
      },
      {
        key: 'conflictCheckBatchSize',
        label: 'Conflict batch size',
        description: 'Pairs processed per batch.',
        step: 1,
        min: 1,
        kind: 'int'
      },
      {
        key: 'contradictionSimilarityThreshold',
        label: 'Contradiction similarity threshold (legacy)',
        description: 'Similarity threshold for legacy contradiction checks.',
        step: 0.01,
        min: 0,
        max: 1,
        kind: 'float'
      },
      {
        key: 'contradictionSearchLimit',
        label: 'Contradiction search limit (legacy)',
        description: 'Max similar records to fetch per seed in contradiction checks.',
        step: 1,
        min: 1,
        kind: 'int'
      },
      {
        key: 'contradictionBatchSize',
        label: 'Contradiction batch size (legacy)',
        description: 'Pairs processed per contradiction batch.',
        step: 1,
        min: 1,
        kind: 'int'
      }
    ]
  },
  {
    id: 'global-promotion',
    label: 'Global promotion',
    description: 'Promote project memories to global scope.',
    fields: [
      {
        key: 'globalPromotionBatchSize',
        label: 'Promotion batch size',
        description: 'Candidates checked per maintenance run.',
        step: 1,
        min: 1,
        kind: 'int'
      },
      {
        key: 'globalPromotionRecheckDays',
        label: 'Recheck cadence (days)',
        description: 'Days before re-evaluating a candidate.',
        step: 1,
        min: 1,
        kind: 'int'
      },
      {
        key: 'globalPromotionMinSuccessCount',
        label: 'Min success count',
        description: 'Min successes required for eligibility.',
        step: 1,
        min: 1,
        kind: 'int'
      },
      {
        key: 'globalPromotionMinUsageRatio',
        label: 'Min usage ratio',
        description: 'Min usage ratio (e.g., 0.3 = 30%).',
        step: 0.01,
        min: 0,
        max: 1,
        kind: 'float'
      },
      {
        key: 'globalPromotionMinRetrievalsForUsageRatio',
        label: 'Min retrievals for ratio',
        description: 'Retrieval count before usage ratio is enforced.',
        step: 1,
        min: 1,
        kind: 'int'
      }
    ]
  },
  {
    id: 'warning-synthesis',
    label: 'Warning synthesis',
    description: 'Generate warnings from repeated failure patterns.',
    fields: [
      {
        key: 'warningClusterSimilarityThreshold',
        label: 'Warning similarity threshold',
        description: 'Similarity cutoff for grouping failures.',
        step: 0.01,
        min: 0,
        max: 1,
        kind: 'float'
      },
      {
        key: 'warningClusterLimit',
        label: 'Warning cluster limit',
        description: 'Max similar records per warning group.',
        step: 1,
        min: 1,
        kind: 'int'
      },
      {
        key: 'warningSynthesisMinFailures',
        label: 'Min failures',
        description: 'Min failures before synthesizing warning.',
        step: 1,
        min: 1,
        kind: 'int'
      },
      {
        key: 'warningSynthesisBatchSize',
        label: 'Warning batch size',
        description: 'Failure groups processed per batch.',
        step: 1,
        min: 1,
        kind: 'int'
      }
    ]
  },
  {
    id: 'similarity-thresholds',
    label: 'Similarity thresholds',
    description: 'Tune matching sensitivity across the system.',
    fields: [
      {
        key: 'extractionDedupThreshold',
        label: 'Extraction dedup threshold',
        description: 'Similarity for dedup during extraction.',
        step: 0.01,
        min: 0,
        max: 1,
        kind: 'float'
      },
      {
        key: 'reviewSimilarThreshold',
        label: 'Review similar threshold',
        description: 'Threshold for finding similar in review.',
        step: 0.01,
        min: 0,
        max: 1,
        kind: 'float'
      },
      {
        key: 'reviewDuplicateWarningThreshold',
        label: 'Review duplicate threshold',
        description: 'Flag as potential duplicate above this.',
        step: 0.01,
        min: 0,
        max: 1,
        kind: 'float'
      }
    ]
  }
]

const ALL_FIELDS: SettingsField<SettingsKey>[] = [
  ...RETRIEVAL_FIELDS,
  ...MAINTENANCE_GROUPS.flatMap(group => group.fields)
]

function toFormState(settings: Partial<Settings> | null): FormState {
  return ALL_FIELDS.reduce((acc, field) => {
    const value = settings?.[field.key]
    acc[field.key] = typeof value === 'number' ? String(value) : ''
    return acc
  }, {} as FormState)
}

function parseFormState(state: FormState): Settings | null {
  const parsed = {} as Settings

  for (const field of ALL_FIELDS) {
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
  const { data: defaultsResponse } = useSettingsDefaults()
  const defaultSettings = defaultsResponse?.settings ?? null
  const [form, setForm] = useState<FormState>(() => toFormState(settings ?? defaultSettings ?? null))
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(MAINTENANCE_GROUPS.map(group => [group.id, true]))
  )

  useEffect(() => {
    if (settings) {
      setForm(toFormState(settings))
    }
  }, [settings])

  useEffect(() => {
    if (!settings && defaultSettings) {
      setForm(toFormState(defaultSettings))
    }
  }, [settings, defaultSettings])

  useEffect(() => {
    if (!message) return
    const timer = setTimeout(() => setMessage(null), 3500)
    return () => clearTimeout(timer)
  }, [message])

  const initialForm = useMemo(() => (settings ? toFormState(settings) : null), [settings])
  const isDirty = initialForm
    ? ALL_FIELDS.some(field => form[field.key] !== initialForm[field.key])
    : true
  const retrievalForm = useMemo(() => {
    return RETRIEVAL_FIELDS.reduce((acc, field) => {
      acc[field.key] = form[field.key]
      return acc
    }, {} as RetrievalSettingsFormState)
  }, [form])

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

  const toggleGroup = (groupId: string) => {
    setOpenGroups(prev => ({ ...prev, [groupId]: !prev[groupId] }))
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="Tune retrieval, maintenance, and similarity thresholds"
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

        <SettingsPanel
          fields={RETRIEVAL_FIELDS}
          variant="full"
          collapsible={false}
          title="Retrieval settings"
          description="Control similarity filters and injected context limits."
          values={retrievalForm}
          onChange={(key, value) => setForm(prev => ({ ...prev, [key]: value }))}
          defaultValues={defaultSettings ?? undefined}
          disabled={isPending}
          gridClassName="grid gap-5 md:grid-cols-2"
        />
      </div>

      <div className="p-6 rounded-xl border border-border bg-card space-y-5">
        <div>
          <div className="text-sm font-semibold">Maintenance settings</div>
          <p className="text-xs text-muted-foreground">
            Configure cleanup, consolidation, and promotion behavior.
          </p>
        </div>

        <div className="space-y-3">
          {MAINTENANCE_GROUPS.map(group => {
            const isOpen = openGroups[group.id]
            return (
              <div key={group.id} className="rounded-xl border border-border bg-background/40">
                <button
                  onClick={() => toggleGroup(group.id)}
                  className="w-full px-4 py-3 flex items-center gap-3 text-left"
                >
                  {isOpen ? (
                    <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm">{group.label}</div>
                    {group.description && (
                      <div className="text-xs text-muted-foreground">{group.description}</div>
                    )}
                  </div>
                </button>

                <div className={`accordion-content ${isOpen ? 'open' : ''}`}>
                  <div className="accordion-inner">
                    <SettingsPanel
                      fields={group.fields}
                      values={form}
                      onChange={(key, value) => setForm(prev => ({ ...prev, [key]: value }))}
                      defaultValues={defaultSettings ?? undefined}
                      disabled={isPending}
                      variant="full"
                      containerClassName="px-4 pb-4"
                    />
                  </div>
                </div>
              </div>
            )
          })}
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
