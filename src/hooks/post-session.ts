#!/usr/bin/env -S npx tsx

import fs from 'fs'
import { extractRecords } from '../lib/extract.js'
import { findGitRoot } from '../lib/context.js'
import { findSimilar, insertRecord, updateRecord } from '../lib/milvus.js'
import { parseTranscript } from '../lib/transcript.js'
import type { MemoryRecord, SessionEndInput } from '../lib/types.js'

async function main(): Promise<void> {
  const payload = await readHookInput()
  if (!payload) return

  if (payload.hook_event_name !== 'SessionEnd') {
    console.error('[claude-memory] Unexpected hook event:', payload.hook_event_name)
    return
  }

  if (payload.reason === 'clear') {
    console.error('[claude-memory] SessionEnd reason=clear; skipping extraction.')
    return
  }

  if (!payload.transcript_path || !fs.existsSync(payload.transcript_path)) {
    console.warn(`[claude-memory] Transcript not found; skipping extraction. path=${payload.transcript_path ?? 'missing'}`)
    return
  }

  const transcript = await parseTranscript(payload.transcript_path)
  if (transcript.parseErrors > 0) {
    console.error(`[claude-memory] Transcript parse warnings: ${transcript.parseErrors}`)
  }

  const projectRoot = findGitRoot(payload.cwd) ?? payload.cwd
  const records = await extractRecords(transcript, {
    sessionId: payload.session_id,
    cwd: payload.cwd,
    project: projectRoot,
    transcriptPath: payload.transcript_path
  })

  if (records.length === 0) {
    console.error('[claude-memory] No records extracted.')
    return
  }

  let inserted = 0
  let updated = 0
  let skipped = 0

  for (const record of records) {
    const matches = await findSimilar(record)
    if (matches.length > 0) {
      const existing = matches[0].record
      const updates = buildUpdates(existing, record)
      if (Object.keys(updates).length > 0) {
        await updateRecord(existing.id, updates)
        updated += 1
      } else {
        skipped += 1
      }
      continue
    }

    const prepared = applyUsageCounters(record)
    await insertRecord(prepared)
    inserted += 1
  }

  console.error(`[claude-memory] Extraction complete: inserted=${inserted}, updated=${updated}, skipped=${skipped}`)
}

function buildUpdates(existing: MemoryRecord, incoming: MemoryRecord): Partial<MemoryRecord> {
  const updates: Partial<MemoryRecord> = {
    lastUsed: Date.now()
  }

  const { successDelta, failureDelta } = deriveUsageDelta(incoming)
  if (successDelta !== 0) {
    updates.successCount = (existing.successCount ?? 0) + successDelta
  }
  if (failureDelta !== 0) {
    updates.failureCount = (existing.failureCount ?? 0) + failureDelta
  }

  if (!existing.project && incoming.project) updates.project = incoming.project
  if (!existing.domain && incoming.domain) updates.domain = incoming.domain

  if (existing.type === 'command' && incoming.type === 'command') {
    const commandUpdates = updates as Partial<typeof existing>
    const contextUpdates: Partial<typeof existing.context> = {}
    if (!existing.context.project && incoming.context.project) contextUpdates.project = incoming.context.project
    if (!existing.context.cwd && incoming.context.cwd) contextUpdates.cwd = incoming.context.cwd
    if (!existing.context.intent && incoming.context.intent) contextUpdates.intent = incoming.context.intent
    if (Object.keys(contextUpdates).length > 0) {
      commandUpdates.context = { ...existing.context, ...contextUpdates }
    }
    if (!existing.truncatedOutput && incoming.truncatedOutput) commandUpdates.truncatedOutput = incoming.truncatedOutput
    if (!existing.resolution && incoming.resolution) commandUpdates.resolution = incoming.resolution
  }

  if (existing.type === 'error' && incoming.type === 'error') {
    const errorUpdates = updates as Partial<typeof existing>
    const contextUpdates: Partial<typeof existing.context> = {}
    if (!existing.context.file && incoming.context.file) contextUpdates.file = incoming.context.file
    if (!existing.context.tool && incoming.context.tool) contextUpdates.tool = incoming.context.tool
    if (Object.keys(contextUpdates).length > 0) {
      errorUpdates.context = { ...existing.context, ...contextUpdates }
    }
    if (!existing.cause && incoming.cause) errorUpdates.cause = incoming.cause
  }

  if (existing.type === 'procedure' && incoming.type === 'procedure') {
    const procedureUpdates = updates as Partial<typeof existing>
    const contextUpdates: Partial<typeof existing.context> = {}
    if (!existing.context.project && incoming.context.project) contextUpdates.project = incoming.context.project
    if (Object.keys(contextUpdates).length > 0) {
      procedureUpdates.context = { ...existing.context, ...contextUpdates }
    }
    if (!existing.verification && incoming.verification) procedureUpdates.verification = incoming.verification
    if (!existing.prerequisites && incoming.prerequisites) procedureUpdates.prerequisites = incoming.prerequisites
  }

  if (existing.type === 'discovery' && incoming.type === 'discovery') {
    const discoveryUpdates = updates as Partial<typeof existing>
    if (!existing.where && incoming.where) discoveryUpdates.where = incoming.where
    if (!existing.evidence && incoming.evidence) discoveryUpdates.evidence = incoming.evidence
  }

  return updates
}

function applyUsageCounters(record: MemoryRecord): MemoryRecord {
  const { successDelta, failureDelta } = deriveUsageDelta(record)
  return {
    ...record,
    successCount: (record.successCount ?? 0) + successDelta,
    failureCount: (record.failureCount ?? 0) + failureDelta,
    lastUsed: Date.now()
  }
}

function deriveUsageDelta(record: MemoryRecord): { successDelta: number; failureDelta: number } {
  if (record.type === 'command') {
    if (record.outcome === 'success') return { successDelta: 1, failureDelta: 0 }
    if (record.outcome === 'failure') return { successDelta: 0, failureDelta: 1 }
    return { successDelta: 0, failureDelta: 1 }
  }

  if (record.type === 'error') {
    return { successDelta: 0, failureDelta: 1 }
  }

  return { successDelta: 0, failureDelta: 0 }
}

async function readHookInput(): Promise<SessionEndInput | null> {
  const raw = await readStdin()
  if (!raw.trim()) {
    console.error('[claude-memory] Empty hook input.')
    return null
  }

  try {
    return JSON.parse(raw) as SessionEndInput
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to parse hook input: ${message}`)
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    process.stdin.setEncoding('utf-8')
    process.stdin.on('data', chunk => {
      data += chunk
    })
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', reject)
  })
}

main()
  .then(() => {
    process.exitCode = 0
  })
  .catch(error => {
    console.error('[claude-memory] post-session failed:', error)
    process.exitCode = 2
  })
