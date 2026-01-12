/**
 * Formats review data into structured text for Claude analysis.
 * Designed to provide all context needed to suggest system improvements.
 */

import type {
  ExtractionReview,
  ExtractionRun,
  InjectionReview,
  MaintenanceReview,
  MemoryRecord,
  OperationResult,
  SessionRecord
} from './api'

function formatTimestamp(ts: number): string {
  return new Date(ts).toISOString()
}

function getRecordContent(record: MemoryRecord): string {
  switch (record.type) {
    case 'command':
      return [
        `Command: ${record.command}`,
        `Exit code: ${record.exitCode}`,
        `Outcome: ${record.outcome}`,
        record.resolution ? `Resolution: ${record.resolution}` : '',
        `Context: project=${record.context.project}, cwd=${record.context.cwd}`,
        record.context.intent ? `Intent: ${record.context.intent}` : ''
      ].filter(Boolean).join('\n')

    case 'error':
      return [
        `Error: ${record.errorText}`,
        `Type: ${record.errorType}`,
        record.cause ? `Cause: ${record.cause}` : '',
        `Resolution: ${record.resolution}`,
        `Context: project=${record.context.project}${record.context.file ? `, file=${record.context.file}` : ''}${record.context.tool ? `, tool=${record.context.tool}` : ''}`
      ].filter(Boolean).join('\n')

    case 'discovery':
      return [
        `What: ${record.what}`,
        `Where: ${record.where}`,
        `Evidence: ${record.evidence}`,
        `Confidence: ${record.confidence}`
      ].join('\n')

    case 'procedure':
      return [
        `Name: ${record.name}`,
        `Steps:\n${record.steps.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`,
        record.prerequisites?.length ? `Prerequisites: ${record.prerequisites.join(', ')}` : '',
        record.verification ? `Verification: ${record.verification}` : '',
        `Context: ${record.context.domain}${record.context.project ? `, project=${record.context.project}` : ''}`
      ].filter(Boolean).join('\n')

    case 'warning':
      return [
        `Avoid: ${record.avoid}`,
        `Use instead: ${record.useInstead}`,
        `Reason: ${record.reason}`,
        `Severity: ${record.severity}`
      ].join('\n')
  }
}

export function formatExtractionReview(
  run: ExtractionRun,
  records: MemoryRecord[],
  review: ExtractionReview
): string {
  const lines: string[] = []

  lines.push('# Extraction Review Report')
  lines.push('')
  lines.push('## Context')
  lines.push(`- Session ID: ${run.sessionId}`)
  lines.push(`- Run ID: ${run.runId}`)
  lines.push(`- Timestamp: ${formatTimestamp(run.timestamp)}`)
  lines.push(`- Transcript: ${run.transcriptPath}`)
  lines.push(`- Extraction duration: ${run.duration}ms`)
  lines.push(`- Parse errors: ${run.parseErrorCount}`)
  lines.push('')

  lines.push('## Review Summary')
  lines.push(`- Overall accuracy: ${review.overallAccuracy.toUpperCase()}`)
  lines.push(`- Accuracy score: ${review.accuracyScore}/100`)
  lines.push(`- Model: ${review.model}`)
  lines.push(`- Review duration: ${review.durationMs}ms`)
  lines.push('')
  lines.push(`**Summary**: ${review.summary}`)
  lines.push('')

  if (review.issues.length > 0) {
    lines.push('## Issues Found')
    lines.push('')
    for (const issue of review.issues) {
      lines.push(`### [${issue.severity.toUpperCase()}] ${issue.type.toUpperCase()}`)
      if (issue.recordId) {
        lines.push(`Record ID: ${issue.recordId}`)
      }
      lines.push(`Description: ${issue.description}`)
      lines.push(`Evidence: ${issue.evidence}`)
      if (issue.suggestedFix) {
        lines.push(`Suggested fix: ${issue.suggestedFix}`)
      }
      lines.push('')
    }
  } else {
    lines.push('## Issues Found')
    lines.push('No issues flagged.')
    lines.push('')
  }

  lines.push('## Extracted Records')
  lines.push('')
  if (records.length === 0) {
    lines.push('No records were extracted.')
  } else {
    for (const record of records) {
      lines.push(`### ${record.type.toUpperCase()}: ${record.id}`)
      lines.push('')
      lines.push('**Content:**')
      lines.push('```')
      lines.push(getRecordContent(record))
      lines.push('```')
      lines.push('')
      if (record.sourceExcerpt) {
        lines.push('**Source excerpt (what triggered this extraction):**')
        lines.push('```')
        lines.push(record.sourceExcerpt)
        lines.push('```')
      } else {
        lines.push('*No source excerpt available.*')
      }
      lines.push('')
      lines.push('---')
      lines.push('')
    }
  }

  lines.push('## Analysis Guidance')
  lines.push('')
  lines.push('When analyzing this review, consider:')
  lines.push('1. Are the extracted records accurate representations of the source?')
  lines.push('2. Did the extraction miss important learnings from the transcript?')
  lines.push('3. Are there patterns in the issues that suggest prompt/system changes?')
  lines.push('4. Is the source excerpt sufficient to understand the context?')
  lines.push('5. Should the extraction prompt be adjusted to improve quality?')

  return lines.join('\n')
}

export function formatInjectionReview(
  session: SessionRecord,
  review: InjectionReview
): string {
  const lines: string[] = []

  lines.push('# Injection Review Report')
  lines.push('')
  lines.push('## Context')
  lines.push(`- Session ID: ${session.sessionId}`)
  lines.push(`- Working directory: ${session.cwd ?? 'Unknown'}`)
  lines.push(`- Session created: ${formatTimestamp(session.createdAt)}`)
  lines.push(`- Last activity: ${formatTimestamp(session.lastActivity)}`)
  lines.push(`- Memories injected: ${session.memories.length}`)
  lines.push('')
  lines.push('**User prompt that triggered injection:**')
  lines.push('```')
  lines.push(review.prompt)
  lines.push('```')
  lines.push('')

  lines.push('## Review Summary')
  lines.push(`- Overall relevance: ${review.overallRelevance.toUpperCase()}`)
  lines.push(`- Relevance score: ${review.relevanceScore}/100`)
  lines.push(`- Model: ${review.model}`)
  lines.push(`- Review duration: ${review.durationMs}ms`)
  lines.push('')
  lines.push(`**Summary**: ${review.summary}`)
  lines.push('')

  lines.push('## Injected Memories with Verdicts')
  lines.push('')
  if (review.injectedVerdicts.length === 0) {
    lines.push('No verdicts returned.')
  } else {
    // Group by verdict for easier pattern recognition
    const byVerdict: Record<string, typeof review.injectedVerdicts> = {}
    for (const v of review.injectedVerdicts) {
      byVerdict[v.verdict] = byVerdict[v.verdict] || []
      byVerdict[v.verdict].push(v)
    }

    for (const verdict of ['relevant', 'partially_relevant', 'irrelevant', 'unknown'] as const) {
      const items = byVerdict[verdict]
      if (!items?.length) continue

      lines.push(`### ${verdict.toUpperCase().replace('_', ' ')} (${items.length})`)
      lines.push('')
      for (const v of items) {
        // Find original memory to get retrieval context
        const originalMemory = session.memories.find(m => m.id === v.id)

        lines.push(`**ID**: ${v.id}`)
        lines.push(`**Snippet**: ${v.snippet}`)
        lines.push(`**Reason**: ${v.reason}`)

        if (originalMemory) {
          const triggers: string[] = []
          if (originalMemory.similarity != null) {
            triggers.push(`semantic=${(originalMemory.similarity * 100).toFixed(0)}%`)
          }
          if (originalMemory.keywordMatch) {
            triggers.push('keyword=true')
          }
          if (originalMemory.score != null) {
            triggers.push(`score=${originalMemory.score.toFixed(2)}`)
          }
          if (triggers.length) {
            lines.push(`**Retrieval trigger**: ${triggers.join(', ')}`)
          }
          if (originalMemory.prompt) {
            lines.push(`**Triggered by prompt**: "${originalMemory.prompt.length > 100 ? originalMemory.prompt.slice(0, 100) + '...' : originalMemory.prompt}"`)
          }
        }
        lines.push('')
      }
    }
  }

  if (review.missedMemories.length > 0) {
    lines.push('## Missed Memories')
    lines.push('')
    lines.push('These memories should have been injected but were not:')
    lines.push('')
    for (const missed of review.missedMemories) {
      lines.push(`**ID**: ${missed.id}`)
      lines.push(`**Snippet**: ${missed.snippet}`)
      lines.push(`**Reason it should have been included**: ${missed.reason}`)
      lines.push('')
    }
  } else {
    lines.push('## Missed Memories')
    lines.push('No missed memories flagged.')
    lines.push('')
  }

  lines.push('## Analysis Guidance')
  lines.push('')
  lines.push('When analyzing this review, consider:')
  lines.push('1. Are irrelevant memories being retrieved due to overly broad semantic matching?')
  lines.push('2. Are relevant memories being missed due to insufficient keyword/semantic overlap?')
  lines.push('3. Should domain/project filtering be adjusted?')
  lines.push('4. Are the retrieval trigger scores calibrated correctly?')
  lines.push('5. Should certain memory types be weighted differently?')
  lines.push('6. Are there patterns in what gets missed vs what gets irrelevantly included?')

  return lines.join('\n')
}

export function formatMaintenanceReview(
  result: OperationResult,
  review: MaintenanceReview
): string {
  const lines: string[] = []

  lines.push('# Maintenance Review Report')
  lines.push('')
  lines.push('## Operation')
  lines.push(`- Operation: ${review.operation}`)
  lines.push(`- Mode: ${review.dryRun ? 'dry-run' : 'execute'}`)
  lines.push(`- Duration: ${result.duration}ms`)
  lines.push(`- Action count: ${result.actions.length}`)
  lines.push('')

  lines.push('## Review Summary')
  lines.push(`- Overall assessment: ${review.overallAssessment.toUpperCase()}`)
  lines.push(`- Assessment score: ${review.assessmentScore}/100`)
  lines.push(`- Model: ${review.model}`)
  lines.push(`- Review duration: ${review.durationMs}ms`)
  lines.push('')
  lines.push(`**Summary**: ${review.summary}`)
  lines.push('')

  lines.push('## Action Verdicts')
  lines.push('')
  if (review.actionVerdicts.length === 0) {
    lines.push('No action verdicts returned.')
    lines.push('')
  } else {
    const byVerdict: Record<string, typeof review.actionVerdicts> = {}
    for (const verdict of review.actionVerdicts) {
      byVerdict[verdict.verdict] = byVerdict[verdict.verdict] || []
      byVerdict[verdict.verdict].push(verdict)
    }

    for (const verdict of ['correct', 'questionable', 'incorrect'] as const) {
      const items = byVerdict[verdict]
      if (!items?.length) continue

      lines.push(`### ${verdict.toUpperCase()} (${items.length})`)
      lines.push('')
      for (const item of items) {
        lines.push(`**Action**: ${item.action}`)
        if (item.recordId) {
          lines.push(`**Record ID**: ${item.recordId}`)
        }
        lines.push(`**Snippet**: ${item.snippet}`)
        lines.push(`**Reason**: ${item.reason}`)
        lines.push('')
      }
    }
  }

  lines.push('## Settings Recommendations')
  lines.push('')
  if (review.settingsRecommendations.length === 0) {
    lines.push('No settings recommendations.')
    lines.push('')
  } else {
    for (const rec of review.settingsRecommendations) {
      lines.push(`**Setting**: ${rec.setting}`)
      lines.push(`**Current value**: ${rec.currentValue}`)
      lines.push(`**Recommendation**: ${rec.recommendation}`)
      if (rec.suggestedValue !== undefined) {
        lines.push(`**Suggested value**: ${rec.suggestedValue}`)
      }
      lines.push(`**Reason**: ${rec.reason}`)
      lines.push('')
    }
  }

  lines.push('## Original Result Summary (JSON)')
  lines.push('```json')
  lines.push(JSON.stringify(result.summary, null, 2))
  lines.push('```')
  lines.push('')
  lines.push('## Analysis Guidance')
  lines.push('')
  lines.push('When analyzing this review, consider:')
  lines.push('1. Are the action verdicts appropriate given the operation\'s goal?')
  lines.push('2. Are any questionable/incorrect actions actually correct for this operation?')
  lines.push('3. Are the settings recommendations actionable and specific?')
  lines.push('4. Should any thresholds be adjusted based on this review?')

  return lines.join('\n')
}
