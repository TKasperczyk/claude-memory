import { useEffect, useRef } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'
import TypeBadge from '@/components/TypeBadge'
import type { MemoryRecord } from '@/lib/api'

interface MemoryDetailProps {
  record: MemoryRecord | null
  onClose: () => void
}

function formatDateTime(timestamp?: number): string {
  if (!timestamp) return 'N/A'
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(new Date(timestamp))
}

function formatRelativeTime(timestamp?: number): string {
  if (!timestamp) return 'N/A'
  const diffSeconds = Math.round((timestamp - Date.now()) / 1000)
  const ranges: Array<{ unit: Intl.RelativeTimeFormatUnit; seconds: number }> = [
    { unit: 'year', seconds: 31536000 },
    { unit: 'month', seconds: 2592000 },
    { unit: 'day', seconds: 86400 },
    { unit: 'hour', seconds: 3600 },
    { unit: 'minute', seconds: 60 },
    { unit: 'second', seconds: 1 }
  ]

  for (const range of ranges) {
    if (Math.abs(diffSeconds) >= range.seconds) {
      const value = Math.round(diffSeconds / range.seconds)
      return new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(value, range.unit)
    }
  }

  return 'just now'
}

function getTitle(record: MemoryRecord): string {
  switch (record.type) {
    case 'command':
      return record.command
    case 'error':
      return record.errorText
    case 'discovery':
      return record.what
    case 'procedure':
      return record.name
  }
}

function renderTypeDetails(record: MemoryRecord) {
  switch (record.type) {
    case 'command':
      return (
        <div className="space-y-4">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Command</p>
            <p className="mt-2 rounded-lg bg-black/30 px-3 py-2 font-mono text-sm text-emerald-200">
              {record.command}
            </p>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-lg border border-white/10 bg-white/5 p-3">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Outcome</p>
              <p className="mt-2 text-sm text-slate-100">{record.outcome}</p>
            </div>
            <div className="rounded-lg border border-white/10 bg-white/5 p-3">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Exit code</p>
              <p className="mt-2 text-sm text-slate-100">{record.exitCode}</p>
            </div>
          </div>
          {record.resolution ? (
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Resolution</p>
              <p className="mt-2 text-sm text-slate-200">{record.resolution}</p>
            </div>
          ) : null}
          {record.truncatedOutput ? (
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Output</p>
              <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-black/40 p-3 text-xs text-slate-200">
                {record.truncatedOutput}
              </pre>
            </div>
          ) : null}
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Context</p>
            <div className="mt-2 grid gap-2 rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-slate-200">
              <p>Project: {record.context.project}</p>
              <p>CWD: {record.context.cwd}</p>
              <p>Intent: {record.context.intent}</p>
            </div>
          </div>
        </div>
      )
    case 'error':
      return (
        <div className="space-y-4">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Error</p>
            <pre className="mt-2 rounded-lg bg-black/40 p-3 text-xs text-rose-200">
              {record.errorText}
            </pre>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-lg border border-white/10 bg-white/5 p-3">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Error type</p>
              <p className="mt-2 text-sm text-slate-100">{record.errorType}</p>
            </div>
            {record.cause ? (
              <div className="rounded-lg border border-white/10 bg-white/5 p-3">
                <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Cause</p>
                <p className="mt-2 text-sm text-slate-100">{record.cause}</p>
              </div>
            ) : null}
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Resolution</p>
            <p className="mt-2 text-sm text-slate-200">{record.resolution}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Context</p>
            <div className="mt-2 grid gap-2 rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-slate-200">
              <p>Project: {record.context.project}</p>
              <p>File: {record.context.file ?? 'N/A'}</p>
              <p>Tool: {record.context.tool ?? 'N/A'}</p>
            </div>
          </div>
        </div>
      )
    case 'discovery':
      return (
        <div className="space-y-4">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Discovery</p>
            <p className="mt-2 text-sm text-slate-100">{record.what}</p>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-lg border border-white/10 bg-white/5 p-3">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Where</p>
              <p className="mt-2 text-sm text-slate-200">{record.where}</p>
            </div>
            <div className="rounded-lg border border-white/10 bg-white/5 p-3">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Confidence</p>
              <p className="mt-2 text-sm text-slate-200">{record.confidence}</p>
            </div>
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Evidence</p>
            <p className="mt-2 text-sm text-slate-200">{record.evidence}</p>
          </div>
        </div>
      )
    case 'procedure':
      return (
        <div className="space-y-4">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Procedure</p>
            <p className="mt-2 text-sm text-slate-100">{record.name}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Steps</p>
            <ol className="mt-2 list-decimal space-y-2 rounded-lg border border-white/10 bg-white/5 px-6 py-3 text-sm text-slate-200">
              {record.steps.map((step, index) => (
                <li key={`${record.id}-step-${index}`}>{step}</li>
              ))}
            </ol>
          </div>
          {record.prerequisites?.length ? (
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Prerequisites</p>
              <ul className="mt-2 list-disc space-y-1 rounded-lg border border-white/10 bg-white/5 px-5 py-3 text-sm text-slate-200">
                {record.prerequisites.map((item, index) => (
                  <li key={`${record.id}-pre-${index}`}>{item}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {record.verification ? (
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Verification</p>
              <p className="mt-2 text-sm text-slate-200">{record.verification}</p>
            </div>
          ) : null}
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Context</p>
            <div className="mt-2 grid gap-2 rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-slate-200">
              <p>Project: {record.context.project ?? 'N/A'}</p>
              <p>Domain: {record.context.domain}</p>
            </div>
          </div>
        </div>
      )
    default:
      return null
  }
}

export default function MemoryDetail({ record, onClose }: MemoryDetailProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!record) return

    const previousFocus = document.activeElement as HTMLElement | null
    closeButtonRef.current?.focus()

    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
        return
      }
      if (event.key !== 'Tab') return

      const dialog = dialogRef.current
      if (!dialog) return
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        )
      ).filter(element => !element.hasAttribute('disabled'))
      if (focusable.length === 0) return

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const activeElement = document.activeElement as HTMLElement | null

      if (event.shiftKey) {
        if (activeElement === first || !dialog.contains(activeElement)) {
          event.preventDefault()
          last.focus()
        }
      } else if (activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('keydown', handleKey)
      previousFocus?.focus()
    }
  }, [record, onClose])

  if (!record) return null

  const usageData = [
    { name: 'Retrievals', value: record.retrievalCount ?? 0 },
    { name: 'Usage', value: record.usageCount ?? 0 },
    { name: 'Success', value: record.successCount ?? 0 },
    { name: 'Failures', value: record.failureCount ?? 0 }
  ]

  const retrievalCount = record.retrievalCount ?? 0
  const usageCount = record.usageCount ?? 0
  const ratio = retrievalCount > 0 ? Math.min(usageCount / retrievalCount, 1) : 0

  return (
    <div className="fixed inset-0 z-50">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className="absolute inset-y-0 right-0 flex w-full max-w-3xl flex-col overflow-hidden border-l border-white/10 bg-[color:var(--panel)]"
      >
        <div className="flex items-start justify-between gap-4 border-b border-white/10 px-6 py-5">
          <div>
            <TypeBadge type={record.type} />
            <h2 className="mt-3 text-xl font-semibold text-slate-100">{getTitle(record)}</h2>
            <p className="mt-1 text-sm text-slate-400">{record.id}</p>
          </div>
          <button
            ref={closeButtonRef}
            onClick={onClose}
            className="rounded-full border border-white/10 px-3 py-1 text-xs uppercase tracking-[0.2em] text-slate-300 transition hover:border-white/30 hover:text-white"
          >
            Close
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-6">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded-xl border border-white/10 bg-white/5 p-4 text-sm text-slate-200">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Project</p>
              <p className="mt-2">{record.project ?? 'unknown'}</p>
            </div>
            <div className="rounded-xl border border-white/10 bg-white/5 p-4 text-sm text-slate-200">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Domain</p>
              <p className="mt-2">{record.domain ?? 'unknown'}</p>
            </div>
            <div className="rounded-xl border border-white/10 bg-white/5 p-4 text-sm text-slate-200">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Created</p>
              <p className="mt-2">{formatDateTime(record.timestamp)}</p>
            </div>
            <div className="rounded-xl border border-white/10 bg-white/5 p-4 text-sm text-slate-200">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Last used</p>
              <p className="mt-2">
                {formatRelativeTime(record.lastUsed ?? record.timestamp)}
                <span className="block text-xs text-slate-500">
                  {formatDateTime(record.lastUsed ?? record.timestamp)}
                </span>
              </p>
            </div>
          </div>

          <div className="mt-6 rounded-2xl border border-white/10 bg-white/5 p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Usage signals</p>
                <p className="mt-2 text-sm text-slate-300">Usage ratio</p>
                <p className="text-2xl font-semibold text-emerald-300">{Math.round(ratio * 100)}%</p>
              </div>
              <div className="h-20 w-56">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={usageData} layout="vertical">
                    <CartesianGrid stroke="rgba(255,255,255,0.06)" horizontal={false} />
                    <XAxis type="number" hide />
                    <YAxis type="category" dataKey="name" width={80} tick={{ fill: '#94a3b8', fontSize: 11 }} />
                    <Tooltip
                      cursor={{ fill: 'rgba(255,255,255,0.06)' }}
                      contentStyle={{
                        background: '#0f172a',
                        border: '1px solid rgba(255,255,255,0.1)',
                        color: '#e2e8f0'
                      }}
                    />
                    <Bar dataKey="value" fill="#34d399" radius={[6, 6, 6, 6]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div className="mt-4 grid gap-3 text-xs text-slate-300 sm:grid-cols-2">
              <div className="rounded-lg border border-white/10 bg-black/30 px-3 py-2">
                Retrievals: <span className="text-slate-100">{record.retrievalCount ?? 0}</span>
              </div>
              <div className="rounded-lg border border-white/10 bg-black/30 px-3 py-2">
                Usage: <span className="text-slate-100">{record.usageCount ?? 0}</span>
              </div>
              <div className="rounded-lg border border-white/10 bg-black/30 px-3 py-2">
                Success: <span className="text-slate-100">{record.successCount ?? 0}</span>
              </div>
              <div className="rounded-lg border border-white/10 bg-black/30 px-3 py-2">
                Failures: <span className="text-slate-100">{record.failureCount ?? 0}</span>
              </div>
            </div>
          </div>

          {record.deprecated ? (
            <div className="mt-6 rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-200">
              This memory is marked as deprecated.
            </div>
          ) : null}

          <div className="mt-8">{renderTypeDetails(record)}</div>
        </div>
      </div>
    </div>
  )
}
