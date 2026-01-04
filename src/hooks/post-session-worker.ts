#!/usr/bin/env node
/**
 * Post-session worker - runs extraction in background.
 * Spawned by post-session.ts launcher as a detached process.
 */

import { initMilvus } from '../lib/milvus.js'
import { DEFAULT_CONFIG, type Config, type ExtractionHookInput, type HookInput } from '../lib/types.js'
import { handlePostSession } from './post-session.js'

function loadConfig(root: string): Config {
  return DEFAULT_CONFIG
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
  const raw = await readStdin()
  if (!raw.trim()) {
    console.error('[claude-memory] Empty hook input.')
    return
  }

  let basePayload: HookInput
  try {
    basePayload = JSON.parse(raw) as HookInput
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[claude-memory] Failed to parse hook input: ${message}`)
    return
  }

  // Accept both SessionEnd and PreCompact events
  if (basePayload.hook_event_name !== 'SessionEnd' && basePayload.hook_event_name !== 'PreCompact') {
    console.error('[claude-memory] Unexpected hook event:', basePayload.hook_event_name)
    return
  }

  const payload = basePayload as ExtractionHookInput

  // Skip extraction if session was cleared
  if (payload.hook_event_name === 'SessionEnd' && payload.reason === 'clear') {
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

main()
  .then(() => {
    process.exitCode = 0
  })
  .catch(error => {
    console.error('[claude-memory] post-session-worker failed:', error)
    process.exitCode = 2
  })
