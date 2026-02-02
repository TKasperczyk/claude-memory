import { useState } from 'react'
import { Loader2, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { deleteMemory, type MemoryRecord } from '@/lib/api'
import { formatDateTime, formatRelativeTimeLong } from '@/lib/format'
import { TYPE_COLORS, getMemoryTitle } from '@/lib/memory-ui'

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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground/70 mb-1.5 font-medium">{label}</div>
      <div className="text-sm text-foreground/90">{children}</div>
    </div>
  )
}

function CodeBlock({ children, wrap }: { children: string; wrap?: boolean }) {
  return (
    <pre className={`p-3 rounded-lg bg-secondary/60 border border-border/40 text-sm font-mono text-foreground/85 ${wrap ? 'whitespace-pre-wrap break-words' : 'overflow-x-auto'}`}>
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
    <div className="flex-1 overflow-y-auto py-6 space-y-6">
      <div className="grid grid-cols-2 gap-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <SkeletonField key={index} />
        ))}
      </div>

      <Card>
        <CardContent className="p-4 space-y-3">
          <Skeleton className="h-3 w-24" />
          <div className="grid grid-cols-4 gap-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="space-y-2 text-center">
                <Skeleton className="h-6 w-10 mx-auto" />
                <Skeleton className="h-3 w-14 mx-auto" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {showRetrieval && (
        <Card>
          <CardContent className="p-4 space-y-3">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-14 w-full" />
            <div className="flex flex-wrap gap-4">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-3 w-16" />
            </div>
          </CardContent>
        </Card>
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
              <span className={record.exitCode === 0 ? 'text-success' : 'text-destructive'}>
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

    case 'warning':
      return (
        <div className="space-y-4">
          <Field label="Avoid">
            <div className="p-3 rounded-md bg-destructive/10 border border-destructive/20 text-sm">
              {record.avoid}
            </div>
          </Field>
          <Field label="Use instead">
            <div className="p-3 rounded-md bg-success/10 border border-success/20 text-sm">
              {record.useInstead}
            </div>
          </Field>
          <Field label="Reason">{record.reason}</Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Severity">
              <span className={
                record.severity === 'critical' ? 'text-destructive font-medium' :
                record.severity === 'warning' ? 'text-warning' :
                'text-muted-foreground'
              }>
                {record.severity}
              </span>
            </Field>
            {record.synthesizedAt && (
              <Field label="Synthesized">{formatDateTime(record.synthesizedAt)}</Field>
            )}
          </div>
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
  const [isDeleting, setIsDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const isActive = open ?? Boolean(record)
  const isLoading = isActive && loading

  const handleDelete = async () => {
    if (!record || isDeleting || loading) return
    setIsDeleting(true)
    setDeleteError(null)
    try {
      await deleteMemory(record.id)
      setConfirmDelete(false)
      onDeleted?.(record.id)
      onClose()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to delete memory'
      setDeleteError(message)
    } finally {
      setIsDeleting(false)
    }
  }

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      setDeleteError(null)
      setConfirmDelete(false)
      onClose()
    }
  }

  return (
    <>
      <Sheet open={isActive} onOpenChange={handleOpenChange}>
        <SheetContent className="w-full max-w-2xl sm:max-w-2xl p-0 flex flex-col">
          {/* Header */}
          <SheetHeader className="px-6 py-4 border-b border-border bg-secondary shrink-0">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2.5 mb-2">
                  {record ? (
                    <>
                      <span
                        className="w-2.5 h-2.5 rounded-full shadow-sm"
                        style={{ backgroundColor: TYPE_COLORS[record.type] }}
                      />
                      <span className="text-[11px] uppercase tracking-wide text-muted-foreground/70 font-medium">{record.type}</span>
                      {record.deprecated && (
                        <Badge variant="destructive" className="text-[10px] px-1.5 py-0">Deprecated</Badge>
                      )}
                    </>
                  ) : (
                    <>
                      <Skeleton className="w-2.5 h-2.5 rounded-full" />
                      <Skeleton className="h-3 w-16" />
                    </>
                  )}
                </div>
                {record ? (
                  <>
                    <SheetTitle className="text-lg font-semibold tracking-tight truncate text-foreground/95">
                      {getMemoryTitle(record)}
                    </SheetTitle>
                    <SheetDescription className="text-[11px] text-muted-foreground/60 font-mono mt-1.5">
                      {record.id}
                    </SheetDescription>
                  </>
                ) : (
                  <>
                    <Skeleton className="h-6 w-3/4" />
                    <Skeleton className="h-3 w-32 mt-2" />
                  </>
                )}
              </div>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => {
                  setDeleteError(null)
                  setConfirmDelete(true)
                }}
                disabled={!record || loading || isDeleting}
              >
                <Trash2 className="w-3.5 h-3.5" />
                Delete
              </Button>
            </div>
          </SheetHeader>

          {error && !record && !isLoading ? (
            <div className="flex-1 overflow-y-auto px-6 py-6">
              <div className="text-sm text-destructive">{error}</div>
            </div>
          ) : isLoading ? (
            <div className="flex-1 overflow-y-auto px-6">
              <DetailSkeleton showRetrieval={Boolean(retrievalContext)} />
            </div>
          ) : record ? (
            <div className="flex-1 overflow-y-auto px-6 py-6 space-y-6">
              {/* Metadata */}
              <div className="grid grid-cols-2 gap-4">
                <Field label="Project">{record.project ?? '—'}</Field>
                <Field label="Domain">{record.domain ?? '—'}</Field>
                <Field label="Created">{formatDateTime(record.timestamp)}</Field>
                <Field label="Last used">
                  {formatRelativeTimeLong(record.lastUsed ?? record.timestamp)}
                </Field>
              </div>

              {/* Usage stats */}
              <Card className="bg-secondary">
                <CardContent className="p-4">
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground/70 mb-3 font-medium">Usage metrics</div>
                  <div className="grid grid-cols-4 gap-3 text-center">
                    <div className="py-2">
                      <div className="text-2xl font-semibold tabular-nums text-foreground/90">{record.retrievalCount ?? 0}</div>
                      <div className="text-[11px] text-muted-foreground/60 mt-0.5">Retrievals</div>
                    </div>
                    <div className="py-2">
                      <div className="text-2xl font-semibold tabular-nums text-foreground/90">{record.usageCount ?? 0}</div>
                      <div className="text-[11px] text-muted-foreground/60 mt-0.5">Usage</div>
                    </div>
                    <div className="py-2">
                      <div className="text-2xl font-semibold tabular-nums text-foreground/90">{record.successCount ?? 0}</div>
                      <div className="text-[11px] text-muted-foreground/60 mt-0.5">Success</div>
                    </div>
                    <div className="py-2">
                      <div className="text-2xl font-semibold tabular-nums text-foreground/90">
                        {record.retrievalCount
                          ? Math.round(((record.usageCount ?? 0) / record.retrievalCount) * 100)
                          : 0}
                        %
                      </div>
                      <div className="text-[11px] text-muted-foreground/60 mt-0.5">Ratio</div>
                    </div>
                  </div>
                  {retrievalContext && (record.retrievalCount ?? 0) === 0 && (
                    <div className="mt-3 text-[11px] text-muted-foreground/50 text-center">
                      Stats update when the session ends
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Retrieval context (from session) */}
              {retrievalContext && (retrievalContext.prompt || retrievalContext.similarity != null) && (
                <Card>
                  <CardContent className="p-4">
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
                            <span className="text-info font-mono">{(retrievalContext.similarity * 100).toFixed(1)}%</span>
                          </div>
                        )}
                        {retrievalContext.keywordMatch != null && (
                          <div>
                            <span className="text-muted-foreground">Keyword match: </span>
                            <span className={retrievalContext.keywordMatch ? 'text-warning' : 'text-muted-foreground'}>
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
                  </CardContent>
                </Card>
              )}

              {/* Type-specific details */}
              <TypeDetails record={record} />
            </div>
          ) : null}
        </SheetContent>
      </Sheet>

      {/* Delete confirmation dialog */}
      <Dialog open={confirmDelete} onOpenChange={(open) => {
        if (isDeleting) return
        setConfirmDelete(open)
        if (!open) setDeleteError(null)
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-destructive">Delete this memory?</DialogTitle>
            <DialogDescription>
              This permanently removes the memory from the collection.
            </DialogDescription>
          </DialogHeader>
          {deleteError && (
            <div className="text-sm text-destructive">{deleteError}</div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setDeleteError(null)
                setConfirmDelete(false)
              }}
              disabled={isDeleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={isDeleting}
            >
              {isDeleting && <Loader2 className="animate-spin" />}
              {isDeleting ? 'Deleting...' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
