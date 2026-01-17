import { useCallback, useEffect, useMemo, useRef, useState, type FocusEvent } from 'react'
import { RotateCcw } from 'lucide-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import ButtonSpinner from '@/components/ButtonSpinner'
import {
  RETRIEVAL_FIELDS,
  SettingsPanel,
  validateFieldValue,
  type RetrievalSettingsFormState,
  type SettingsField
} from '@/components/SettingsPanel'
import { useSettings, useSettingsDefaults } from '@/hooks/queries'
import { resetSettings, updateSettings, type RetrievalSettings, type Settings } from '@/lib/api'

type SettingsKey = keyof Settings
type FormState = Record<SettingsKey, string>
type FormErrors = Partial<Record<SettingsKey, string>>
type StatusContext = 'save' | 'reset'
type Status = { type: 'saving' | 'success' | 'error'; text: string; context: StatusContext }

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
const AUTO_SAVE_DELAY_MS = 500
const SUCCESS_FADE_DELAY_MS = 1400
const SUCCESS_CLEAR_DELAY_MS = 1700
const SETTINGS_FIELD_PREFIX = 'settings-field-'
const SETTINGS_FIELD_LABEL_SUFFIX = '-label'
const SETTINGS_FIELD_SLIDER_SUFFIX = '-slider'
const SETTINGS_KEY_SET = new Set<SettingsKey>(ALL_FIELDS.map(field => field.key))

function extractSettingsKey(rawId: string | null): SettingsKey | null {
  if (!rawId || !rawId.startsWith(SETTINGS_FIELD_PREFIX)) return null
  let key = rawId.slice(SETTINGS_FIELD_PREFIX.length)
  if (key.endsWith(SETTINGS_FIELD_SLIDER_SUFFIX)) {
    key = key.slice(0, -SETTINGS_FIELD_SLIDER_SUFFIX.length)
  } else if (key.endsWith(SETTINGS_FIELD_LABEL_SUFFIX)) {
    key = key.slice(0, -SETTINGS_FIELD_LABEL_SUFFIX.length)
  }
  return SETTINGS_KEY_SET.has(key as SettingsKey) ? (key as SettingsKey) : null
}

function getSettingsKeyFromElement(target: EventTarget | null): SettingsKey | null {
  if (!(target instanceof HTMLElement)) return null
  const directKey = extractSettingsKey(target.getAttribute('id'))
  if (directKey) return directKey
  const labelledBy = target.getAttribute('aria-labelledby')
  if (!labelledBy) return null
  for (const labelId of labelledBy.split(/\s+/)) {
    const key = extractSettingsKey(labelId)
    if (key) return key
  }
  return null
}

function isFieldSynced(rawInput: string, field: SettingsField<SettingsKey>, settings: Settings): boolean {
  const trimmed = rawInput.trim()
  if (trimmed === '') return false
  const { value, error } = validateFieldValue(field, trimmed)
  if (error || value === undefined) return false
  const normalized = field.kind === 'int' && typeof value === 'number' ? Math.trunc(value) : value
  return normalized === settings[field.key]
}

function toFormState(settings: Partial<Settings> | null): FormState {
  return ALL_FIELDS.reduce((acc, field) => {
    const value = settings?.[field.key]
    if (typeof value === 'number') {
      acc[field.key] = String(value)
    } else if (typeof value === 'boolean') {
      acc[field.key] = String(value)
    } else {
      acc[field.key] = ''
    }
    return acc
  }, {} as FormState)
}

function parseFormState(
  state: FormState,
  options: { requireAll?: boolean } = {}
): { values: Partial<Settings>; errors: FormErrors; isValid: boolean } {
  const values: Partial<Settings> = {}
  const errors: FormErrors = {}
  const requireAll = options.requireAll ?? false

  for (const field of ALL_FIELDS) {
    const rawInput = state[field.key].trim()
    if (rawInput === '') {
      if (requireAll) {
        errors[field.key] = 'Required.'
      }
      continue
    }

    const { value, error } = validateFieldValue(field, rawInput)
    if (error) {
      errors[field.key] = error
      continue
    }
    if (value !== undefined) {
      ;(values as Record<string, number | boolean>)[field.key] = field.kind === 'int' && typeof value === 'number' ? Math.trunc(value) : value
    }
  }

  const isValid = Object.keys(errors).length === 0
    && (!requireAll || Object.keys(values).length === ALL_FIELDS.length)

  return { values, errors, isValid }
}

export default function Settings() {
  const queryClient = useQueryClient()
  const { data: settings, error, isPending } = useSettings()
  const { data: defaultsResponse } = useSettingsDefaults()
  const defaultSettings = defaultsResponse?.settings ?? null
  const [form, setForm] = useState<FormState>(() => toFormState(settings ?? defaultSettings ?? null))
  const [status, setStatus] = useState<Status | null>(null)
  const [statusFading, setStatusFading] = useState(false)
  const [isAutoSaving, setIsAutoSaving] = useState(false)
  const formRef = useRef(form)
  const settingsRef = useRef<Settings | null>(settings ?? null)
  const lastSyncedSettingsRef = useRef<Settings | null>(settings ?? defaultSettings ?? null)
  const saveInFlightRef = useRef(false)
  const queuedSaveRef = useRef(false)
  const isMountedRef = useRef(true)
  const abortControllerRef = useRef<AbortController | null>(null)
  const editingFieldsRef = useRef<Set<SettingsKey>>(new Set())

  const handleFocusCapture = useCallback((event: FocusEvent<HTMLDivElement>) => {
    const key = getSettingsKeyFromElement(event.target)
    if (key) {
      editingFieldsRef.current.add(key)
    }
  }, [])

  const handleBlurCapture = useCallback((event: FocusEvent<HTMLDivElement>) => {
    const key = getSettingsKeyFromElement(event.target)
    if (!key) return
    const nextKey = getSettingsKeyFromElement(event.relatedTarget)
    if (nextKey === key) return
    editingFieldsRef.current.delete(key)
  }, [])

  useEffect(() => {
    formRef.current = form
  }, [form])

  useEffect(() => {
    settingsRef.current = settings ?? null
  }, [settings])

  useEffect(() => {
    return () => {
      isMountedRef.current = false
      abortControllerRef.current?.abort()
    }
  }, [])

  useEffect(() => {
    const nextSettings = settings ?? defaultSettings ?? null
    if (!nextSettings) return

    const previousSettings = lastSyncedSettingsRef.current
    setForm(prev => {
      let next = prev
      for (const field of ALL_FIELDS) {
        const key = field.key
        if (editingFieldsRef.current.has(key)) continue
        if (previousSettings && !isFieldSynced(prev[key], field, previousSettings)) continue
        const value = nextSettings[key]
        const formatted = field.kind === 'int' && typeof value === 'number'
          ? String(Math.trunc(value))
          : String(value)
        if (prev[key] === formatted) continue
        if (next === prev) {
          next = { ...prev }
        }
        next[key] = formatted
      }
      return next
    })
    lastSyncedSettingsRef.current = nextSettings
  }, [settings, defaultSettings])

  useEffect(() => {
    if (!status || status.type !== 'success') {
      setStatusFading(false)
      return
    }
    setStatusFading(false)
    const fadeTimer = setTimeout(() => setStatusFading(true), SUCCESS_FADE_DELAY_MS)
    const clearTimer = setTimeout(() => setStatus(null), SUCCESS_CLEAR_DELAY_MS)
    return () => {
      clearTimeout(fadeTimer)
      clearTimeout(clearTimer)
    }
  }, [status])

  const retrievalForm = useMemo(() => {
    return RETRIEVAL_FIELDS.reduce((acc, field) => {
      acc[field.key] = form[field.key]
      return acc
    }, {} as RetrievalSettingsFormState)
  }, [form])

  const formValidation = useMemo(() => parseFormState(form, { requireAll: true }), [form])
  const formErrors = formValidation.errors

  const resetMutation = useMutation({
    mutationFn: resetSettings,
    onSuccess: data => {
      queryClient.setQueryData(['settings'], data)
      settingsRef.current = data
      lastSyncedSettingsRef.current = data
      setForm(toFormState(data))
      setStatus({ type: 'success', text: 'Settings reset to defaults.', context: 'reset' })
    },
    onError: err => {
      setStatus({
        type: 'error',
        text: (err as Error).message || 'Failed to reset settings.',
        context: 'reset'
      })
    }
  })

  const triggerAutoSave = useCallback(async () => {
    if (!isMountedRef.current) return
    if (saveInFlightRef.current) {
      queuedSaveRef.current = true
      return
    }
    const currentSettings = settingsRef.current
    const currentForm = formRef.current
    if (!currentSettings) {
      if (isMountedRef.current) {
        setIsAutoSaving(false)
      }
      return
    }
    const validation = parseFormState(currentForm, { requireAll: true })
    if (!validation.isValid) {
      if (isMountedRef.current) {
        setIsAutoSaving(false)
      }
      return
    }
    const parsed = validation.values as Settings
    const updates = ALL_FIELDS.filter(field => parsed[field.key] !== currentSettings[field.key])
    if (updates.length === 0) {
      if (isMountedRef.current) {
        setIsAutoSaving(false)
      }
      return
    }

    saveInFlightRef.current = true
    if (isMountedRef.current) {
      setIsAutoSaving(true)
      setStatus({ type: 'saving', text: 'Saving...', context: 'save' })
    }
    let hadError = false
    const abortController = new AbortController()
    abortControllerRef.current = abortController
    const payload: Partial<Settings> = {}
    for (const field of updates) {
      ;(payload as Record<string, number | boolean>)[field.key] = parsed[field.key]
    }

    try {
      const nextSettings = await updateSettings(payload, { signal: abortController.signal })
      queryClient.setQueryData(['settings'], nextSettings)
      settingsRef.current = nextSettings
      lastSyncedSettingsRef.current = nextSettings
      if (isMountedRef.current) {
        setForm(prev => {
          let next = prev
          for (const field of updates) {
            const key = field.key
            const rawInput = prev[key].trim()
            // Handle boolean fields differently
            if (field.kind === 'bool') {
              const currentBool = rawInput === 'true'
              if (currentBool !== parsed[key]) continue
              const formatted = String(nextSettings[key])
              if (next[key] === formatted) continue
              if (next === prev) {
                next = { ...prev }
              }
              next[key] = formatted
              continue
            }
            const currentNumber = Number(rawInput)
            if (!Number.isFinite(currentNumber)) continue
            const normalized = field.kind === 'int' ? Math.trunc(currentNumber) : currentNumber
            if (normalized !== parsed[key]) continue
            const settingsValue = nextSettings[key]
            const formatted = field.kind === 'int' && typeof settingsValue === 'number'
              ? String(Math.trunc(settingsValue))
              : String(settingsValue)
            if (next[key] === formatted) continue
            if (next === prev) {
              next = { ...prev }
            }
            next[key] = formatted
          }
          return next
        })
        setStatus({ type: 'success', text: 'Saved', context: 'save' })
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return
      }
      hadError = true
      if (isMountedRef.current) {
        setStatus({
          type: 'error',
          text: (err as Error).message || 'Failed to save settings.',
          context: 'save'
        })
      }
    } finally {
      saveInFlightRef.current = false
      if (abortControllerRef.current === abortController) {
        abortControllerRef.current = null
      }
      if (!isMountedRef.current) {
        queuedSaveRef.current = false
        return
      }
      if (queuedSaveRef.current && !hadError) {
        queuedSaveRef.current = false
        void triggerAutoSave()
        return
      }
      queuedSaveRef.current = false
      setIsAutoSaving(false)
    }
  }, [queryClient])

  useEffect(() => {
    if (!settings) return
    if (!formValidation.isValid) return
    const parsed = formValidation.values as Settings
    const hasChanges = ALL_FIELDS.some(field => parsed[field.key] !== settings[field.key])
    if (!hasChanges) return
    const timer = setTimeout(() => {
      void triggerAutoSave()
    }, AUTO_SAVE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [formValidation, settings, triggerAutoSave])

  const handleFieldChange = useCallback((key: SettingsKey, value: string) => {
    formRef.current = { ...formRef.current, [key]: value }
    setForm(prev => ({ ...prev, [key]: value }))
    setStatus(prev => (prev?.type === 'saving' ? prev : null))
    setStatusFading(false)
  }, [])

  const handleReset = () => {
    resetMutation.mutate()
  }

  const handleRetry = () => {
    void triggerAutoSave()
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto space-y-6" onFocusCapture={handleFocusCapture} onBlurCapture={handleBlurCapture}>
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
          collapsible
          size="sm"
          defaultOpen
          title="Retrieval settings"
          description="Control similarity filters and injected context limits."
          values={retrievalForm}
          onChange={handleFieldChange}
          savedValues={(defaultSettings ?? undefined) as RetrievalSettings | undefined}
          defaultValues={(defaultSettings ?? undefined) as RetrievalSettings | undefined}
          errors={formErrors}
          showModifiedBadge
          showFieldModified
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
          {MAINTENANCE_GROUPS.map(group => (
            <SettingsPanel
              key={group.id}
              collapsible
              size="sm"
              defaultOpen
              title={group.label}
              description={group.description}
              fields={group.fields}
              values={form}
              onChange={handleFieldChange}
              savedValues={(defaultSettings ?? undefined) as Settings | undefined}
              defaultValues={(defaultSettings ?? undefined) as Settings | undefined}
              errors={formErrors}
              showFieldModified
              showModifiedBadge
              disabled={isPending}
              variant="full"
            />
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={handleReset}
          disabled={isPending || resetMutation.isPending || isAutoSaving}
          className="flex items-center gap-2 h-9 px-4 rounded-md border border-border text-sm font-medium text-foreground hover:bg-secondary/60 transition-base disabled:opacity-50"
        >
          {resetMutation.isPending ? <ButtonSpinner size="sm" /> : <RotateCcw className="w-4 h-4" />}
          {resetMutation.isPending ? 'Resetting...' : 'Reset to defaults'}
        </button>

        {status && (
          <div
            className={`text-sm transition-opacity duration-300 ${statusFading ? 'opacity-0' : 'opacity-100'} ${
              status.type === 'error'
                ? 'text-destructive'
                : status.type === 'success'
                  ? 'text-emerald-400'
                  : 'text-muted-foreground'
            }`}
          >
            <span>{status.text}</span>
            {status.type === 'error' && status.context === 'save' && (
              <button
                type="button"
                onClick={handleRetry}
                className="ml-2 text-xs font-medium text-destructive underline-offset-2 hover:underline"
              >
                Retry
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
