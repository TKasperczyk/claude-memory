import { useMemo, useState, type ReactElement } from 'react'
import { ChevronDown, ChevronRight, RotateCcw, Save } from 'lucide-react'
import ButtonSpinner from '@/components/ButtonSpinner'
import { type RetrievalSettings } from '@/lib/api'
import { cn } from '../lib/utils'

type SettingsGroupMeta = {
  label: string
  description?: string
}

export type SettingsField<K extends string = string> = {
  key: K
  label: string
  description: string
  step?: number
  min?: number
  max?: number
  kind: 'float' | 'int' | 'bool'
  group?: SettingsGroupMeta
}

export type SettingsFormState<K extends string = string> = Record<K, string>
export type SettingsErrors<K extends string = string> = Partial<Record<K, string>>

export type RetrievalSettingsFormState = SettingsFormState<keyof RetrievalSettings>
export type RetrievalSettingsErrors = SettingsErrors<keyof RetrievalSettings>

type ModifiedBadgeVariant = 'field' | 'header'

export function ModifiedBadge({
  variant = 'header',
  className
}: { variant?: ModifiedBadgeVariant; className?: string }) {
  const baseClass = 'text-[10px] rounded bg-amber-500/20 text-amber-400'
  const variantClass = variant === 'field' ? 'px-1.5 py-0.5' : 'px-2 py-0.5 font-medium'
  return <span className={cn(baseClass, variantClass, className)}>Modified</span>
}

export function isSettingsModified<K extends string>({
  fields,
  values,
  baselineValues,
  errors
}: {
  fields: SettingsField<K>[]
  values: SettingsFormState<K>
  baselineValues?: Partial<Record<K, number | boolean>>
  errors?: SettingsErrors<K>
}): boolean {
  if (!baselineValues) return false

  for (const field of fields) {
    const rawInput = values[field.key].trim()
    if (rawInput === '') continue
    const baselineValue = baselineValues[field.key]
    if (baselineValue === undefined) continue
    if (errors?.[field.key]) return true
    if (field.kind === 'bool') {
      const boolValue = rawInput === 'true'
      if (boolValue !== baselineValue) return true
    } else {
      const parsed = Number(rawInput)
      if (!Number.isFinite(parsed)) return true
      if (parsed !== baselineValue) return true
    }
  }
  return false
}

const RETRIEVAL_GROUPS = {
  similarity: {
    label: 'Similarity thresholds',
    description: 'Drop low-scoring matches before ranking.'
  },
  context: {
    label: 'Context limits',
    description: 'Cap the injected context size.'
  },
  ranking: {
    label: 'Ranking weights',
    description: 'Balance relevance, diversity, and usage boosts.'
  },
  haiku: {
    label: 'Haiku query generation',
    description: 'Use Haiku to resolve context-dependent queries.'
  },
  query: {
    label: 'Query limits',
    description: 'Limit keyword and semantic query construction.'
  },
  timeouts: {
    label: 'Timeouts',
    description: 'Abort slow pre-prompt steps.'
  }
} as const

export const RETRIEVAL_FIELDS: SettingsField<keyof RetrievalSettings>[] = [
  {
    key: 'minSemanticSimilarity',
    label: 'Min semantic similarity',
    description: 'Drop semantic matches below this cosine similarity.',
    step: 0.01,
    min: 0,
    max: 1,
    kind: 'float',
    group: RETRIEVAL_GROUPS.similarity
  },
  {
    key: 'minScore',
    label: 'Min hybrid score',
    description: 'Threshold for non-keyword matches in hybrid retrieval.',
    step: 0.01,
    min: 0,
    max: 1,
    kind: 'float',
    group: RETRIEVAL_GROUPS.similarity
  },
  {
    key: 'minSemanticOnlyScore',
    label: 'Min semantic-only score',
    description: 'Score cutoff when only semantic search is used.',
    step: 0.01,
    min: 0,
    max: 1,
    kind: 'float',
    group: RETRIEVAL_GROUPS.similarity
  },
  {
    key: 'maxRecords',
    label: 'Max records',
    description: 'Maximum memories injected per prompt.',
    step: 1,
    min: 1,
    max: 20,
    kind: 'int',
    group: RETRIEVAL_GROUPS.context
  },
  {
    key: 'maxTokens',
    label: 'Max tokens',
    description: 'Token budget for the injected context block.',
    step: 50,
    min: 1,
    max: 10000,
    kind: 'int',
    group: RETRIEVAL_GROUPS.context
  },
  {
    key: 'mmrLambda',
    label: 'MMR lambda',
    description: 'Balance relevance vs. diversity (1.0 = relevance).',
    step: 0.01,
    min: 0,
    max: 1,
    kind: 'float',
    group: RETRIEVAL_GROUPS.ranking
  },
  {
    key: 'usageRatioWeight',
    label: 'Usage ratio weight',
    description: 'Boost memories with high usefulness ratings.',
    step: 0.01,
    min: 0,
    max: 1,
    kind: 'float',
    group: RETRIEVAL_GROUPS.ranking
  },
  {
    key: 'enableHaikuRetrieval',
    label: 'Enable Haiku retrieval',
    description: 'Use Haiku to analyze conversation context and generate better queries.',
    kind: 'bool',
    group: RETRIEVAL_GROUPS.haiku
  },
  {
    key: 'maxKeywordQueries',
    label: 'Max keyword queries',
    description: 'Maximum keyword queries generated per retrieval.',
    step: 1,
    min: 1,
    kind: 'int',
    group: RETRIEVAL_GROUPS.query
  },
  {
    key: 'maxKeywordErrors',
    label: 'Max keyword errors',
    description: 'Max error patterns included as keyword queries.',
    step: 1,
    min: 1,
    kind: 'int',
    group: RETRIEVAL_GROUPS.query
  },
  {
    key: 'maxKeywordCommands',
    label: 'Max keyword commands',
    description: 'Max commands included as keyword queries.',
    step: 1,
    min: 1,
    kind: 'int',
    group: RETRIEVAL_GROUPS.query
  },
  {
    key: 'maxSemanticQueryChars',
    label: 'Max semantic query chars',
    description: 'Max characters allowed in the semantic query.',
    step: 50,
    min: 1,
    kind: 'int',
    group: RETRIEVAL_GROUPS.query
  },
  {
    key: 'prePromptTimeoutMs',
    label: 'Pre-prompt timeout (ms)',
    description: 'Timeout for the entire pre-prompt hook.',
    step: 100,
    min: 1,
    kind: 'int',
    group: RETRIEVAL_GROUPS.timeouts
  },
  {
    key: 'haikuQueryTimeoutMs',
    label: 'Haiku query timeout (ms)',
    description: 'Timeout for Haiku query generation.',
    step: 100,
    min: 1,
    kind: 'int',
    group: RETRIEVAL_GROUPS.timeouts
  }
]

type FieldValidation = { value?: number | boolean; error?: string }

export function validateFieldValue(field: SettingsField, rawInput: string): FieldValidation {
  if (field.kind === 'bool') {
    return { value: rawInput === 'true' }
  }

  const parsed = Number(rawInput)
  if (!Number.isFinite(parsed)) {
    return { error: 'Enter a number.' }
  }

  if (field.kind === 'int' && !Number.isInteger(parsed)) {
    return { error: 'Must be a whole number.' }
  }

  const value = parsed
  if (field.min !== undefined && field.max !== undefined) {
    if (value < field.min || value > field.max) {
      return { error: `Must be between ${field.min} and ${field.max}.` }
    }
  } else if (field.min !== undefined && value < field.min) {
    return { error: `Must be >= ${field.min}.` }
  } else if (field.max !== undefined && value > field.max) {
    return { error: `Must be <= ${field.max}.` }
  }

  return { value }
}

function clampValue(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export function toFormState(settings: Partial<RetrievalSettings> | null): RetrievalSettingsFormState {
  return RETRIEVAL_FIELDS.reduce((acc, field) => {
    const value = settings?.[field.key]
    if (typeof value === 'number') {
      acc[field.key] = String(value)
    } else if (typeof value === 'boolean') {
      acc[field.key] = String(value)
    } else {
      acc[field.key] = ''
    }
    return acc
  }, {} as RetrievalSettingsFormState)
}

export function parseFormState(
  state: RetrievalSettingsFormState,
  options: { requireAll?: boolean } = {}
): { values: Partial<RetrievalSettings>; errors: RetrievalSettingsErrors; isValid: boolean } {
  const values: Partial<RetrievalSettings> = {}
  const errors: RetrievalSettingsErrors = {}
  const requireAll = options.requireAll ?? false

  for (const field of RETRIEVAL_FIELDS) {
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
      ;(values as Record<string, number | boolean>)[field.key] = value
    }
  }

  const isValid = Object.keys(errors).length === 0
    && (!requireAll || Object.keys(values).length === RETRIEVAL_FIELDS.length)

  return { values, errors, isValid }
}

export function buildSettingsOverride(
  state: RetrievalSettingsFormState,
  base: RetrievalSettings
): {
  override?: Partial<RetrievalSettings>
  errors: RetrievalSettingsErrors
  hasOverride: boolean
  isDirty: boolean
  values: Partial<RetrievalSettings>
} {
  const { values, errors } = parseFormState(state)
  const override: Partial<RetrievalSettings> = {}
  let hasOverride = false
  let isDirty = false

  for (const field of RETRIEVAL_FIELDS) {
    const key = field.key
    const rawValue = state[key]
    if (rawValue !== String(base[key])) {
      isDirty = true
    }
    const value = values[key]
    if (value === undefined) continue
    if (value !== base[key]) {
      ;(override as Record<string, number | boolean>)[key] = value
      hasOverride = true
    }
  }

  return {
    override: hasOverride ? override : undefined,
    errors,
    hasOverride,
    isDirty,
    values
  }
}

export interface SettingsPanelProps<K extends string = string> {
  fields: SettingsField<K>[]
  values: SettingsFormState<K>
  onChange: (key: K, value: string) => void
  savedValues?: Partial<Record<K, number | boolean>>
  defaultValues?: Partial<Record<K, number | boolean>>
  onSave?: () => void
  onReset?: () => void
  isSaving?: boolean
  saveDisabled?: boolean
  resetDisabled?: boolean
  saveLabel?: string
  errors?: SettingsErrors<K>
  collapsible?: boolean
  defaultOpen?: boolean
  title?: string
  description?: string
  variant?: 'full' | 'compact'
  size?: 'default' | 'sm'
  showDefaults?: boolean
  showModifiedBadge?: boolean
  showFieldModified?: boolean
  gridClassName?: string
  containerClassName?: string
  disabled?: boolean
  status?: { type: 'success' | 'error'; text: string } | null
}

export function SettingsPanel<K extends string>({
  fields,
  values,
  onChange,
  savedValues,
  defaultValues,
  onSave,
  onReset,
  isSaving = false,
  saveDisabled = false,
  resetDisabled = false,
  saveLabel = 'Save settings',
  errors,
  collapsible = false,
  defaultOpen = false,
  title,
  description,
  variant = 'compact',
  showDefaults,
  showModifiedBadge,
  showFieldModified,
  gridClassName,
  containerClassName,
  disabled = false,
  status,
  size = 'default'
}: SettingsPanelProps<K>) {
  const [open, setOpen] = useState(defaultOpen)
  const isOpen = collapsible ? open : true
  const showActions = Boolean(onSave || onReset)
  const shouldShowDefaults = showDefaults ?? variant === 'full'
  const shouldShowModifiedBadge = showModifiedBadge ?? collapsible
  const shouldShowFieldModified = showFieldModified ?? variant === 'compact'
  const showHeader = Boolean(title || description)

  const collapsibleContainerClasses = `rounded-xl border border-border ${
    size === 'sm' ? 'bg-background/40' : 'bg-card'
  }`
  const containerClasses = containerClassName
    ?? (collapsible
      ? collapsibleContainerClasses
      : (variant === 'compact' ? 'rounded-xl border border-border bg-card' : 'space-y-6'))
  const gridClasses = gridClassName
    ?? (variant === 'compact' ? 'grid gap-4 md:grid-cols-2 lg:grid-cols-3' : 'grid gap-5 md:grid-cols-2')

  const headerTitleClass = variant === 'compact' ? 'font-medium text-sm' : 'text-sm font-semibold'
  const headerDescriptionClass = variant === 'compact' ? 'text-xs text-muted-foreground' : 'text-xs text-muted-foreground'
  const fieldLabelClass = variant === 'compact' ? 'block text-xs font-medium' : 'block text-sm font-medium'
  const fieldDescriptionClass = variant === 'compact'
    ? 'text-[10px] text-muted-foreground leading-tight'
    : 'text-xs text-muted-foreground'
  const fieldContainerClass = variant === 'compact' ? 'space-y-1' : 'space-y-2'
  const groupTitleClass = 'section-header'
  const groupDescriptionClass = variant === 'compact'
    ? 'text-[10px] text-muted-foreground leading-tight'
    : 'text-xs text-muted-foreground'
  const valueInputBaseClass = variant === 'compact'
    ? 'h-7 w-[72px] px-2 rounded-md border border-border bg-background text-xs font-mono tabular-nums text-right focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-60'
    : 'h-8 w-[90px] px-2 rounded-md border border-border bg-background text-sm font-mono tabular-nums text-right focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-60'
  const valueButtonBaseClass = variant === 'compact'
    ? 'h-7 min-w-[72px] px-2 rounded-md border border-border bg-background/60 text-xs font-mono tabular-nums text-right hover:bg-secondary/60 transition-base disabled:opacity-60'
    : 'h-8 min-w-[90px] px-2 rounded-md border border-border bg-background/60 text-sm font-mono tabular-nums text-right hover:bg-secondary/60 transition-base disabled:opacity-60'
  const sliderRowClass = variant === 'compact' ? 'flex items-center gap-3' : 'flex items-center gap-4'
  const sliderClass = 'range-slider'
  const resetButtonClass = variant === 'compact'
    ? 'ml-auto inline-flex h-6 w-6 items-center justify-center rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-base disabled:opacity-40'
    : 'ml-auto inline-flex h-7 w-7 items-center justify-center rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-base disabled:opacity-40'
  const errorTextClass = variant === 'compact' ? 'text-[10px] text-destructive' : 'text-xs text-destructive'
  const [editingField, setEditingField] = useState<K | null>(null)
  const contentPaddingClass = collapsible
    ? (size === 'sm' ? 'px-4 pb-4' : 'px-6 pb-6')
    : (variant === 'compact' ? 'px-6 pb-6' : undefined)
  const contentClass = cn(
    contentPaddingClass,
    variant === 'compact' ? 'space-y-5' : 'space-y-6'
  )
  const headerButtonClass = cn(
    'w-full flex items-center gap-3 text-left',
    size === 'sm' ? 'px-4 py-3' : 'px-6 py-4'
  )

  const modified = useMemo(() => {
    if (!shouldShowModifiedBadge) return false
    return isSettingsModified({
      fields,
      values,
      baselineValues: savedValues,
      errors
    })
  }, [errors, fields, savedValues, shouldShowModifiedBadge, values])

  const renderField = (field: SettingsField<K>) => {
    const key = field.key
    const savedValue = savedValues?.[key]
    const defaultValue = defaultValues?.[key]
    const formValue = values[key] ?? ''

    // Handle boolean fields with a toggle
    if (field.kind === 'bool') {
      const isChecked = formValue === 'true'
      const savedBool = savedValue === true
      const defaultBool = defaultValue === true
      const isModified = shouldShowFieldModified && savedValue !== undefined && isChecked !== savedBool
      const fieldId = `settings-field-${key}`
      const labelId = `${fieldId}-label`

      return (
        <div key={field.key} className={fieldContainerClass}>
          <div>
            <div className="flex items-center gap-2">
              <label className={fieldLabelClass} id={labelId}>{field.label}</label>
              {isModified && <ModifiedBadge variant="field" />}
              {savedValue !== undefined && isChecked !== savedBool && (
                <button
                  type="button"
                  onClick={() => onChange(key, String(savedBool))}
                  disabled={disabled}
                  className={resetButtonClass}
                  aria-label={`Reset ${field.label} to ${savedBool ? 'enabled' : 'disabled'}`}
                  title="Reset to saved"
                >
                  <RotateCcw className={variant === 'compact' ? 'w-3 h-3' : 'w-3.5 h-3.5'} />
                </button>
              )}
            </div>
            <p className={fieldDescriptionClass}>{field.description}</p>
            {shouldShowDefaults && (
              <p className="text-xs text-muted-foreground">Default: {defaultBool ? 'On' : 'Off'}</p>
            )}
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={isChecked}
            aria-labelledby={labelId}
            onClick={() => onChange(key, String(!isChecked))}
            disabled={disabled}
            className={cn(
              'relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
              isChecked ? 'bg-primary' : 'bg-muted',
              disabled && 'opacity-50 cursor-not-allowed'
            )}
          >
            <span
              className={cn(
                'pointer-events-none inline-block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform',
                isChecked ? 'translate-x-5' : 'translate-x-0'
              )}
            />
          </button>
        </div>
      )
    }

    const trimmedValue = formValue.trim()
    const fieldError = errors?.[key]
    const valueInputClassName = fieldError
      ? `${valueInputBaseClass} border-destructive focus:ring-destructive`
      : valueInputBaseClass
    const valueButtonClassName = fieldError
      ? `${valueButtonBaseClass} border-destructive text-destructive`
      : valueButtonBaseClass

    const parsedValue = Number(trimmedValue)
    const hasNumericValue = trimmedValue !== '' && Number.isFinite(parsedValue)
    const baseResetValue = defaultValue ?? savedValue
    const baseResetNum = typeof baseResetValue === 'number' && Number.isFinite(baseResetValue) ? baseResetValue : undefined
    const rangeMin = field.min ?? 0
    const fallbackValue = baseResetNum ?? rangeMin
    const baselineForMax = Math.max(
      rangeMin,
      baseResetNum ?? rangeMin,
      hasNumericValue ? parsedValue : rangeMin
    )
    const step = field.step ?? 1
    const inferredMax = field.max ?? Math.max(
      rangeMin + step * 100,
      baselineForMax + step * 100
    )
    let rangeMax = inferredMax <= rangeMin ? rangeMin + step * 100 : inferredMax
    if (field.max === undefined && hasNumericValue && parsedValue > rangeMax) {
      rangeMax = parsedValue
    }
    const sliderValueSource = !fieldError && hasNumericValue ? parsedValue : fallbackValue
    const sliderValue = clampValue(sliderValueSource, rangeMin, rangeMax)
    const displayValue = trimmedValue !== '' ? formValue : '—'
    const isEditing = editingField === key
    const isResetAvailable = baseResetValue !== undefined
      && (trimmedValue === '' || !Number.isFinite(parsedValue) || parsedValue !== baseResetValue)
    const fieldId = `settings-field-${key}`
    const labelId = `${fieldId}-label`
    const sliderId = `${fieldId}-slider`
    const errorId = fieldError ? `${fieldId}-error` : undefined
    const describedBy = fieldError ? errorId : undefined
    const formatResetValue = (value: number) => (field.kind === 'int' ? String(Math.trunc(value)) : String(value))
    const resetContextLabel = defaultValue !== undefined
      ? 'Reset to default'
      : savedValue !== undefined
        ? 'Reset to saved'
        : 'Reset'
    const resetActionLabel = baseResetNum !== undefined
      ? `${resetContextLabel} (${formatResetValue(baseResetNum)})`
      : resetContextLabel

    let isFieldModified = false
    if (shouldShowFieldModified && trimmedValue !== '' && savedValue !== undefined) {
      const parsed = Number(trimmedValue)
      if (Number.isFinite(parsed)) {
        isFieldModified = parsed !== savedValue
      } else {
        isFieldModified = true
      }
    }

    return (
      <div key={field.key} className={fieldContainerClass}>
        <div>
          <div className="flex items-center gap-2">
            <label className={fieldLabelClass} htmlFor={sliderId} id={labelId}>{field.label}</label>
            {isFieldModified && (
              <ModifiedBadge variant="field" />
            )}
            {isResetAvailable && (
              <button
                type="button"
                onClick={() => {
                  const resetValue = typeof baseResetValue === 'number' ? baseResetValue : 0
                  onChange(key, field.kind === 'int' ? String(Math.trunc(resetValue)) : String(resetValue))
                  setEditingField(null)
                }}
                disabled={disabled}
                className={resetButtonClass}
                aria-label={`${resetActionLabel} for ${field.label}`}
                title={resetActionLabel}
              >
                <RotateCcw className={variant === 'compact' ? 'w-3 h-3' : 'w-3.5 h-3.5'} />
              </button>
            )}
          </div>
          <p className={fieldDescriptionClass}>{field.description}</p>
          {shouldShowDefaults && (
            <p className="text-xs text-muted-foreground">Default: {defaultValue ?? '—'}</p>
          )}
        </div>
        <div className={sliderRowClass}>
          <input
            type="range"
            id={sliderId}
            value={sliderValue}
            onChange={e => onChange(key, e.target.value)}
            step={step}
            min={rangeMin}
            max={rangeMax}
            disabled={disabled}
            aria-invalid={fieldError ? 'true' : undefined}
            aria-labelledby={labelId}
            aria-describedby={describedBy}
            className={sliderClass}
          />
          {isEditing ? (
            <input
              type="number"
              value={formValue}
              onChange={e => onChange(key, e.target.value)}
              onFocus={event => event.currentTarget.select()}
              onBlur={() => setEditingField(null)}
              onKeyDown={event => {
                if (event.key === 'Enter' || event.key === 'Escape') {
                  event.currentTarget.blur()
                }
              }}
              step={step}
              min={field.min}
              max={field.max}
              disabled={disabled}
              aria-invalid={fieldError ? 'true' : undefined}
              aria-labelledby={labelId}
              aria-describedby={describedBy}
              className={valueInputClassName}
              autoFocus
            />
          ) : (
            <button
              type="button"
              onClick={() => setEditingField(key)}
              disabled={disabled}
              className={valueButtonClassName}
              aria-label={`Edit ${field.label} value`}
              title="Click to edit"
            >
              {displayValue}
            </button>
          )}
        </div>
        {fieldError && (
          <div className={errorTextClass} id={errorId}>{fieldError}</div>
        )}
      </div>
    )
  }

  const fieldNodes: ReactElement[] = []
  let lastGroupLabel: string | undefined
  let groupIndex = 0

  for (const field of fields) {
    const groupLabel = field.group?.label
    if (groupLabel && groupLabel !== lastGroupLabel) {
      groupIndex += 1
      fieldNodes.push(
        <div
          key={`settings-group-${groupIndex}-${groupLabel}`}
          className={cn(
            'col-span-full space-y-1',
            groupIndex > 1 ? (variant === 'compact' ? 'pt-2' : 'pt-3') : ''
          )}
        >
          <div className={groupTitleClass}>{groupLabel}</div>
          {field.group?.description && (
            <div className={groupDescriptionClass}>{field.group.description}</div>
          )}
        </div>
      )
    }
    lastGroupLabel = groupLabel
    fieldNodes.push(renderField(field))
  }

  const actions = showActions ? (
    <div className={variant === 'compact'
      ? 'flex flex-wrap items-center gap-3 pt-2 border-t border-border'
      : 'flex flex-wrap items-center gap-3'}>
      {onSave && (
        <button
          onClick={onSave}
          disabled={saveDisabled}
          className={variant === 'compact'
            ? 'flex items-center gap-2 h-8 px-3 rounded-md bg-foreground text-background text-xs font-medium disabled:opacity-50 hover:bg-foreground/90 transition-base'
            : 'flex items-center gap-2 h-9 px-4 rounded-md bg-foreground text-background text-sm font-medium disabled:opacity-50 hover:bg-foreground/90 transition-base'}
        >
          {isSaving ? <ButtonSpinner size="sm" /> : <Save className={variant === 'compact' ? 'w-3 h-3' : 'w-4 h-4'} />}
          {isSaving ? 'Saving...' : saveLabel}
        </button>
      )}
      {onReset && (
        <button
          onClick={onReset}
          disabled={resetDisabled}
          className={variant === 'compact'
            ? 'flex items-center gap-2 h-8 px-3 rounded-md border border-border text-xs font-medium text-foreground hover:bg-secondary/60 transition-base disabled:opacity-50'
            : 'flex items-center gap-2 h-9 px-4 rounded-md border border-border text-sm font-medium text-foreground hover:bg-secondary/60 transition-base disabled:opacity-50'}
        >
          <RotateCcw className={variant === 'compact' ? 'w-3 h-3' : 'w-4 h-4'} />
          Reset
        </button>
      )}
      {status && (
        <div className={`${variant === 'compact' ? 'text-xs' : 'text-sm'} ${status.type === 'success' ? 'text-emerald-400' : 'text-destructive'}`}>
          {status.text}
        </div>
      )}
    </div>
  ) : null

  const content = (
    <div className={contentClass}>
      <div className={gridClasses}>
        {fieldNodes}
      </div>
      {actions}
    </div>
  )

  if (collapsible) {
    return (
      <div className={containerClasses}>
        <button
          onClick={() => setOpen(prev => !prev)}
          className={headerButtonClass}
        >
          {isOpen ? (
            <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
          ) : (
            <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className={headerTitleClass}>{title}</span>
              {shouldShowModifiedBadge && modified && (
                <ModifiedBadge variant="header" />
              )}
            </div>
            {description && (
              <div className={headerDescriptionClass}>{description}</div>
            )}
          </div>
        </button>

        <div className={`accordion-content ${isOpen ? 'open' : ''}`}>
          <div className="accordion-inner">
            {content}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={containerClasses}>
      {showHeader && (
        <div>
          {title && (
            <div className="flex items-center gap-2">
              <div className={headerTitleClass}>{title}</div>
              {shouldShowModifiedBadge && modified && (
                <ModifiedBadge variant="header" />
              )}
            </div>
          )}
          {description && <p className={headerDescriptionClass}>{description}</p>}
        </div>
      )}
      {content}
    </div>
  )
}
