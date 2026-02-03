import MaintenanceSettingsSection from '@/components/settings/MaintenanceSettingsSection'
import RetrievalSettingsSection from '@/components/settings/RetrievalSettingsSection'
import SettingsFooter from '@/components/settings/SettingsFooter'
import { useSettingsForm } from '@/hooks/useSettingsForm'

export default function Settings() {
  const {
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
    isResetting,
    handleFieldChange,
    handleReset,
    handleRetry,
    handleFocusCapture,
    handleBlurCapture
  } = useSettingsForm()

  return (
    <div className="flex-1 min-h-0 overflow-y-auto space-y-5" onFocusCapture={handleFocusCapture} onBlurCapture={handleBlurCapture}>
      <RetrievalSettingsSection
        values={retrievalForm}
        errors={formErrors}
        onChange={handleFieldChange}
        defaultSettings={defaultSettings}
        disabled={isPending}
        hasSettings={Boolean(settings)}
        hasError={Boolean(error)}
        isPending={isPending}
      />

      <MaintenanceSettingsSection
        values={form}
        errors={formErrors}
        onChange={handleFieldChange}
        defaultSettings={defaultSettings}
        disabled={isPending}
      />

      <SettingsFooter
        isPending={isPending}
        isResetting={isResetting}
        isAutoSaving={isAutoSaving}
        status={status}
        statusFading={statusFading}
        onReset={handleReset}
        onRetry={handleRetry}
      />
    </div>
  )
}
