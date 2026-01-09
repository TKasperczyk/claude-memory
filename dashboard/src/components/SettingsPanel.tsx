import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, RotateCcw, Save } from 'lucide-react'
import ButtonSpinner from '@/components/ButtonSpinner'
import { type RetrievalSettings } from '@/lib/api'

export type SettingsField<K extends string = string> = {
  key: K
  label: string
  description: string
  step: number
  min?: number
  max?: number
  kind: 'float' | 'int'
}

export type SettingsFormState<K extends string = string> = Record<K, string>
export type SettingsErrors<K extends string = string> = Partial<Record<K, string>>

export type RetrievalSettingsFormState = SettingsFormState<keyof RetrievalSettings>
export type RetrievalSettingsErrors = SettingsErrors<keyof RetrievalSettings>

export const RETRIEVAL_FIELDS: SettingsField<keyof RetrievalSettings>[] = [
  {
    key: 'minSemanticSimilarity',
    label: 'Min semantic similarity',
    description: 'Drop semantic matches below this cosine similarity.',
    step: 0.01,
    min: 0,
    max: 1,
    kind: 'float'
  },
  {
    key: 'minScore',
    label: 'Min hybrid score',
    description: 'Threshold for non-keyword matches in hybrid retrieval.',
    step: 0.01,
    min: 0,
    max: 1,
    kind: 'float'
  },
  {
    key: 'minSemanticOnlyScore',
    label: 'Min semantic-only score',
    description: 'Score cutoff when only semantic search is used.',
    step: 0.01,
    min: 0,
    max: 1,
    kind: 'float'
  },
  {
    key: 'maxRecords',
    label: 'Max records',
    description: 'Maximum memories injected per prompt.',
    step: 1,
    min: 1,
    kind: 'int'
  },
  {
    key: 'maxTokens',
    label: 'Max tokens',
    description: 'Token budget for the injected context block.',
    step: 50,
    min: 1,
    kind: 'int'
  },
  {
    key: 'mmrLambda',
    label: 'MMR lambda',
    description: 'Balance relevance vs. diversity (1.0 = relevance).',
    step: 0.01,
    min: 0,
    max: 1,
    kind: 'float'
  },
  {
    key: 'usageRatioWeight',
    label: 'Usage ratio weight',
    description: 'Boost memories with high usefulness ratings.',
    step: 0.01,
    min: 0,
    max: 1,
    kind: 'float'
  }
]

type FieldValidation = { value?: number; error?: string }

function validateFieldValue(field: SettingsField, rawInput: string): FieldValidation {
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

export function toFormState(settings: Partial<RetrievalSettings> | null): RetrievalSettingsFormState {
  return RETRIEVAL_FIELDS.reduce((acc, field) => {
    const value = settings?.[field.key]
    acc[field.key] = typeof value === 'number' ? String(value) : ''
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
      values[field.key] = value
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
      override[key] = value
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
  savedValues?: Partial<Record<K, number>>
  defaultValues?: Partial<Record<K, number>>
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
  status
}: SettingsPanelProps<K>) {
  const [open, setOpen] = useState(defaultOpen)
  const isOpen = collapsible ? open : true
  const showActions = Boolean(onSave || onReset)
  const shouldShowDefaults = showDefaults ?? variant === 'full'
  const shouldShowModifiedBadge = showModifiedBadge ?? collapsible
  const shouldShowFieldModified = showFieldModified ?? variant === 'compact'
  const showHeader = Boolean(title || description)

  const containerClasses = containerClassName
    ?? (variant === 'compact' ? 'rounded-xl border border-border bg-card' : 'space-y-6')
  const gridClasses = gridClassName
    ?? (variant === 'compact' ? 'grid gap-4 md:grid-cols-2 lg:grid-cols-3' : 'grid gap-5 md:grid-cols-2')

  const headerTitleClass = variant === 'compact' ? 'font-medium text-sm' : 'text-sm font-semibold'
  const headerDescriptionClass = variant === 'compact' ? 'text-xs text-muted-foreground' : 'text-xs text-muted-foreground'
  const fieldLabelClass = variant === 'compact' ? 'block text-xs font-medium' : 'block text-sm font-medium'
  const fieldDescriptionClass = variant === 'compact'
    ? 'text-[10px] text-muted-foreground leading-tight'
    : 'text-xs text-muted-foreground'
  const fieldContainerClass = variant === 'compact' ? 'space-y-1' : 'space-y-2'
  const inputBaseClass = variant === 'compact'
    ? 'w-full h-8 px-2 rounded-md border border-border bg-background text-xs focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-60'
    : 'w-full h-9 px-3 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-60'
  const errorTextClass = variant === 'compact' ? 'text-[10px] text-destructive' : 'text-xs text-destructive'

  const modified = useMemo(() => {
    if (!shouldShowModifiedBadge || !savedValues) return false
    for (const field of fields) {
      const rawInput = values[field.key].trim()
      if (rawInput === '') continue
      if (errors?.[field.key]) continue
      const parsed = Number(rawInput)
      if (!Number.isFinite(parsed)) continue
      const normalized = field.kind === 'int' ? Math.trunc(parsed) : parsed
      if (normalized !== savedValues[field.key]) {
        return true
      }
    }
    return false
  }, [errors, fields, savedValues, shouldShowModifiedBadge, values])

  const renderField = (field: SettingsField<K>) => {
    const key = field.key
    const savedValue = savedValues?.[key]
    const defaultValue = defaultValues?.[key]
    const formValue = values[key] ?? ''
    const fieldError = errors?.[key]
    const inputClassName = fieldError
      ? `${inputBaseClass} border-destructive focus:ring-destructive`
      : inputBaseClass

    let isFieldModified = false
    if (shouldShowFieldModified && formValue.trim() !== '' && savedValue !== undefined) {
      const parsed = Number(formValue)
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
            <label className={fieldLabelClass}>{field.label}</label>
            {isFieldModified && (
              <span className="px-1.5 py-0.5 text-[10px] rounded bg-amber-500/20 text-amber-400">Modified</span>
            )}
          </div>
          <p className={fieldDescriptionClass}>{field.description}</p>
          {shouldShowDefaults && (
            <p className="text-xs text-muted-foreground">Default: {defaultValue ?? '—'}</p>
          )}
        </div>
        <input
          type="number"
          value={formValue}
          onChange={e => onChange(key, e.target.value)}
          step={field.step}
          min={field.min}
          max={field.max}
          placeholder={variant === 'compact' && savedValue !== undefined ? String(savedValue) : undefined}
          disabled={disabled}
          aria-invalid={fieldError ? 'true' : undefined}
          className={inputClassName}
        />
        {fieldError && (
          <div className={errorTextClass}>{fieldError}</div>
        )}
      </div>
    )
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
    <div className={variant === 'compact' ? 'px-6 pb-6 space-y-5' : 'space-y-6'}>
      <div className={gridClasses}>
        {fields.map(renderField)}
      </div>
      {actions}
    </div>
  )

  if (collapsible) {
    return (
      <div className={containerClasses}>
        <button
          onClick={() => setOpen(prev => !prev)}
          className="w-full px-6 py-4 flex items-center gap-3 text-left"
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
                <span className="px-2 py-0.5 text-[10px] rounded bg-amber-500/20 text-amber-400 font-medium">
                  Modified
                </span>
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
          {title && <div className={headerTitleClass}>{title}</div>}
          {description && <p className={headerDescriptionClass}>{description}</p>}
        </div>
      )}
      {content}
    </div>
  )
}
