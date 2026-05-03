import type { MemoryRecord, RecordType } from './types.js'

export type RecordSummaryOptions = {
  useInsteadFallback?: boolean
}

export type RecordFieldSource = {
  type: RecordType
  command?: string
  exitCode?: number
  outcome?: string
  truncatedOutput?: string
  resolution?: string
  errorText?: string
  errorType?: string
  cause?: string
  what?: string
  where?: string
  evidence?: string
  confidence?: string
  name?: string
  steps?: string[]
  prerequisites?: string[]
  verification?: string
  avoid?: string
  useInstead?: string
  reason?: string
  severity?: string
  sourceRecordIds?: string[]
  context?: unknown
}

export type RecordTextGroups = {
  primary: Array<string | undefined>
  secondary: Array<string | undefined>
  exact: Array<string | undefined>
  searchable: Array<string | undefined>
  supplementalEmbedding: Array<string | undefined>
}

type RecordFieldView = {
  fields: Record<string, unknown>
  text: RecordTextGroups
  summary?: string
  summaryFallback?: string
}

export function getRecordFieldView(record: RecordFieldSource): RecordFieldView {
  switch (record.type) {
    case 'command': {
      const fields = {
        command: record.command,
        exitCode: record.exitCode,
        outcome: record.outcome,
        truncatedOutput: record.truncatedOutput,
        resolution: record.resolution,
        context: record.context
      }
      return {
        fields,
        summary: record.command,
        text: {
          primary: [record.command],
          secondary: [record.resolution, record.truncatedOutput],
          exact: [record.command],
          searchable: [record.command, record.truncatedOutput, record.resolution],
          supplementalEmbedding: [record.resolution]
        }
      }
    }
    case 'error': {
      const fields = {
        errorText: record.errorText,
        errorType: record.errorType,
        cause: record.cause,
        resolution: record.resolution,
        context: record.context
      }
      return {
        fields,
        summary: record.errorText,
        text: {
          primary: [record.errorText],
          secondary: [record.resolution, record.cause],
          exact: [record.errorText],
          searchable: [record.errorText, record.resolution, record.cause],
          supplementalEmbedding: [record.cause, record.resolution]
        }
      }
    }
    case 'discovery': {
      const fields = {
        what: record.what,
        where: record.where,
        evidence: record.evidence,
        confidence: record.confidence
      }
      return {
        fields,
        summary: record.what,
        text: {
          primary: [record.what],
          secondary: [record.where, record.evidence],
          exact: [record.what, record.where],
          searchable: [record.what, record.evidence, record.where],
          supplementalEmbedding: [record.evidence]
        }
      }
    }
    case 'procedure': {
      const fields = {
        name: record.name,
        steps: record.steps,
        prerequisites: record.prerequisites,
        verification: record.verification,
        context: record.context
      }
      return {
        fields,
        summary: record.name,
        text: {
          primary: [record.name],
          secondary: [...(record.steps ?? []), record.verification, ...(record.prerequisites ?? [])],
          exact: [record.name, ...(record.steps ?? [])],
          searchable: [record.name, ...(record.steps ?? []), record.verification, ...(record.prerequisites ?? [])],
          supplementalEmbedding: [record.prerequisites?.join('\n'), record.verification]
        }
      }
    }
    case 'warning': {
      const fields = {
        avoid: record.avoid,
        useInstead: record.useInstead,
        reason: record.reason,
        severity: record.severity,
        sourceRecordIds: record.sourceRecordIds
      }
      return {
        fields,
        summary: record.avoid,
        summaryFallback: record.useInstead,
        text: {
          primary: [record.avoid],
          secondary: [record.useInstead, record.reason],
          exact: [record.avoid, record.useInstead, record.reason],
          searchable: [record.avoid, record.useInstead, record.reason],
          supplementalEmbedding: []
        }
      }
    }
  }
}

export function getRecordTextGroups(record: RecordFieldSource): RecordTextGroups {
  return getRecordFieldView(record).text
}

export function getRecordPrimaryTextParts(record: RecordFieldSource): Array<string | undefined> {
  return getRecordTextGroups(record).primary
}

export function getRecordSecondaryTextParts(record: RecordFieldSource): Array<string | undefined> {
  return getRecordTextGroups(record).secondary
}

export function getPrimaryRecordText(record: RecordFieldSource): string {
  return joinTextParts(getRecordPrimaryTextParts(record))
}

export function getSecondaryRecordText(record: RecordFieldSource): string {
  return joinTextParts(getRecordSecondaryTextParts(record))
}

export function getRecordExactTextParts(record: RecordFieldSource): Array<string | undefined> {
  return getRecordTextGroups(record).exact
}

export function getRecordSearchableTextParts(record: RecordFieldSource): Array<string | undefined> {
  return getRecordTextGroups(record).searchable
}

export function getRecordSupplementalEmbeddingParts(record: RecordFieldSource): Array<string | undefined> {
  return getRecordTextGroups(record).supplementalEmbedding
}

function joinTextParts(parts: Array<string | undefined>): string {
  return parts
    .map(part => typeof part === 'string' ? part.trim() : '')
    .filter(Boolean)
    .join('\n')
    .trim()
}

export function getRecordSummaryText(
  record: RecordFieldSource,
  options: RecordSummaryOptions = {}
): string | undefined {
  const view = getRecordFieldView(record)
  if (view.summary !== undefined) return view.summary
  if (options.useInsteadFallback) return view.summaryFallback
  return undefined
}

export function getRecordReviewFields(record: MemoryRecord): Record<string, unknown> {
  return getRecordFieldView(record).fields
}
