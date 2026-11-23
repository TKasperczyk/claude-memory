#!/usr/bin/env -S npx tsx

import fs from 'fs'
import { randomUUID } from 'crypto'
import { SKIP_MARKER, getCommandFilePath } from '../lib/claude-commands.js'
import { isProcessEntrypoint, readFileIfExists } from '../lib/shared.js'
import { findGitRoot, formatRecordSnippet, stripNoiseWords } from '../lib/context.js'
import { loadConfig } from '../lib/config.js'
import { canonicalizePath } from '../lib/paths.js'
import { loadSettings } from '../lib/settings.js'
import { queryDaemon } from '../lib/daemon-client.js'
import { recordPrePromptTelemetry } from '../lib/pre-prompt-telemetry.js'
import { recordRetrievalEvents } from '../lib/retrieval-events.js'
import type { handlePrePrompt as HandlePrePromptFn, PrePromptDiagnostics, PrePromptResult } from '../lib/retrieval.js'
import {
  type HybridSearchResult,
  type InjectionStatus,
  type MemoryRecord,
  type UserPromptSubmitInput
} from '../lib/types.js'
import { appendSessionTracking, markInjectedForSuppression } from '../lib/session-tracking.js'

export type { PrePromptDiagnostics, PrePromptResult }

let lancedbLoaded = false

export async function handlePrePrompt(
  ...args: Parameters<typeof HandlePrePromptFn>
): ReturnType<typeof HandlePrePromptFn> {
  lancedbLoaded = true
  const { handlePrePrompt: run } = await import('../lib/retrieval.js')
  return run(...args)
}

async function closeLanceDBIfLoaded(): Promise<void> {
  if (!lancedbLoaded) return
  const { closeLanceDB } = await import('../lib/lancedb.js')
  await closeLanceDB()
}

const TASK_NOTIFICATION_PREFIX = '<task-notification>'
const TRANSCRIPT_TAIL_MAX_BYTES = 64 * 1024
const MAX_TASK_NOTIFICATION_TAIL_SCAN = 20
const TRAILING_BOOKKEEPING_TYPES = new Set([
  'queue-operation',
  'progress',
  'last-prompt',
  'ai-title',
  'mode',
  'permission-mode',
  'atis-latch',
  'file-history-snapshot',
  'file-history-delta',
  'tools-used'
])
const IMAGE_ONLY_PROMPT_REGEX = /^\[Image #\d+\](?:\s*\[Image #\d+\])*$/i
const BARE_SLASH_COMMAND_REGEX = /^\/[a-zA-Z0-9_-]+$/
const TRIVIAL_PHRASES = new Set([
  'y', 'yes', 'yeah', 'yep', 'yup', 'ya', 'aye',
  'n', 'no', 'nope', 'nah',
  'k', 'kk', 'ok', 'okay', 'alright', 'all right', 'sure', 'fine',
  'good', 'great', 'nice', 'cool', 'perfect', 'awesome', 'sweet', 'lgtm',
  'thanks', 'thank you', 'thx', 'ty', 'cheers',
  'hi', 'hello', 'hey', 'ping',
  'continue', 'go', 'go on', 'go ahead', 'proceed', 'do it', 'please do',
  'yes please', 'ok go ahead', 'okay go ahead', 'yeah go ahead', 'yes go ahead',
  'k go ahead', 'sure go ahead', 'alright go ahead',
  'ok do it', 'okay do it', 'yeah do it', 'yes do it', 'sure do it',
  'sounds good', 'looks good', 'looks good to me', 'makes sense',
  'sounds good go ahead', 'looks good go ahead', 'go for it', 'ship it',
  'done', 'ok done', 'cancel', 'stop', 'wait', 'nevermind', 'never mind'
])
const TRIVIAL_FILLER_WORDS = new Set([
  'y', 'yes', 'yeah', 'yep', 'yup', 'ok', 'okay', 'k', 'kk', 'alright', 'sure',
  'fine', 'good', 'great', 'nice', 'cool', 'perfect', 'awesome', 'lgtm',
  'sounds', 'looks', 'i', 'agree', 'with', 'you', 'go', 'ahead', 'please',
  'do', 'it', 'proceed', 'continue', 'thanks', 'thank', 'thx', 'ty', 'but',
  'just', 'that', 'this', 'one', 'final', 'for', 'now', 'done', 'all', 'right',
  'no', 'nope', 'nah', 'and', 'then', 'lets', "let's", 'on', 'both', 'them'
])

/**
 * Stage-0 deterministic gate: skip embeddings, DB search, and LLM calls for
 * non-technical conversational fillers, image-only placeholders, and bare
 * slash commands that carry no retrieval intent.
 */
export function isTrivialPrompt(prompt: string): boolean {
  const trimmed = prompt.trim()
  if (!trimmed) return true
  if (IMAGE_ONLY_PROMPT_REGEX.test(trimmed)) return true
  if (BARE_SLASH_COMMAND_REGEX.test(trimmed)) return true

  // Never skip prompts containing code, paths, URLs, flags, or explicit questions.
  if (/[`\\/?]|--[a-z0-9]|https?:\/\/|\.[a-z0-9]{1,5}\b/i.test(trimmed)) return false

  const normalized = trimmed
    .toLowerCase()
    .replace(/[!.,;:'"()\[\]]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!normalized) return true
  if (TRIVIAL_PHRASES.has(normalized)) return true

  const words = normalized.split(' ')
  if (words.length <= 8 && words.every(word => TRIVIAL_FILLER_WORDS.has(word))) {
    return true
  }
  // Short numeric-only option selection ("go ahead with 2 and 3", "do 1", "option 2")
  if (
    words.length <= 6
    && words.every(word => TRIVIAL_FILLER_WORDS.has(word) || /^(?:\d+|option|number|choice)$/.test(word))
  ) {
    return true
  }

  return false
}

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

type TaskNotificationTranscriptEntry = {
  type?: unknown
  isSidechain?: unknown
  isMeta?: unknown
  origin?: { kind?: unknown }
  promptSource?: unknown
  message?: {
    role?: unknown
    content?: unknown
  }
  attachment?: {
    type?: unknown
    prompt?: unknown
    commandMode?: unknown
    humanTurn?: unknown
    origin?: { kind?: unknown }
  }
}

function isProvenTaskNotificationUserEntry(
  entry: TaskNotificationTranscriptEntry,
  prompt: string
): boolean {
  return entry.type === 'user'
    && entry.message?.role === 'user'
    && entry.isSidechain !== true
    && entry.isMeta !== true
    && entry.origin?.kind === 'task-notification'
    && entry.promptSource === 'system'
    && typeof entry.message.content === 'string'
    && entry.message.content === prompt
}

function isProvenTaskNotificationQueuedAttachment(
  entry: TaskNotificationTranscriptEntry,
  prompt: string
): boolean {
  return entry.type === 'attachment'
    && entry.isSidechain !== true
    && entry.isMeta !== true
    && entry.attachment?.type === 'queued_command'
    && entry.attachment?.commandMode === 'task-notification'
    && entry.attachment?.origin?.kind === 'task-notification'
    && entry.attachment?.humanTurn !== true
    && typeof entry.attachment?.prompt === 'string'
    && entry.attachment.prompt === prompt
}

function isTrailingBookkeepingEntry(entry: TaskNotificationTranscriptEntry): boolean {
  if (typeof entry.type !== 'string') return false
  if (TRAILING_BOOKKEEPING_TYPES.has(entry.type)) return true
  // Non-queued_command attachments (e.g. model/environment/date/instructions/hook_success)
  // are metadata emitted alongside a prompt turn. Never skip past a queued_command attachment
  // so a human-queued prompt cannot inherit provenance from an earlier notification.
  if (entry.type === 'attachment' && entry.attachment?.type !== 'queued_command') {
    return true
  }
  return false
}

/**
 * Skip only task notifications that can be tied to the current transcript entry
 * (either a `type: "user"` turn or a mid-turn `queued_command` attachment with
 * `task-notification` provenance). Trailing non-conversation bookkeeping entries
 * are skipped while any malformed JSON, `assistant` turn, or non-matching prompt
 * fails open to retrieval.
 */
export function isMachineGeneratedTaskNotification(prompt: string, transcriptPath: string | undefined): boolean {
  // All observed task notifications start with this exact marker. Keep the common
  // path free of transcript I/O because this hook runs under a tight timeout.
  if (!prompt.startsWith(TASK_NOTIFICATION_PREFIX) || !transcriptPath) return false

  const tailLines = readTailTranscriptLines(transcriptPath)
  if (tailLines.length === 0) return false

  const scanFloor = Math.max(0, tailLines.length - MAX_TASK_NOTIFICATION_TAIL_SCAN)
  for (let index = tailLines.length - 1; index >= scanFloor; index -= 1) {
    let parsed: unknown
    try {
      parsed = JSON.parse(tailLines[index]) as unknown
    } catch {
      return false
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return false
    }
    const entry = parsed as TaskNotificationTranscriptEntry
    if (
      isProvenTaskNotificationUserEntry(entry, prompt)
      || isProvenTaskNotificationQueuedAttachment(entry, prompt)
    ) {
      return true
    }
    if (isTrailingBookkeepingEntry(entry)) {
      continue
    }
    return false
  }
  return false
}

function readTailTranscriptLines(transcriptPath: string): string[] {
  let descriptor: number | undefined
  try {
    descriptor = fs.openSync(transcriptPath, 'r')
    const size = fs.fstatSync(descriptor).size
    if (size <= 0) return []

    const bytesToRead = Math.min(size, TRANSCRIPT_TAIL_MAX_BYTES)
    const tailStart = size - bytesToRead
    const readStart = tailStart > 0 ? tailStart - 1 : 0
    const buffer = Buffer.allocUnsafe(size - readStart)
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, readStart)
    const precedingByte = tailStart > 0 && bytesRead > 0 ? buffer[0] : undefined
    let tail = buffer
      .subarray(tailStart > 0 ? 1 : 0, bytesRead)
      .toString('utf-8')

    if (tailStart > 0 && precedingByte !== 0x0a) {
      const firstNewline = tail.indexOf('\n')
      if (firstNewline < 0) return []
      tail = tail.slice(firstNewline + 1)
    }

    return tail
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
  } catch {
    return []
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor)
      } catch {
        // Fail open; retrieval should continue even if transcript cleanup fails.
      }
    }
  }
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

type PrePromptRuntime = {
  closeLanceDB: () => Promise<void>
  findGitRoot: typeof findGitRoot
  handlePrePrompt: typeof handlePrePrompt
  loadConfig: typeof loadConfig
  loadSettings: typeof loadSettings
  markInjectedForSuppression: typeof markInjectedForSuppression
  readHookInput: typeof readHookInput
  recordPrePromptTelemetry: typeof recordPrePromptTelemetry
  trackSession: typeof trackSession
  writeStdout: typeof writeStdout
}

const DEFAULT_RUNTIME: PrePromptRuntime = {
  closeLanceDB: closeLanceDBIfLoaded,
  findGitRoot,
  handlePrePrompt,
  loadConfig,
  loadSettings,
  markInjectedForSuppression,
  readHookInput,
  recordPrePromptTelemetry,
  trackSession,
  writeStdout
}

export async function main(runtimeOverrides: Partial<PrePromptRuntime> = {}): Promise<void> {
  const startedAt = Date.now()
  const runtime = { ...DEFAULT_RUNTIME, ...runtimeOverrides }
  const payload = await runtime.readHookInput()
  if (!payload) return

  const emitTelemetry = (
    status: InjectionStatus,
    collection: string | undefined,
    extra: {
      pipeline?: 'stage2-rerank' | 'legacy' | 'short-circuit'
      project?: string
      errorSignalCount?: number
      commandSignalCount?: number
      stage1CandidateCount?: number
      bm25HitCount?: number
      vectorHitCount?: number
      suppressedCount?: number
      rerankerCalled?: boolean
      rerankerAbstained?: boolean
      rerankerFallback?: boolean
      abstainReason?: string
      injectedIds?: string[]
      contextChars?: number
      stage1EmbedMs?: number
      stage1SearchMs?: number
      stage2RerankMs?: number
    } = {}
  ): void => {
    runtime.recordPrePromptTelemetry({
      timestamp: Date.now(),
      ...(payload.session_id ? { sessionId: payload.session_id } : {}),
      cwd: payload.cwd ?? '',
      ...(extra.project ? { project: extra.project } : {}),
      status,
      pipeline: extra.pipeline ?? 'short-circuit',
      promptLength: payload.prompt?.length ?? 0,
      errorSignalCount: extra.errorSignalCount ?? 0,
      commandSignalCount: extra.commandSignalCount ?? 0,
      stage1CandidateCount: extra.stage1CandidateCount ?? 0,
      bm25HitCount: extra.bm25HitCount ?? 0,
      vectorHitCount: extra.vectorHitCount ?? 0,
      suppressedCount: extra.suppressedCount ?? 0,
      rerankerCalled: extra.rerankerCalled ?? false,
      rerankerAbstained: extra.rerankerAbstained ?? false,
      rerankerFallback: extra.rerankerFallback ?? false,
      ...(extra.abstainReason ? { abstainReason: extra.abstainReason } : {}),
      injectedCount: extra.injectedIds?.length ?? 0,
      injectedIds: extra.injectedIds ?? [],
      contextChars: extra.contextChars ?? 0,
      timings: {
        totalMs: Date.now() - startedAt,
        ...(extra.stage1EmbedMs !== undefined ? { stage1EmbedMs: extra.stage1EmbedMs } : {}),
        ...(extra.stage1SearchMs !== undefined ? { stage1SearchMs: extra.stage1SearchMs } : {}),
        ...(extra.stage2RerankMs !== undefined ? { stage2RerankMs: extra.stage2RerankMs } : {})
      }
    }, { collection })
  }

  try {
    if (payload.hook_event_name !== 'UserPromptSubmit') {
      console.error('[claude-memory] Unexpected hook event:', payload.hook_event_name)
      return
    }

    if (!payload.prompt || !payload.prompt.trim()) {
      console.error('[claude-memory] Empty prompt; skipping injection.')
      runtime.trackSession(payload.session_id, [], [], payload.cwd, payload.prompt, 'empty_prompt')
      emitTelemetry('empty_prompt', undefined, { abstainReason: 'empty_prompt' })
      return
    }
    if (shouldSkipInjection(payload.prompt)) {
      console.error('[claude-memory] Skip marker detected; skipping injection.')
      return
    }
    if (isMachineGeneratedTaskNotification(payload.prompt, payload.transcript_path)) {
      console.error('[claude-memory] Machine-generated task notification detected; skipping injection.')
      return
    }
    if (isTrivialPrompt(payload.prompt)) {
      console.error('[claude-memory] Trivial prompt detected; skipping injection.')
      const projectRoot = runtime.findGitRoot(payload.cwd)
      const configRoot = projectRoot ?? (payload.cwd ? canonicalizePath(payload.cwd) : payload.cwd)
      const config = runtime.loadConfig(configRoot)
      runtime.trackSession(payload.session_id, [], [], payload.cwd, payload.prompt, 'trivial_prompt', config.lancedb.table)
      emitTelemetry('trivial_prompt', config.lancedb.table, {
        project: projectRoot,
        abstainReason: 'trivial_prompt'
      })
      return
    }

    const projectRoot = runtime.findGitRoot(payload.cwd)
    const configRoot = projectRoot ?? (payload.cwd ? canonicalizePath(payload.cwd) : payload.cwd)
    const config = runtime.loadConfig(configRoot)
    const settings = runtime.loadSettings()

    // Try warm local Unix-socket daemon when running and enabled (instant <0.2ms noop if not running).
    let result: Awaited<ReturnType<typeof handlePrePrompt>> | null = null
    const usingDefaultHandler = runtime.handlePrePrompt === DEFAULT_RUNTIME.handlePrePrompt
    if (usingDefaultHandler && settings.enableWarmDaemon !== false) {
      const daemonResp = await queryDaemon<{ result: Awaited<ReturnType<typeof handlePrePrompt>> }>(
        '/pre-prompt',
        { payload, projectRoot, config, settingsOverride: settings },
        { timeoutMs: settings.prePromptTimeoutMs }
      )
      if (daemonResp?.result) {
        result = daemonResp.result
      }
    }
    if (!result) {
      result = await runtime.handlePrePrompt(payload, config, { projectRoot, settingsOverride: settings })
    }
    const tel = result.telemetry
    const baseTelemetry = {
      pipeline: tel?.pipeline ?? (settings.enablePostRetrievalRerank ? 'stage2-rerank' : 'legacy'),
      project: tel?.project ?? projectRoot,
      errorSignalCount: result.signals.errors.length,
      commandSignalCount: result.signals.commands.length,
      stage1CandidateCount: tel?.stage1CandidateCount ?? result.results.length,
      bm25HitCount: tel?.bm25HitCount ?? 0,
      vectorHitCount: tel?.vectorHitCount ?? 0,
      suppressedCount: tel?.suppressedCount ?? 0,
      rerankerCalled: tel?.rerankerCalled ?? false,
      rerankerAbstained: tel?.rerankerAbstained ?? false,
      rerankerFallback: tel?.rerankerFallback ?? false,
      abstainReason: tel?.abstainReason,
      stage1EmbedMs: tel?.stage1EmbedMs,
      stage1SearchMs: tel?.stage1SearchMs,
      stage2RerankMs: tel?.stage2RerankMs
    } as const

    if (result.timedOut) {
      console.error(`[claude-memory] Pre-prompt timed out after ${settings.prePromptTimeoutMs}ms; skipping injection.`)
      runtime.trackSession(payload.session_id, [], [], payload.cwd, payload.prompt, 'timeout', config.lancedb.table)
      emitTelemetry('timeout', config.lancedb.table, { ...baseTelemetry, abstainReason: 'timeout' })
      return
    }

    if (result.results.length === 0) {
      console.error('[claude-memory] No matching memories found.')
      runtime.trackSession(payload.session_id, [], [], payload.cwd, payload.prompt, 'no_matches', config.lancedb.table)
      emitTelemetry('no_matches', config.lancedb.table, baseTelemetry)
      return
    }

    if (!result.context) {
      console.error('[claude-memory] Context empty after formatting.')
      runtime.trackSession(payload.session_id, [], [], payload.cwd, payload.prompt, 'no_matches', config.lancedb.table)
      emitTelemetry('no_matches', config.lancedb.table, { ...baseTelemetry, abstainReason: 'empty_context' })
      return
    }

    let injected = false
    try {
      await runtime.writeStdout(result.context)
      injected = true
    } catch (error) {
      console.error('[claude-memory] Failed to write injected context:', error)
    }

    if (injected) {
      if (settings.enableTopicSuppression && result.suppressionWritebackVersion !== undefined) {
        try {
          runtime.markInjectedForSuppression(
            payload.session_id,
            result.injectedRecords.map(record => record.id),
            settings.recentlyInjectedWindow,
            config.lancedb.table,
            { expectedRetrievalStateVersion: result.suppressionWritebackVersion }
          )
        } catch (error) {
          console.error('[claude-memory] Failed to mark injected memories for suppression:', error)
        }
      }
      runtime.trackSession(
        payload.session_id,
        result.injectedRecords,
        result.results,
        payload.cwd,
        payload.prompt,
        'injected',
        config.lancedb.table
      )
      emitTelemetry('injected', config.lancedb.table, {
        ...baseTelemetry,
        injectedIds: result.injectedRecords.map(record => record.id),
        contextChars: result.context.length
      })
    } else {
      runtime.trackSession(payload.session_id, [], [], payload.cwd, payload.prompt, 'error', config.lancedb.table)
      emitTelemetry('error', config.lancedb.table, { ...baseTelemetry, abstainReason: 'stdout_error' })
    }
  } finally {
    await runtime.closeLanceDB()
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
    appendSessionTracking(sessionId, entries, cwd, cleanPrompt, status, collection)
    if (status === 'injected' && entries.length > 0) {
      const groupId = randomUUID()
      const coInjectedIds = entries.map(entry => entry.id)
      recordRetrievalEvents(entries.map(entry => ({
        id: entry.id,
        type: entry.type,
        timestamp: entry.injectedAt,
        groupId,
        coInjectedIds
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
if (isProcessEntrypoint(import.meta.url)) {
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
