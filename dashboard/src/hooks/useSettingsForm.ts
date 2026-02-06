import { useCallback, useEffect, useMemo, useRef, useState, type FocusEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { validateFieldValue, type RetrievalSettingsFormState, type SettingsField } from '@/components/SettingsPanel'
import { MAINTENANCE_GROUPS, MODEL_FIELDS, RETRIEVAL_FIELDS } from '../../../src/lib/settings-schema.js'
import { useSettings, useSettingsDefaults } from '@/hooks/queries'
import { resetSettings, updateSettings, type Settings } from '@/lib/api'

type SettingsKey = keyof Settings
type FormState = Record<SettingsKey, string>
type FormErrors = Partial<Record<SettingsKey, string>>
type StatusContext = 'save' | 'reset'
type Status = { type: 'saving' | 'success' | 'error'; text: string; context: StatusContext }

const ALL_FIELDS: SettingsField<SettingsKey>[] = [
  ...RETRIEVAL_FIELDS,
  ...MAINTENANCE_GROUPS.flatMap(group => group.fields),
  ...MODEL_FIELDS
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
  if (field.kind === 'text') {
    return trimmed === settings[field.key]
  }
  const { value, error } = validateFieldValue(field, trimmed)
  if (error || value === undefined) return false
  const normalized = field.kind === 'int' && typeof value === 'number' ? Math.trunc(value) : value
  return normalized === settings[field.key]
}

function toFormState(settings: Partial<Settings> | null): FormState {
  return ALL_FIELDS.reduce((acc, field) => {
    const value = settings?.[field.key]
    if (typeof value === 'string') {
      acc[field.key] = value
    } else if (typeof value === 'number') {
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
      ;(values as Record<string, number | boolean | string>)[field.key] = field.kind === 'int' && typeof value === 'number' ? Math.trunc(value) : value
    }
  }

  const isValid = Object.keys(errors).length === 0
    && (!requireAll || Object.keys(values).length === ALL_FIELDS.length)

  return { values, errors, isValid }
}

export function useSettingsForm() {
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
    isMountedRef.current = true
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
      ;(payload as Record<string, number | boolean | string>)[field.key] = parsed[field.key]
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
            // Handle text fields
            if (field.kind === 'text') {
              if (rawInput !== parsed[key]) continue
              const formatted = String(nextSettings[key])
              if (next[key] === formatted) continue
              if (next === prev) {
                next = { ...prev }
              }
              next[key] = formatted
              continue
            }
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

  return {
    settings,
    defaultSettings,
    error,
    isPending,
    form,
    retrievalForm,
    formErrors,
    status,
    statusFading,
    isAutoSaving,
    isResetting: resetMutation.isPending,
    handleFieldChange,
    handleReset,
    handleRetry,
    handleFocusCapture,
    handleBlurCapture
  }
}
