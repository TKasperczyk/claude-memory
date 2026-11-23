import fs from 'fs'
import path from 'path'
import { homedir } from 'os'
import { fileURLToPath } from 'url'

export function canonicalizePath(targetPath: string): string {
  const resolvedPath = path.resolve(targetPath)
  try {
    return fs.realpathSync(resolvedPath)
  } catch {
    const suffixParts: string[] = []
    let current = resolvedPath
    while (true) {
      const parent = path.dirname(current)
      if (parent === current) return resolvedPath
      suffixParts.unshift(path.basename(current))
      current = parent
      try {
        return path.join(fs.realpathSync(current), ...suffixParts)
      } catch {
        // Continue walking up to the deepest existing ancestor.
      }
    }
  }
}

export const PROJECT_ROOT = canonicalizePath(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
)

export const CLAUDE_MEMORY_ROOT = path.join(homedir(), '.claude-memory')
export const DEBUG_LOG_FILE = path.join(CLAUDE_MEMORY_ROOT, 'debug.log')
export const LOCKS_DIR = path.join(CLAUDE_MEMORY_ROOT, 'locks')
export const SELF_UPDATE_STATE_PATH = path.join(CLAUDE_MEMORY_ROOT, 'self-update-state.json')
export const SELF_UPDATE_LOCK_PATH = path.join(LOCKS_DIR, 'self-update.lock')
export const CLAUDE_SETTINGS_PATH = path.join(homedir(), '.claude', 'settings.json')
export const CLAUDE_CONFIG_PATH = path.join(homedir(), '.claude.json')
