import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import type { MemoryRecord } from '@/lib/api'

interface MemoryDetailProps {
  record: MemoryRecord | null
  onClose: () => void
}

const TYPE_COLORS: Record<string, string> = {
  command: '#2dd4bf',
  error: '#f43f5e',
  discovery: '#60a5fa',
  procedure: '#a78bfa',
}

function formatDateTime(ts?: number): string {
  if (!ts) return '—'
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(ts)
}

function formatRelative(ts?: number): string {
  if (!ts) return '—'
  const diff = Date.now() - ts
  const mins = Math.floor(diff / 60000)
  const hours = Math.floor(mins / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days} day${days > 1 ? 's' : ''} ago`
  if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''} ago`
  if (mins > 0) return `${mins} minute${mins > 1 ? 's' : ''} ago`
  return 'just now'
}

function getTitle(record: MemoryRecord): string {
  switch (record.type) {
    case 'command': return record.command
    case 'error': return record.errorText
    case 'discovery': return record.what
    case 'procedure': return record.name
  }
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground mb-1">{label}</div>
      <div className="text-sm">{children}</div>
    </div>
  )
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="p-3 rounded-md bg-secondary text-sm font-mono overflow-x-auto">
      {children}
    </pre>
  )
}

function TypeDetails({ record }: { record: MemoryRecord }) {
  switch (record.type) {
    case 'command':
      return (
        <div className="space-y-4">
          <Field label="Command">
            <CodeBlock>{record.command}</CodeBlock>
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Exit code">
              <span className={record.exitCode === 0 ? 'text-green-400' : 'text-red-400'}>
                {record.exitCode}
              </span>
            </Field>
            <Field label="Outcome">{record.outcome}</Field>
          </div>
          {record.resolution && <Field label="Resolution">{record.resolution}</Field>}
          {record.truncatedOutput && (
            <Field label="Output">
              <CodeBlock>{record.truncatedOutput}</CodeBlock>
            </Field>
          )}
        </div>
      )

    case 'error':
      return (
        <div className="space-y-4">
          <Field label="Error">
            <CodeBlock>{record.errorText}</CodeBlock>
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Error type">{record.errorType}</Field>
            {record.cause && <Field label="Cause">{record.cause}</Field>}
          </div>
          <Field label="Resolution">{record.resolution}</Field>
        </div>
      )

    case 'discovery':
      return (
        <div className="space-y-4">
          <Field label="Discovery">{record.what}</Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Where">{record.where}</Field>
            <Field label="Confidence">{record.confidence}</Field>
          </div>
          <Field label="Evidence">{record.evidence}</Field>
        </div>
      )

    case 'procedure':
      return (
        <div className="space-y-4">
          <Field label="Procedure">{record.name}</Field>
          <Field label="Steps">
            <ol className="list-decimal list-inside space-y-1 text-sm">
              {record.steps.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ol>
          </Field>
          {record.prerequisites?.length ? (
            <Field label="Prerequisites">
              <ul className="list-disc list-inside space-y-1 text-sm">
                {record.prerequisites.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </Field>
          ) : null}
          {record.verification && <Field label="Verification">{record.verification}</Field>}
        </div>
      )
  }
}

export default function MemoryDetail({ record, onClose }: MemoryDetailProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!record) return

    const prevFocus = document.activeElement as HTMLElement | null
    closeRef.current?.focus()

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }

    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('keydown', handleKey)
      prevFocus?.focus()
    }
  }, [record, onClose])

  if (!record) return null

  const retrievals = record.retrievalCount ?? 0
  const usage = record.usageCount ?? 0
  const ratio = retrievals > 0 ? Math.round((usage / retrievals) * 100) : 0

  return (
    <div className="fixed inset-0 z-50">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />

      {/* Panel */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        className="absolute inset-y-0 right-0 w-full max-w-2xl bg-background border-l border-border flex flex-col"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 px-6 py-5 border-b border-border">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-2">
              <span
                className="w-2 h-2 rounded-full"
                style={{ backgroundColor: TYPE_COLORS[record.type] }}
              />
              <span className="text-xs text-muted-foreground capitalize">{record.type}</span>
              {record.deprecated && (
                <span className="text-xs text-destructive">Deprecated</span>
              )}
            </div>
            <h2 className="text-lg font-semibold truncate">{getTitle(record)}</h2>
            <p className="text-xs text-muted-foreground font-mono mt-1">{record.id}</p>
          </div>
          <button
            ref={closeRef}
            onClick={onClose}
            className="p-2 rounded-md hover:bg-secondary transition-base"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-6 space-y-6">
          {/* Metadata */}
          <div className="grid grid-cols-2 gap-4">
            <Field label="Project">{record.project ?? '—'}</Field>
            <Field label="Domain">{record.domain ?? '—'}</Field>
            <Field label="Created">{formatDateTime(record.timestamp)}</Field>
            <Field label="Last used">
              {formatRelative(record.lastUsed ?? record.timestamp)}
            </Field>
          </div>

          {/* Usage stats */}
          <div className="p-4 rounded-lg border border-border bg-card">
            <div className="text-xs text-muted-foreground mb-3">Usage metrics</div>
            <div className="grid grid-cols-4 gap-4 text-center">
              <div>
                <div className="text-xl font-semibold tabular-nums">{retrievals}</div>
                <div className="text-xs text-muted-foreground">Retrievals</div>
              </div>
              <div>
                <div className="text-xl font-semibold tabular-nums">{usage}</div>
                <div className="text-xs text-muted-foreground">Usage</div>
              </div>
              <div>
                <div className="text-xl font-semibold tabular-nums">{record.successCount ?? 0}</div>
                <div className="text-xs text-muted-foreground">Success</div>
              </div>
              <div>
                <div className="text-xl font-semibold tabular-nums">{ratio}%</div>
                <div className="text-xs text-muted-foreground">Ratio</div>
              </div>
            </div>
          </div>

          {/* Type-specific details */}
          <TypeDetails record={record} />
        </div>
      </div>
    </div>
  )
}
