import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import { ChevronDown, ChevronRight, Loader2, RotateCcw, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { type RetrievalSettings } from '@/lib/api'
import { RETRIEVAL_FIELDS, type SettingsGroupMeta } from '../../../src/lib/settings-schema.js'
import { cn } from '../lib/utils'

export type SettingsField<K extends string = string> = {
  key: K
  label: string
  description: string
  step?: number
  min?: number
  max?: number
  kind: 'float' | 'int' | 'bool' | 'text'
  group?: SettingsGroupMeta
  options?: Array<{ value: string; label: string }>
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
  const baseClass = 'text-[10px] rounded bg-primary/20 text-primary'
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
  baselineValues?: Partial<Record<K, number | boolean | string>>
  errors?: SettingsErrors<K>
}): boolean {
  if (!baselineValues) return false

  for (const field of fields) {
    const rawInput = values[field.key].trim()
    if (rawInput === '') continue
    const baselineValue = baselineValues[field.key]
    if (baselineValue === undefined) continue
    if (errors?.[field.key]) return true
    if (field.kind === 'text') {
      if (rawInput !== baselineValue) return true
    } else if (field.kind === 'bool') {
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


type FieldValidation = { value?: number | boolean | string; error?: string }

export function validateFieldValue(field: SettingsField, rawInput: string): FieldValidation {
  if (field.kind === 'text') {
    const trimmed = rawInput.trim()
    if (!trimmed) return { error: 'Required.' }
    return { value: trimmed }
  }

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
    } else if (typeof value === 'string') {
      acc[field.key] = value
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
      ;(values as Record<string, number | boolean | string>)[field.key] = value
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
      ;(override as Record<string, number | boolean | string>)[key] = value
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
  savedValues?: Partial<Record<K, number | boolean | string>>
  defaultValues?: Partial<Record<K, number | boolean | string>>
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

const CUSTOM_OPTION_VALUE = '__custom__'

function TextSettingField<K extends string>({
  field,
  formValue,
  savedValue,
  defaultValue,
  onChange,
  disabled,
  shouldShowFieldModified,
  shouldShowDefaults,
  fieldContainerClass,
  fieldLabelClass,
  fieldDescriptionClass,
  resetButtonClass,
  errorTextClass,
  variant,
  error
}: {
  field: SettingsField<K>
  formValue: string
  savedValue?: string
  defaultValue?: string
  onChange: (key: K, value: string) => void
  disabled: boolean
  shouldShowFieldModified: boolean
  shouldShowDefaults: boolean
  fieldContainerClass: string
  fieldLabelClass: string
  fieldDescriptionClass: string
  resetButtonClass: string
  errorTextClass: string
  variant: 'full' | 'compact'
  error?: string
}) {
  const options = field.options ?? []
  const matchesOption = options.some(opt => opt.value === formValue)
  const [showCustom, setShowCustom] = useState(!matchesOption && formValue !== '')
  // Sync showCustom when formValue changes externally (reset, server sync)
  useEffect(() => {
    const matches = options.some(opt => opt.value === formValue)
    if (matches && showCustom) setShowCustom(false)
    else if (!matches && formValue !== '' && !showCustom) setShowCustom(true)
  }, [formValue, options, showCustom])
  const isModified = shouldShowFieldModified && savedValue !== undefined && formValue !== savedValue
  const baseResetValue = defaultValue ?? savedValue
  const isResetAvailable = baseResetValue !== undefined && formValue !== baseResetValue

  const handleSelectChange = useCallback((selected: string) => {
    if (selected === CUSTOM_OPTION_VALUE) {
      setShowCustom(true)
      onChange(field.key, '')
    } else {
      setShowCustom(false)
      onChange(field.key, selected)
    }
  }, [field.key, onChange])

  const handleCustomChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    onChange(field.key, e.target.value)
  }, [field.key, onChange])

  const handleReset = useCallback(() => {
    if (!baseResetValue) return
    const matchesOpt = options.some(opt => opt.value === baseResetValue)
    setShowCustom(!matchesOpt)
    onChange(field.key, baseResetValue)
  }, [baseResetValue, field.key, onChange, options])

  const selectValue = showCustom ? CUSTOM_OPTION_VALUE : formValue

  const triggerClass = variant === 'compact' ? 'h-7 text-xs' : 'h-8 text-sm'
  const fieldId = `settings-field-${field.key}`
  const labelId = `${fieldId}-label`

  return (
    <div className={fieldContainerClass}>
      <div>
        <div className="flex items-center gap-2">
          <label className={fieldLabelClass} id={labelId}>{field.label}</label>
          {isModified && <ModifiedBadge variant="field" />}
          {isResetAvailable && (
            <button
              type="button"
              onClick={handleReset}
              disabled={disabled}
              className={resetButtonClass}
              aria-label={`Reset ${field.label}`}
              title="Reset to default"
            >
              <RotateCcw className={variant === 'compact' ? 'w-3 h-3' : 'w-3.5 h-3.5'} />
            </button>
          )}
        </div>
        <p className={fieldDescriptionClass}>{field.description}</p>
        {shouldShowDefaults && defaultValue && (
          <p className="text-xs text-muted-foreground">Default: {options.find(o => o.value === defaultValue)?.label ?? defaultValue}</p>
        )}
      </div>
      <Select value={selectValue} onValueChange={handleSelectChange} disabled={disabled}>
        <SelectTrigger id={fieldId} aria-labelledby={labelId} className={cn(triggerClass, error && 'ring-1 ring-destructive')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map(opt => (
            <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
          ))}
          <SelectItem value={CUSTOM_OPTION_VALUE}>Custom...</SelectItem>
        </SelectContent>
      </Select>
      {showCustom && (
        <Input
          type="text"
          value={formValue}
          onChange={handleCustomChange}
          placeholder="Enter model ID..."
          disabled={disabled}
          aria-labelledby={labelId}
          className={cn(
            'mt-1.5 font-mono',
            variant === 'compact' ? 'h-7 text-xs' : 'h-8 text-sm',
            error && 'ring-1 ring-destructive'
          )}
        />
      )}
      {error && (
        <div className={errorTextClass}>{error}</div>
      )}
    </div>
  )
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

  const headerTitleClass = variant === 'compact' ? 'font-medium text-sm' : 'text-base font-semibold'
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

    // Handle text fields with select/custom input
    if (field.kind === 'text') {
      return (
        <TextSettingField
          key={key}
          field={field}
          formValue={formValue}
          savedValue={typeof savedValue === 'string' ? savedValue : undefined}
          defaultValue={typeof defaultValue === 'string' ? defaultValue : undefined}
          onChange={onChange}
          disabled={disabled}
          shouldShowFieldModified={shouldShowFieldModified}
          shouldShowDefaults={shouldShowDefaults}
          fieldContainerClass={fieldContainerClass}
          fieldLabelClass={fieldLabelClass}
          fieldDescriptionClass={fieldDescriptionClass}
          resetButtonClass={resetButtonClass}
          errorTextClass={errorTextClass}
          variant={variant}
          error={errors?.[key]}
        />
      )
    }

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
          <Switch
            id={fieldId}
            checked={isChecked}
            onCheckedChange={(checked) => onChange(key, String(checked))}
            aria-labelledby={labelId}
            disabled={disabled}
          />
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
            <Input
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
        <Button
          size={variant === 'compact' ? 'sm' : 'default'}
          onClick={onSave}
          disabled={saveDisabled}
        >
          {isSaving ? <Loader2 className={variant === 'compact' ? 'w-3 h-3 animate-spin' : 'w-4 h-4 animate-spin'} /> : <Save className={variant === 'compact' ? 'w-3 h-3' : 'w-4 h-4'} />}
          {isSaving ? 'Saving...' : saveLabel}
        </Button>
      )}
      {onReset && (
        <Button
          variant="outline"
          size={variant === 'compact' ? 'sm' : 'default'}
          onClick={onReset}
          disabled={resetDisabled}
        >
          <RotateCcw className={variant === 'compact' ? 'w-3 h-3' : 'w-4 h-4'} />
          Reset
        </Button>
      )}
      {status && (
        <div className={`${variant === 'compact' ? 'text-xs' : 'text-sm'} ${status.type === 'success' ? 'text-success' : 'text-destructive'}`}>
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
