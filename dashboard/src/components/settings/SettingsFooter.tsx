import { Loader2, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'

type Status = { type: 'saving' | 'success' | 'error'; text: string; context: 'save' | 'reset' }

export default function SettingsFooter({
  isPending,
  isResetting,
  isAutoSaving,
  status,
  statusFading,
  onReset,
  onRetry
}: {
  isPending: boolean
  isResetting: boolean
  isAutoSaving: boolean
  status: Status | null
  statusFading: boolean
  onReset: () => void
  onRetry: () => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 pb-4">
      <Button
        variant="outline"
        onClick={onReset}
        disabled={isPending || isResetting || isAutoSaving}
      >
        {isResetting ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4 text-muted-foreground" />}
        {isResetting ? 'Resetting...' : 'Reset to defaults'}
      </Button>

      {status && (
        <div
          className={`text-sm transition-opacity duration-300 ${statusFading ? 'opacity-0' : 'opacity-100'} ${
            status.type === 'error'
              ? 'text-destructive'
              : status.type === 'success'
                ? 'text-success'
                : 'text-muted-foreground/70'
          }`}
        >
          <span>{status.text}</span>
          {status.type === 'error' && status.context === 'save' && (
            <Button
              variant="link"
              size="xs"
              onClick={onRetry}
              className="ml-2 text-destructive"
            >
              Retry
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
