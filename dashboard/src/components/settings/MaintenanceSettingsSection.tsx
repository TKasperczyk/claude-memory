import { SettingsPanel } from '@/components/SettingsPanel'
import { MAINTENANCE_GROUPS } from '../../../../src/lib/settings-schema.js'
import type { Settings } from '@/lib/api'

export default function MaintenanceSettingsSection({
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
        <div className="text-sm font-semibold text-foreground/95">Maintenance settings</div>
        <p className="text-xs text-muted-foreground/70 mt-1">
          Configure cleanup, consolidation, and promotion behavior.
        </p>
      </div>

      <div className="space-y-4">
        {MAINTENANCE_GROUPS.map((group, index) => (
          <div key={group.id}>
            {index > 0 && <hr className="border-border/50 mb-4" />}
            <SettingsPanel
              collapsible
              size="sm"
              defaultOpen
              title={group.label}
              description={group.description}
              fields={group.fields.map(field => ({ ...field, group: undefined }))}
              values={values}
              onChange={onChange}
              savedValues={(defaultSettings ?? undefined) as Settings | undefined}
              defaultValues={(defaultSettings ?? undefined) as Settings | undefined}
              errors={errors}
              showFieldModified
              showModifiedBadge
              disabled={disabled}
              variant="full"
              containerClassName="rounded-xl border border-border border-l-[3px] border-l-primary/50 bg-background/40"
            />
          </div>
        ))}
      </div>
    </div>
  )
}
