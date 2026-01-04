#!/usr/bin/env -S npx tsx

import fs from 'fs'
import { extractRecords } from '../lib/extract.js'
import { findGitRoot } from '../lib/context.js'
import { initMilvus, findSimilar, insertRecord, updateRecord } from '../lib/milvus.js'
import { parseTranscript } from '../lib/transcript.js'
import { DEFAULT_CONFIG, type Config, type MemoryRecord, type SessionEndInput } from '../lib/types.js'

export interface PostSessionResult {
  inserted: number
  updated: number
  skipped: number
  records: MemoryRecord[]
  reason?: 'clear' | 'no_transcript' | 'no_records' | 'wrong_event'
}

/**
 * Core post-session hook logic. Exported for testing.
 *
 * Extracts records from transcript and stores them in Milvus.
 */
export async function handlePostSession(
  input: SessionEndInput,
  config: Config = DEFAULT_CONFIG
): Promise<PostSessionResult> {
  if (input.hook_event_name !== 'SessionEnd') {
    return { inserted: 0, updated: 0, skipped: 0, records: [], reason: 'wrong_event' }
  }

  if (input.reason === 'clear') {
    return { inserted: 0, updated: 0, skipped: 0, records: [], reason: 'clear' }
  }

  if (!input.transcript_path || !fs.existsSync(input.transcript_path)) {
    return { inserted: 0, updated: 0, skipped: 0, records: [], reason: 'no_transcript' }
  }

  const transcript = await parseTranscript(input.transcript_path)
  if (transcript.parseErrors > 0) {
    console.error(`[claude-memory] Transcript parse warnings: ${transcript.parseErrors}`)
  }

  const projectRoot = findGitRoot(input.cwd) ?? input.cwd
  const records = await extractRecords(transcript, {
    sessionId: input.session_id,
    cwd: input.cwd,
    project: projectRoot,
    transcriptPath: input.transcript_path
  })

  if (records.length === 0) {
    return { inserted: 0, updated: 0, skipped: 0, records: [], reason: 'no_records' }
  }

  let inserted = 0
  let updated = 0
  let skipped = 0

  for (const record of records) {
    const matches = await findSimilar(record, 0.9, 1, config)
    if (matches.length > 0) {
      const existing = matches[0].record
      const updates = buildUpdates(existing, record)
      if (Object.keys(updates).length > 0) {
        await updateRecord(existing.id, updates, config)
        updated += 1
      } else {
        skipped += 1
      }
      continue
    }

    const prepared = applyUsageCounters(record)
    await insertRecord(prepared, config)
    inserted += 1
  }

  return { inserted, updated, skipped, records }
}

export function buildUpdates(existing: MemoryRecord, incoming: MemoryRecord): Partial<MemoryRecord> {
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

export function applyUsageCounters(record: MemoryRecord): MemoryRecord {
  const { successDelta, failureDelta } = deriveUsageDelta(record)
  return {
    ...record,
    successCount: (record.successCount ?? 0) + successDelta,
    failureCount: (record.failureCount ?? 0) + failureDelta,
    lastUsed: Date.now()
  }
}

export function deriveUsageDelta(record: MemoryRecord): { successDelta: number; failureDelta: number } {
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

function loadConfig(root: string): Config {
  // In future, can load from project-specific config.json
  return DEFAULT_CONFIG
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

  if (!payload.transcript_path) {
    console.warn('[claude-memory] Transcript not found; skipping extraction. path=missing')
    return
  }

  const config = loadConfig(payload.cwd)
  await initMilvus(config)

  const result = await handlePostSession(payload, config)

  if (result.reason === 'no_transcript') {
    console.warn(`[claude-memory] Transcript not found; skipping extraction. path=${payload.transcript_path}`)
    return
  }

  if (result.reason === 'no_records') {
    console.error('[claude-memory] No records extracted.')
    return
  }

  console.error(`[claude-memory] Extraction complete: inserted=${result.inserted}, updated=${result.updated}, skipped=${result.skipped}`)
}

// Only run main when executed directly (not imported)
const isMainModule = import.meta.url === `file://${process.argv[1]}`
if (isMainModule) {
  main()
    .then(() => {
      process.exitCode = 0
    })
    .catch(error => {
      console.error('[claude-memory] post-session failed:', error)
      process.exitCode = 2
    })
}
