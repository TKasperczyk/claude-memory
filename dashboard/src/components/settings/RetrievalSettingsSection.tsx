import { SettingsPanel, type RetrievalSettingsFormState } from '@/components/SettingsPanel'
import { RETRIEVAL_FIELDS } from '../../../src/lib/settings-schema.js'
import type { RetrievalSettings, Settings } from '@/lib/api'

export default function RetrievalSettingsSection({
  values,
  errors,
  onChange,
  defaultSettings,
  disabled,
  hasSettings,
  hasError,
  isPending
}: {
  values: RetrievalSettingsFormState
  errors: Partial<Record<keyof Settings, string>>
  onChange: (key: keyof Settings, value: string) => void
  defaultSettings: Settings | null
  disabled: boolean
  hasSettings: boolean
  hasError: boolean
  isPending: boolean
}) {
  return (
    <div className="p-5 rounded-xl border border-border bg-card space-y-5">
      <div className="text-[11px] text-muted-foreground/60 font-mono">
        Stored in ~/.claude-memory/settings.json
      </div>

      {hasError && (
        <div className="text-sm text-destructive">
          Failed to load settings. Showing defaults.
        </div>
      )}

      {isPending && !hasSettings && (
        <div className="text-sm text-muted-foreground/70">
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
        values={values}
        onChange={onChange}
        savedValues={(defaultSettings ?? undefined) as RetrievalSettings | undefined}
        defaultValues={(defaultSettings ?? undefined) as RetrievalSettings | undefined}
        errors={errors}
        showModifiedBadge
        showFieldModified
        disabled={disabled}
        gridClassName="grid gap-5 md:grid-cols-2"
        containerClassName="rounded-xl border border-border border-l-[3px] border-l-primary/50 bg-background/40"
      />
    </div>
  )
}
