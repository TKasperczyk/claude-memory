import { SettingsPanel } from '@/components/SettingsPanel'
import { MODEL_FIELDS } from '../../../../src/lib/settings-schema.js'
import type { Settings } from '@/lib/api'

export default function ModelSettingsSection({
  values,
  errors,
  onChange,
  defaultSettings,
  disabled
}: {
  values: Record<keyof Settings, string>
  errors: Partial<Record<keyof Settings, string>>
  onChange: (key: keyof Settings, value: string) => void
  defaultSettings: Settings | null
  disabled: boolean
}) {
  return (
    <div className="p-5 rounded-xl border border-border bg-card space-y-5">
      <div>
        <div className="text-sm font-semibold text-foreground/95">AI models</div>
        <p className="text-xs text-muted-foreground/70 mt-1">
          Choose which model to use for each system role.
        </p>
      </div>

      <SettingsPanel
        fields={MODEL_FIELDS}
        variant="full"
        values={values}
        onChange={onChange}
        savedValues={(defaultSettings ?? undefined) as Settings | undefined}
        defaultValues={(defaultSettings ?? undefined) as Settings | undefined}
        errors={errors}
        showFieldModified
        disabled={disabled}
        gridClassName="flex flex-wrap gap-5 [&>div]:flex-1 [&>div]:min-w-[200px]"
      />
    </div>
  )
}
