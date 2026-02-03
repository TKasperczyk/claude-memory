#!/usr/bin/env -S npx tsx

import path from 'path'
import { fileURLToPath } from 'url'
import { SKIP_MARKER, getCommandFilePath } from '../lib/claude-commands.js'
import { readFileIfExists } from '../lib/shared.js'
import { closeMilvus } from '../lib/milvus.js'
import { findGitRoot, formatRecordSnippet, stripNoiseWords } from '../lib/context.js'
import { loadConfig } from '../lib/config.js'
import { loadSettings } from '../lib/settings.js'
import { handlePrePrompt } from '../lib/retrieval.js'
import { recordRetrievalEvents } from '../lib/retrieval-events.js'
import {
  type HybridSearchResult,
  type InjectionStatus,
  type MemoryRecord,
  type UserPromptSubmitInput
} from '../lib/types.js'
import { appendSessionTracking } from '../lib/session-tracking.js'

export { handlePrePrompt } from '../lib/retrieval.js'
export type { PrePromptDiagnostics, PrePromptResult } from '../lib/retrieval.js'
function shouldSkipInjection(prompt: string): boolean {
  if (prompt.includes(SKIP_MARKER)) {
    return true
  }
  const trimmed = prompt.trim()
  const match = trimmed.match(/^\/([a-zA-Z0-9_-]+)(?:\s|$)/)
  if (!match) {
    return false
  }
  const commandName = match[1]
  const userCommandPath = getCommandFilePath(commandName)
  if (commandFileHasSkipMarker(userCommandPath)) {
    return true
  }
  return false
}
function commandFileHasSkipMarker(filePath: string): boolean {
  try {
    const content = readFileIfExists(filePath)
    return content !== null && content.includes(SKIP_MARKER)
  } catch {
    return false
  }
}
async function readHookInput(): Promise<UserPromptSubmitInput | null> {
  const raw = await new Promise<string>((resolve, reject) => {
    let data = ''
    process.stdin.setEncoding('utf-8')
    process.stdin.on('data', chunk => {
      data += chunk
    })
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', reject)
  })
  if (!raw.trim()) {
    console.error('[claude-memory] Empty hook input.')
    return null
  }

  try {
    return JSON.parse(raw) as UserPromptSubmitInput
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to parse hook input: ${message}`)
  }
}
async function main(): Promise<void> {
  const payload = await readHookInput()
  if (!payload) return

  try {
    if (payload.hook_event_name !== 'UserPromptSubmit') {
      console.error('[claude-memory] Unexpected hook event:', payload.hook_event_name)
      return
    }

    if (!payload.prompt || !payload.prompt.trim()) {
      console.error('[claude-memory] Empty prompt; skipping injection.')
      trackSession(payload.session_id, [], [], payload.cwd, payload.prompt, 'empty_prompt')
      return
    }
    if (shouldSkipInjection(payload.prompt)) {
      console.error('[claude-memory] Skip marker detected; skipping injection.')
      return
    }

    const projectRoot = findGitRoot(payload.cwd)
    const configRoot = projectRoot ?? payload.cwd
    const config = loadConfig(configRoot)
    const settings = loadSettings()

    const result = await handlePrePrompt(payload, config, { projectRoot, settingsOverride: settings })

    if (result.timedOut) {
      console.error(`[claude-memory] Pre-prompt timed out after ${settings.prePromptTimeoutMs}ms; skipping injection.`)
      trackSession(payload.session_id, [], [], payload.cwd, payload.prompt, 'timeout', config.milvus.collection)
      return
    }

    if (result.results.length === 0) {
      console.error('[claude-memory] No matching memories found.')
      trackSession(payload.session_id, [], [], payload.cwd, payload.prompt, 'no_matches', config.milvus.collection)
      return
    }

    if (!result.context) {
      console.error('[claude-memory] Context empty after formatting.')
      trackSession(payload.session_id, [], [], payload.cwd, payload.prompt, 'no_matches', config.milvus.collection)
      return
    }

    let injected = false
    try {
      await writeStdout(result.context)
      injected = true
    } catch (error) {
      console.error('[claude-memory] Failed to write injected context:', error)
    }

    if (injected) {
      trackSession(
        payload.session_id,
        result.injectedRecords,
        result.results,
        payload.cwd,
        payload.prompt,
        'injected',
        config.milvus.collection
      )
    } else {
      trackSession(payload.session_id, [], [], payload.cwd, payload.prompt, 'error', config.milvus.collection)
    }
  } finally {
    await closeMilvus()
  }
}
function trackSession(
  sessionId: string,
  records: MemoryRecord[],
  searchResults: HybridSearchResult[],
  cwd: string,
  prompt: string,
  status: InjectionStatus,
  collection?: string
): void {
  if (!sessionId) return
  try {
    const cleanPrompt = stripNoiseWords(prompt)
    const resultById = new Map(searchResults.map(r => [r.record.id, r]))
    const injectedAt = Date.now()
    const entries = records.map(record => {
      const searchResult = resultById.get(record.id)
      const snippet = formatRecordSnippet(record) ?? `type: ${record.type}`
      return {
        id: record.id,
        snippet: snippet.replace(/\s+/g, ' ').trim(),
        type: record.type,
        injectedAt,
        similarity: searchResult?.similarity,
        keywordMatch: searchResult?.keywordMatch,
        score: searchResult?.score
      }
    })
    appendSessionTracking(sessionId, entries, cwd, cleanPrompt, status)
    if (status === 'injected' && entries.length > 0) {
      recordRetrievalEvents(entries.map(entry => ({
        id: entry.id,
        type: entry.type,
        timestamp: entry.injectedAt
      })), { collection })
    }
  } catch (error) {
    console.error('[claude-memory] Failed to track session:', error)
  }
}
function writeStdout(value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(value, error => {
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    })
  })
}
let hardExitTimer: NodeJS.Timeout | null = null
function scheduleHardExit(exitCode?: number): void {
  if (hardExitTimer) return
  const code = typeof exitCode === 'number' ? exitCode : (process.exitCode ?? 0)
  hardExitTimer = setTimeout(() => process.exit(code), 50)
  hardExitTimer.unref()
}
const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
const isMainModule = fileURLToPath(import.meta.url) === entryPath
if (isMainModule) {
  main()
    .then(() => {
      process.exitCode = 0
    })
    .catch(error => {
      console.error('[claude-memory] pre-prompt failed:', error)
      process.exitCode = 2
    })
    .finally(() => {
      scheduleHardExit(typeof process.exitCode === 'number' ? process.exitCode : undefined)
    })
}
