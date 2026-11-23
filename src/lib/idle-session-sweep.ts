import fs from 'fs'
import os from 'os'
import path from 'path'
import { listAllSessions, removeSessionTracking } from './session-tracking.js'
import { sanitizeSessionId } from './shared.js'
import { LOCKS_DIR } from './paths.js'
import type { Config, ExtractionHookInput, InjectionSessionRecord } from './types.js'

export interface IdleSessionSweepOptions {
  /** Minimum inactivity duration (hours) before a tracked session is considered abandoned. */
  idleHours: number
  /** Override base directory containing Claude Code project transcripts (defaults to ~/.claude/projects). */
  claudeProjectsDir?: string
  /** Current timestamp override for deterministic tests. */
  now?: number
  /** Maximum abandoned sessions to sweep in a single maintenance pass. */
  maxSessions?: number
  /** Callback executing extraction + usefulness rating for a recovered abandoned session. */
  onRecoverSession: (payload: ExtractionHookInput, session: InjectionSessionRecord) => Promise<void>
}

export interface IdleSessionSweepResult {
  scanned: number
  recovered: number
  cleanedWithoutTranscript: number
  skippedActive: number
  errors: number
}

const DEFAULT_MAX_SWEEP_SESSIONS = 10

/**
 * Find the Claude Code JSONL transcript file matching a sessionId under ~/.claude/projects.
 */
export function findTranscriptForSession(
  sessionId: string,
  claudeProjectsDir: string = path.join(os.homedir(), '.claude', 'projects')
): string | null {
  if (!sessionId || !fs.existsSync(claudeProjectsDir)) return null
  const targetName = `${sessionId}.jsonl`

  try {
    const entries = fs.readdirSync(claudeProjectsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const candidate = path.join(claudeProjectsDir, entry.name, targetName)
      if (fs.existsSync(candidate)) {
        return candidate
      }
    }
  } catch {
    return null
  }
  return null
}

function isWorkerLockActive(sessionId: string): boolean {
  const lockPath = path.join(LOCKS_DIR, `${sanitizeSessionId(sessionId)}.lock`)
  try {
    if (!fs.existsSync(lockPath)) return false
    const raw = fs.readFileSync(lockPath, 'utf-8').trim()
    const pid = Number(raw.split(/\r?\n/)[0]?.trim())
    if (!Number.isInteger(pid) || pid <= 0) return false
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  } catch {
    return false
  }
}

/**
 * Recover abandoned/crashed sessions that never fired SessionEnd:
 * - Sessions inactive for >= idleHours (both tracking file lastActivity AND transcript mtime)
 * - No live worker lock holding the session
 * Runs extraction + usefulness rating as a synthetic SessionEnd and cleans up tracking state.
 */
export async function sweepIdleSessions(
  config: Config,
  options: IdleSessionSweepOptions
): Promise<IdleSessionSweepResult> {
  const result: IdleSessionSweepResult = {
    scanned: 0,
    recovered: 0,
    cleanedWithoutTranscript: 0,
    skippedActive: 0,
    errors: 0
  }

  if (!options.idleHours || options.idleHours <= 0) return result

  const now = options.now ?? Date.now()
  const idleCutoff = now - options.idleHours * 60 * 60 * 1000
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SWEEP_SESSIONS
  const sessions = listAllSessions(config.lancedb.table)

  let processed = 0
  for (const session of sessions) {
    if (processed >= maxSessions) break
    result.scanned += 1

    if (session.lastActivity >= idleCutoff) {
      result.skippedActive += 1
      continue
    }

    if (isWorkerLockActive(session.sessionId)) {
      result.skippedActive += 1
      continue
    }

    const transcriptPath = findTranscriptForSession(session.sessionId, options.claudeProjectsDir)
    if (!transcriptPath) {
      // No transcript on disk and idle past threshold: clean up orphaned session file if unrecoverable.
      if (session.memories.length === 0 || session.lastActivity < now - 24 * 60 * 60 * 1000) {
        removeSessionTracking(session.sessionId, config.lancedb.table)
        result.cleanedWithoutTranscript += 1
      }
      continue
    }

    // Never touch a session whose transcript file was modified recently (could still be live).
    try {
      const stat = fs.statSync(transcriptPath)
      if (stat.mtimeMs >= idleCutoff) {
        result.skippedActive += 1
        continue
      }
    } catch {
      continue
    }

    const syntheticPayload: ExtractionHookInput = {
      hook_event_name: 'SessionEnd',
      reason: 'other',
      session_id: session.sessionId,
      transcript_path: transcriptPath,
      cwd: session.cwd ?? process.cwd(),
      permission_mode: 'default'
    }

    try {
      await options.onRecoverSession(syntheticPayload, session)
      result.recovered += 1
      processed += 1
    } catch (error) {
      result.errors += 1
      console.error(`[claude-memory] Idle session sweep failed for ${session.sessionId}:`, error)
    }
  }

  return result
}
