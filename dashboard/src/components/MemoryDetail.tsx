import { useEffect, useRef, useState } from 'react'
import { Trash2, X } from 'lucide-react'
import ButtonSpinner from '@/components/ButtonSpinner'
import Skeleton from '@/components/Skeleton'
import { deleteMemory, type MemoryRecord } from '@/lib/api'
import { formatDateTime } from '@/lib/format'

export interface RetrievalContext {
  prompt?: string
  similarity?: number
  keywordMatch?: boolean
  score?: number
}

interface MemoryDetailProps {
  record: MemoryRecord | null
  retrievalContext?: RetrievalContext | null
  open?: boolean
  loading?: boolean
  error?: string | null
  onClose: () => void
  onDeleted?: (id: string) => void
}

const ANIMATION_DURATION = 200

const TYPE_COLORS: Record<string, string> = {
  command: '#2dd4bf',
  error: '#f43f5e',
  discovery: '#60a5fa',
  procedure: '#a78bfa',
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

function CodeBlock({ children, wrap }: { children: string; wrap?: boolean }) {
  return (
    <pre className={`p-3 rounded-md bg-secondary text-sm font-mono ${wrap ? 'whitespace-pre-wrap break-words' : 'overflow-x-auto'}`}>
      {children}
    </pre>
  )
}

function SkeletonField() {
  return (
    <div className="space-y-2">
      <Skeleton className="h-3 w-16" />
      <Skeleton className="h-4 w-24" />
    </div>
  )
}

function DetailSkeleton({ showRetrieval }: { showRetrieval: boolean }) {
  return (
    <div className="flex-1 overflow-y-auto px-6 py-6 space-y-6">
      <div className="grid grid-cols-2 gap-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <SkeletonField key={index} />
        ))}
      </div>

      <div className="p-4 rounded-lg border border-border bg-card space-y-3">
        <Skeleton className="h-3 w-24" />
        <div className="grid grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="space-y-2 text-center">
              <Skeleton className="h-6 w-10 mx-auto" />
              <Skeleton className="h-3 w-14 mx-auto" />
            </div>
          ))}
        </div>
      </div>

      {showRetrieval && (
        <div className="p-4 rounded-lg border border-border bg-card space-y-3">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-14 w-full" />
          <div className="flex flex-wrap gap-4">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-16" />
          </div>
        </div>
      )}

      <div className="space-y-4">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-10 w-2/3" />
      </div>
    </div>
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
              <CodeBlock wrap>{record.truncatedOutput}</CodeBlock>
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

export default function MemoryDetail({
  record,
  retrievalContext,
  open,
  loading = false,
  error = null,
  onClose,
  onDeleted
}: MemoryDetailProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const [isOpen, setIsOpen] = useState(false)
  const [isVisible, setIsVisible] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const isActive = open ?? Boolean(record)
  const isLoading = isActive && loading

  // Handle open animation
  useEffect(() => {
    if (isActive) {
      setIsVisible(true)
      setConfirmDelete(false)
      setDeleteError(null)
      setIsDeleting(false)
      // Trigger animation on next frame
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setIsOpen(true))
      })
    } else if (isVisible) {
      setIsOpen(false)
      const timer = setTimeout(() => {
        setIsVisible(false)
      }, ANIMATION_DURATION)
      return () => clearTimeout(timer)
    }
  }, [isActive, isVisible])

  // Handle keyboard and focus
  useEffect(() => {
    if (!isActive) return

    const prevFocus = document.activeElement as HTMLElement | null
    closeRef.current?.focus()

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose()
    }

    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('keydown', handleKey)
      prevFocus?.focus()
    }
  }, [isActive])

  const handleClose = () => {
    setDeleteError(null)
    setConfirmDelete(false)
    setIsOpen(false)
    onClose()
  }

  const handleDelete = async () => {
    if (!record || isDeleting || loading) return
    setIsDeleting(true)
    setDeleteError(null)
    try {
      await deleteMemory(record.id)
      setConfirmDelete(false)
      onDeleted?.(record.id)
      handleClose()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to delete memory'
      setDeleteError(message)
    } finally {
      setIsDeleting(false)
    }
  }

  if (!isVisible) return null

  return (
    <div className="fixed inset-0 z-50">
      {/* Backdrop */}
      <div
        className={`absolute inset-0 bg-black/60 panel-backdrop ${isOpen ? 'open' : ''}`}
        onClick={handleClose}
      />

      {/* Panel */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        className={`absolute inset-y-0 right-0 w-full max-w-2xl bg-background border-l border-border flex flex-col panel-slide ${isOpen ? 'open' : ''}`}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 px-6 py-5 border-b border-border">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-2">
              {record ? (
                <>
                  <span
                    className="w-2 h-2 rounded-full"
                    style={{ backgroundColor: TYPE_COLORS[record.type] }}
                  />
                  <span className="text-xs text-muted-foreground capitalize">{record.type}</span>
                  {record.deprecated && (
                    <span className="text-xs text-destructive">Deprecated</span>
                  )}
                </>
              ) : (
                <>
                  <Skeleton className="w-2 h-2 rounded-full" />
                  <Skeleton className="h-3 w-16" />
                </>
              )}
            </div>
            {record ? (
              <>
                <h2 className="text-lg font-semibold truncate">{getTitle(record)}</h2>
                <p className="text-xs text-muted-foreground font-mono mt-1">{record.id}</p>
              </>
            ) : (
              <>
                <Skeleton className="h-6 w-3/4" />
                <Skeleton className="h-3 w-32 mt-2" />
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setDeleteError(null)
                setConfirmDelete(true)
              }}
              disabled={!record || loading || isDeleting}
              className="flex items-center gap-2 h-8 px-3 rounded-md bg-destructive text-destructive-foreground text-xs font-medium disabled:opacity-50 hover:bg-destructive/90 transition-base"
            >
              <Trash2 className="w-4 h-4" />
              Delete
            </button>
            <button
              ref={closeRef}
              onClick={handleClose}
              className="p-2 rounded-md hover:bg-secondary transition-base"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {error && !record && !isLoading ? (
          <div className="flex-1 overflow-y-auto px-6 py-6">
            <div className="text-sm text-destructive">{error}</div>
          </div>
        ) : isLoading ? (
          <DetailSkeleton showRetrieval={Boolean(retrievalContext)} />
        ) : record ? (
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
                  <div className="text-xl font-semibold tabular-nums">{record.retrievalCount ?? 0}</div>
                  <div className="text-xs text-muted-foreground">Retrievals</div>
                </div>
                <div>
                  <div className="text-xl font-semibold tabular-nums">{record.usageCount ?? 0}</div>
                  <div className="text-xs text-muted-foreground">Usage</div>
                </div>
                <div>
                  <div className="text-xl font-semibold tabular-nums">{record.successCount ?? 0}</div>
                  <div className="text-xs text-muted-foreground">Success</div>
                </div>
                <div>
                  <div className="text-xl font-semibold tabular-nums">
                    {record.retrievalCount
                      ? Math.round(((record.usageCount ?? 0) / record.retrievalCount) * 100)
                      : 0}
                    %
                  </div>
                  <div className="text-xs text-muted-foreground">Ratio</div>
                </div>
              </div>
            </div>

            {/* Retrieval context (from session) */}
            {retrievalContext && (retrievalContext.prompt || retrievalContext.similarity != null) && (
              <div className="p-4 rounded-lg border border-border bg-card">
                <div className="text-xs text-muted-foreground mb-3">Last retrieval trigger</div>
                <div className="space-y-3">
                  {retrievalContext.prompt && (
                    <div>
                      <div className="text-xs text-muted-foreground mb-1">Triggered by prompt</div>
                      <div className="text-sm p-2 rounded bg-secondary/50 font-mono text-foreground/80">
                        "{retrievalContext.prompt}"
                      </div>
                    </div>
                  )}
                  <div className="flex gap-4 text-sm">
                    {retrievalContext.similarity != null && (
                      <div>
                        <span className="text-muted-foreground">Similarity: </span>
                        <span className="text-cyan-400 font-mono">{(retrievalContext.similarity * 100).toFixed(1)}%</span>
                      </div>
                    )}
                    {retrievalContext.keywordMatch != null && (
                      <div>
                        <span className="text-muted-foreground">Keyword match: </span>
                        <span className={retrievalContext.keywordMatch ? 'text-amber-400' : 'text-muted-foreground'}>
                          {retrievalContext.keywordMatch ? 'Yes' : 'No'}
                        </span>
                      </div>
                    )}
                    {retrievalContext.score != null && (
                      <div>
                        <span className="text-muted-foreground">Score: </span>
                        <span className="font-mono">{retrievalContext.score.toFixed(3)}</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Type-specific details */}
            <TypeDetails record={record} />
          </div>
        ) : null}
      </div>

      {confirmDelete && (
        <div className="fixed inset-0 z-50">
          <div
            className="absolute inset-0 bg-black/60 panel-backdrop open"
            onClick={() => {
              if (isDeleting) return
              setDeleteError(null)
              setConfirmDelete(false)
            }}
          />
          <div className="absolute inset-0 flex items-center justify-center px-4">
            <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 space-y-4">
              <div>
                <h2 className="text-lg font-semibold text-destructive">Delete this memory?</h2>
                <p className="text-sm text-muted-foreground">
                  This permanently removes the memory from the collection.
                </p>
              </div>
              {deleteError && (
                <div className="text-sm text-destructive">{deleteError}</div>
              )}
              <div className="flex items-center justify-end gap-3">
                <button
                  onClick={() => {
                    setDeleteError(null)
                    setConfirmDelete(false)
                  }}
                  disabled={isDeleting}
                  className="h-9 px-4 rounded-md border border-border bg-background text-sm hover:bg-secondary/60 transition-base disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleDelete}
                  disabled={isDeleting}
                  className="flex items-center gap-2 h-9 px-4 rounded-md bg-destructive text-destructive-foreground text-sm font-medium hover:bg-destructive/90 transition-base disabled:opacity-50"
                >
                  {isDeleting ? (
                    <>
                      <ButtonSpinner size="md" />
                      Deleting...
                    </>
                  ) : (
                    'Delete'
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
