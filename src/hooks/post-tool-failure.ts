#!/usr/bin/env node

import fs from 'fs'
import { loadConfig } from '../lib/config.js'
import { findAncestorProjects, findGitRoot, extractSignals, formatRecordSnippet } from '../lib/context.js'
import { queryDaemon } from '../lib/daemon-client.js'
import { isPlainObject } from '../lib/parsing.js'
import { canonicalizePath } from '../lib/paths.js'
import { isCatchAllDirectory, resolveAttributionScope } from '../lib/scope-attribution.js'
import { loadSessionTracking, markInjectedForSuppression } from '../lib/session-tracking.js'
import { loadSettings } from '../lib/settings.js'
import { isProcessEntrypoint, truncateText } from '../lib/shared.js'
import {
  DEFAULT_CONFIG,
  type Config,
  type HybridSearchResult,
  type MemoryRecord,
  type PostToolUseFailureInput
} from '../lib/types.js'

const MAX_FAILURE_MATCHES = 2
const PROJECT_MIN_BM25_SCORE = 1.5
const SHARED_SCOPE_MIN_BM25_SCORE = 3.0
const HIGH_SIGNAL_CODE_REGEX = /\b(?:SQLITE_[A-Z_]+|ERR_[A-Z0-9_]+|ORA-\d{5}|E[A-Z]{4,}|HTTP\s*[45]\d{2}|TS\d{4,5}|ENOENT|EACCES|EADDRINUSE|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOMEM|SIGSEGV|SIGKILL|OOM)\b/
const SPECIFIC_CODE_REGEX = /^(?:sqlite_[a-z_]+|err_[a-z0-9_]+|ora-\d{5}|eaddrinuse)$/i

const GENERIC_FAILURE_TOKENS = new Set([
  // English stopwords & filler prose
  'about', 'after', 'all', 'also', 'and', 'any', 'are', 'because', 'been', 'before',
  'being', 'between', 'both', 'but', 'can', 'could', 'did', 'does', 'doing', 'done',
  'down', 'during', 'each', 'else', 'even', 'every', 'first', 'for', 'from', 'get',
  'getting', 'had', 'has', 'have', 'having', 'here', 'how', 'into', 'its', 'just',
  'keep', 'last', 'like', 'make', 'many', 'may', 'more', 'most', 'must', 'need',
  'needs', 'new', 'next', 'now', 'off', 'old', 'one', 'only', 'onto', 'other',
  'our', 'out', 'over', 'own', 'same', 'see', 'set', 'setting', 'should', 'show',
  'since', 'some', 'still', 'such', 'take', 'than', 'that', 'the', 'their', 'them',
  'then', 'there', 'these', 'they', 'this', 'those', 'through', 'too', 'two',
  'under', 'until', 'use', 'used', 'using', 'very', 'want', 'was', 'way', 'were',
  'what', 'when', 'where', 'which', 'while', 'who', 'why', 'will', 'with', 'without',
  'work', 'working', 'would', 'your',
  // Generic shell / dev / error boilerplate
  'add', 'app', 'arg', 'args', 'array', 'async', 'await', 'awk', 'bash', 'bin',
  'bool', 'boolean', 'build', 'call', 'cannot', 'cat', 'change', 'check', 'class',
  'client', 'close', 'cmd', 'code', 'command', 'config', 'const', 'create', 'creating',
  'current', 'data', 'date', 'debug', 'default', 'delete', 'denied', 'dev', 'dev/null',
  'dir', 'directory', 'echo', 'empty', 'enable', 'end', 'entry', 'env', 'err',
  'error', 'etc', 'eval', 'exec', 'exit', 'exited', 'expected', 'export', 'fail',
  'failed', 'failure', 'false', 'fetch', 'field', 'file', 'files', 'find', 'fix',
  'flag', 'format', 'found', 'func', 'function', 'global', 'grep', 'head', 'help',
  'home', 'host', 'http', 'https', 'import', 'index', 'info', 'init', 'input',
  'install', 'instead', 'int', 'invalid', 'item', 'items', 'json', 'key', 'keys',
  'kill', 'len', 'length', 'let', 'line', 'lines', 'list', 'load', 'local', 'log',
  'logs', 'main', 'match', 'message', 'method', 'missing', 'mnt', 'mode', 'module',
  'move', 'name', 'node', 'none', 'not', 'null', 'num', 'number', 'obj', 'object',
  'open', 'opt', 'option', 'options', 'output', 'package', 'param', 'params', 'parse',
  'pass', 'path', 'paths', 'permission', 'port', 'print', 'proc', 'process', 'project',
  'read', 'reading', 'remove', 'req', 'request', 'res', 'response', 'result', 'return',
  'returned', 'root', 'run', 'running', 'save', 'script', 'sed', 'send', 'server',
  'service', 'shell', 'size', 'sleep', 'sort', 'src', 'start', 'state', 'status',
  'stderr', 'stdin', 'stdout', 'step', 'stop', 'str', 'string', 'sudo', 'sync',
  'sys', 'system', 'tail', 'target', 'task', 'temp', 'test', 'tests', 'text', 'time',
  'timeout', 'tmp', 'token', 'tokens', 'tool', 'traceback', 'true', 'try', 'type',
  'types', 'unable', 'undefined', 'uniq', 'unknown', 'update', 'url', 'user', 'usr',
  'val', 'value', 'values', 'var', 'version', 'wait', 'warn', 'warning', 'which',
  'write', 'writing', 'xargs', 'zero'
])

const NON_TECHNICAL_DENIAL_REGEX = /permission for this command was denied|user doesn't want to proceed|tool_use_error|hook rejected|interrupted by user|elided a [\d,]+-char tool result|tool call did not complete|the turn was ended/i
const BENIGN_NO_MATCH_COMMAND_REGEX = /^\s*(?:cd\s+[^;&|]+&&\s*|cd\s+[^;&|]+;\s*)?(?:grep|egrep|fgrep|rg|diff|cmp|test|\[|ls|sed|head|tail|cat)\b/
const DIAGNOSTIC_FAILURE_HINT_REGEX = /\b(?:error|exception|failed|fatal|traceback|panic|refused|timed?\s*out|not found|no such file|no matches found|no space left|assertion failed|address already in use|broken pipe|connection closed|connection reset|cannot|permission denied|syntaxerror|typeerror|referenceerror|module not found|command not found|segfault|killed|oom|conflict|locked)\b/i
const LEADING_EXIT_CODE_REGEX = /^\s*Exit code \d+\s*(?:\r?\n|$)/i

export interface FailureSignature {
  command: string
  errorText: string
  query: string
  distinctiveTokens: Set<string>
  errorTokens: Set<string>
  errorCodes: Set<string>
}

function extractTextFromUnknown(value: unknown): string {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return ''
  if (Array.isArray(value)) {
    return value.map(extractTextFromUnknown).filter(Boolean).join('\n')
  }
  const obj = value as Record<string, unknown>
  const parts: string[] = []
  for (const key of ['error', 'stderr', 'message', 'content', 'stdout', 'text']) {
    if (typeof obj[key] === 'string' && obj[key].trim()) {
      parts.push(obj[key] as string)
    }
  }
  return parts.join('\n')
}

function tokenizeDistinctive(text: string): Set<string> {
  // Split on non-alphanumeric/underscore boundaries to align with LanceDB's `simple` FTS tokenizer.
  const raw = text
    .toLowerCase()
    .match(/[a-z0-9_]{3,}/g) ?? []
  const result = new Set<string>()
  for (const token of raw) {
    const cleaned = token.replace(/^_+|_+$/g, '')
    if (cleaned.length < 3) continue
    if (/^\d+$/.test(cleaned)) continue
    if (GENERIC_FAILURE_TOKENS.has(cleaned)) continue
    result.add(cleaned)
  }
  return result
}

function extractErrorCodes(text: string): Set<string> {
  const matches = text.match(new RegExp(HIGH_SIGNAL_CODE_REGEX.source, 'g')) ?? []
  return new Set(matches.map(m => m.toLowerCase()))
}

function buildRecordProblemText(record: MemoryRecord): string {
  const entities = record.entities?.join(' ') ?? ''
  switch (record.type) {
    case 'error':
      return [record.errorText, record.errorType, record.cause ?? '', entities].filter(Boolean).join(' ')
    case 'warning':
      return [record.avoid, entities].filter(Boolean).join(' ')
    case 'command':
      return [record.command, record.context?.intent ?? '', entities].filter(Boolean).join(' ')
    case 'discovery':
      return [record.what, record.where, entities].filter(Boolean).join(' ')
    case 'procedure':
      return [record.name, entities].filter(Boolean).join(' ')
  }
}

/**
 * Deterministically extract a focused BM25 failure signature from a Claude Code
 * PostToolUseFailure (or failed Bash PostToolUse) payload.
 */
export function extractFailureSignature(
  payload: PostToolUseFailureInput | Record<string, unknown>
): FailureSignature | null {
  if (!isPlainObject(payload)) return null
  if (payload.is_interrupt === true) return null

  const toolInput = isPlainObject(payload.tool_input) ? payload.tool_input : {}
  const command = typeof toolInput.command === 'string' ? toolInput.command.trim() : ''
  const rawError = [
    typeof payload.error === 'string' ? payload.error : '',
    extractTextFromUnknown(payload.tool_response)
  ].filter(Boolean).join('\n').trim()

  if (!rawError && !command) return null
  if (NON_TECHNICAL_DENIAL_REGEX.test(rawError)) return null

  // Strip Claude Code's synthetic leading "Exit code N" header before signal extraction so
  // non-zero exit codes with ordinary stdout (ls, grep, sed, git merge) don't masquerade as errors.
  const diagnosticBody = rawError.replace(LEADING_EXIT_CODE_REGEX, '').trim()
  if (!diagnosticBody) return null

  const signals = extractSignals(diagnosticBody, '')
  const errorCodes = extractErrorCodes(diagnosticBody.slice(0, 1500))
  // Skip benign grep/diff/test/ls exit-code-1 ("no matches") or opaque outputs with no error diagnostic.
  if (
    signals.errors.length === 0
    && errorCodes.size === 0
    && (
      BENIGN_NO_MATCH_COMMAND_REGEX.test(command)
      || !DIAGNOSTIC_FAILURE_HINT_REGEX.test(diagnosticBody)
    )
  ) {
    return null
  }

  const focusedError = signals.errors.length > 0
    ? signals.errors.slice(0, 2).join(' ')
    : truncateText(diagnosticBody.split(/\r?\n/).slice(-4).join(' '), 220)

  const commandHead = command ? truncateText(command.split(/\r?\n/)[0], 120) : ''
  const query = truncateText([focusedError, commandHead].filter(Boolean).join(' ').trim(), 320)
  if (!query) return null

  const errorTokens = tokenizeDistinctive(focusedError)
  const distinctiveTokens = tokenizeDistinctive(`${focusedError} ${commandHead}`)
  if (distinctiveTokens.size === 0 && errorCodes.size === 0) return null

  return {
    command: commandHead,
    errorText: focusedError,
    query,
    distinctiveTokens,
    errorTokens,
    errorCodes
  }
}

export interface FailureLookupResult {
  matches: HybridSearchResult[]
  records: MemoryRecord[]
  context: string | null
  durationMs: number
  signature: FailureSignature | null
}

/**
 * Fast, deterministic (<50ms, ZERO LLM, ZERO remote embedding) lookup for known
 * fixes, warnings, and working commands matching a tool failure.
 */
export async function lookupFailureMemories(
  payload: PostToolUseFailureInput | Record<string, unknown>,
  config: Config = DEFAULT_CONFIG,
  options: {
    minBm25Score?: number
    maxMatches?: number
    maxTimestamp?: number
    skipSuppression?: boolean
  } = {}
): Promise<FailureLookupResult> {
  const startedAt = Date.now()
  const signature = extractFailureSignature(payload)
  if (!signature) {
    return { matches: [], records: [], context: null, durationMs: Date.now() - startedAt, signature: null }
  }

  const cwd = typeof payload.cwd === 'string' ? payload.cwd : ''
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : undefined
  const gitRoot = cwd ? findGitRoot(cwd) : undefined
  const attribution = resolveAttributionScope(cwd, gitRoot)
  const project = attribution.isCatchAll ? undefined : attribution.project
  const ancestorProjects = project
    ? findAncestorProjects(project).filter(p => !isCatchAllDirectory(p))
    : []
  const linkedWorkspaces = (config.linkedWorkspaces ?? [])
    .map(w => canonicalizePath(w))
    .filter(w => w && w !== project && !isCatchAllDirectory(w))
  const projectSet = new Set([
    ...(project ? [project] : []),
    ...ancestorProjects,
    ...linkedWorkspaces
  ])

  const projectMinBm25 = options.minBm25Score ?? PROJECT_MIN_BM25_SCORE
  const sharedMinBm25 = Math.max(projectMinBm25, SHARED_SCOPE_MIN_BM25_SCORE)
  const maxMatches = options.maxMatches ?? MAX_FAILURE_MATCHES

  const suppressedIds = new Set<string>()
  if (!options.skipSuppression && sessionId) {
    const session = loadSessionTracking(sessionId, config.lancedb.table)
    for (const id of session?.recentlyInjectedIds ?? []) {
      suppressedIds.add(id)
    }
  }

  const { bm25Search } = await import('../lib/lancedb.js')
  const rawHits = await bm25Search({
    query: signature.query,
    limit: 12,
    project,
    ancestorProjects,
    linkedWorkspaces,
    includeGlobal: true,
    onlySharedScopes: attribution.isCatchAll,
    types: ['error', 'warning', 'command'],
    excludeDeprecated: true,
    maxTimestamp: options.maxTimestamp,
    includeEmbeddings: false
  }, config)

  const verified: HybridSearchResult[] = []
  for (const hit of rawHits) {
    if (suppressedIds.has(hit.record.id)) continue
    // Only surface actionable fixes/warnings: skip plain commands that have no documented resolution.
    if (hit.record.type === 'command' && !hit.record.resolution) continue

    const isProjectScopedHit = Boolean(
      hit.record.scope === 'project'
      && hit.record.project
      && projectSet.has(canonicalizePath(hit.record.project))
    )
    const bm25 = hit.bm25Score ?? 0

    // Match against the record's problem/trigger side (errorText/cause/avoid/command/entities),
    // not generic prose buried in reason/useInstead.
    const problemText = buildRecordProblemText(hit.record).toLowerCase()
    const problemTokens = tokenizeDistinctive(problemText)

    let tokenOverlap = 0
    for (const token of signature.distinctiveTokens) {
      if (problemTokens.has(token)) tokenOverlap += 1
    }

    let errorTokenOverlap = 0
    for (const token of signature.errorTokens) {
      if (problemTokens.has(token)) errorTokenOverlap += 1
    }

    let codeMatch = false
    let specificCodeMatch = false
    for (const code of signature.errorCodes) {
      if (problemText.includes(code)) {
        codeMatch = true
        if (SPECIFIC_CODE_REGEX.test(code)) {
          specificCodeMatch = true
        }
      }
    }

    const requiredBm25 = isProjectScopedHit ? projectMinBm25 : sharedMinBm25
    if (!specificCodeMatch && bm25 < requiredBm25) continue

    const denom = Math.min(signature.distinctiveTokens.size, 6)
    const tokenCoverage = denom > 0 ? tokenOverlap / denom : 0
    const hasErrorAnchor = signature.errorTokens.size > 0 ? errorTokenOverlap >= 1 : tokenOverlap >= 3

    let passes = false
    if (specificCodeMatch) {
      passes = isProjectScopedHit || tokenOverlap >= 1 || bm25 >= projectMinBm25
    } else if (codeMatch) {
      // Generic OS/HTTP/TS codes (ENOENT, HTTP 500, ECONNREFUSED) still need domain/tool overlap.
      passes = isProjectScopedHit ? tokenOverlap >= 1 : tokenOverlap >= 2
    } else if (isProjectScopedHit) {
      passes = hasErrorAnchor && tokenOverlap >= 2 && tokenCoverage >= 0.3
    } else {
      // Cross-scope (global / environment) records face a stricter lexical precision bar
      // so unrelated domain warnings never fire mid-session.
      passes = hasErrorAnchor && tokenOverlap >= 3 && tokenCoverage >= 0.4
    }

    if (!passes) continue

    const typePriority = hit.record.type === 'error' ? 1.25 : hit.record.type === 'warning' ? 1.1 : 1.0
    const scopePriority = isProjectScopedHit ? 1.2 : 1.0
    verified.push({
      ...hit,
      score: bm25 * typePriority * scopePriority
    })
  }

  verified.sort((a, b) => b.score - a.score)
  const selected = verified.slice(0, maxMatches)
  const records = selected.map(item => item.record)

  if (records.length === 0) {
    return { matches: [], records: [], context: null, durationMs: Date.now() - startedAt, signature }
  }

  const lines = [
    '<known-failure-matches>',
    'Known fixes/warnings from memory matching this command failure (verify against current state):',
    ...records.map(record => `- ${formatRecordSnippet(record) ?? record.id}`),
    '</known-failure-matches>'
  ]

  return {
    matches: selected,
    records,
    context: lines.join('\n'),
    durationMs: Date.now() - startedAt,
    signature
  }
}

function readStdinSync(): string {
  try {
    return fs.readFileSync(0, 'utf-8')
  } catch {
    return ''
  }
}

export async function handlePostToolFailurePayload(raw: string): Promise<string | null> {
  if (!raw.trim()) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isPlainObject(parsed)) return null

  const eventName = parsed.hook_event_name
  if (eventName !== 'PostToolUseFailure') {
    // Also tolerate failed Bash PostToolUse payloads if explicitly routed here
    if (eventName !== 'PostToolUse') return null
    const resp = isPlainObject(parsed.tool_response) ? parsed.tool_response : null
    const isErr = resp?.is_error === true || (typeof resp?.exitCode === 'number' && resp.exitCode !== 0)
    if (!isErr) return null
  }

  // Fast exit before touching config, daemon, or LanceDB when there is no real diagnostic failure.
  if (!extractFailureSignature(parsed)) return null

  const cwd = typeof parsed.cwd === 'string' ? parsed.cwd : ''
  const projectRoot = cwd ? findGitRoot(cwd) : undefined
  const configRoot = projectRoot ?? (cwd ? canonicalizePath(cwd) : cwd)
  const config = loadConfig(configRoot)
  const settings = loadSettings()

  let result: FailureLookupResult | null = null
  let suppressionTrackedByDaemon = false
  if (settings.enableWarmDaemon !== false) {
    const daemonResp = await queryDaemon<FailureLookupResult>(
      '/post-tool-failure',
      { payload: parsed, config, trackSuppression: true },
      { timeoutMs: 1200 }
    )
    if (daemonResp && typeof daemonResp.durationMs === 'number') {
      result = daemonResp
      suppressionTrackedByDaemon = true
    }
  }

  if (!result) {
    const { closeLanceDB, initLanceDB } = await import('../lib/lancedb.js')
    await initLanceDB(config)
    try {
      result = await lookupFailureMemories(parsed, config)
    } finally {
      await closeLanceDB()
    }
  }

  if (!result.context || result.records.length === 0) return null

  const sessionId = typeof parsed.session_id === 'string' ? parsed.session_id : undefined
  if (!suppressionTrackedByDaemon && sessionId && settings.enableTopicSuppression) {
    try {
      markInjectedForSuppression(
        sessionId,
        result.records.map(r => r.id),
        settings.recentlyInjectedWindow,
        config.lancedb.table
      )
    } catch {
      // non-fatal
    }
  }

  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUseFailure',
      additionalContext: result.context
    }
  })
}

async function main(): Promise<void> {
  try {
    const output = await handlePostToolFailurePayload(readStdinSync())
    if (output) {
      process.stdout.write(output)
    }
  } catch (error) {
    console.error('[claude-memory] post-tool-failure hook failed:', error)
  }
}

if (isProcessEntrypoint(import.meta.url)) {
  void main().finally(() => {
    process.exitCode = 0
  })
}
