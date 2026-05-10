import path from 'path'
import { homedir } from 'os'

export const CLAUDE_MEMORY_ROOT = path.join(homedir(), '.claude-memory')
export const DEBUG_LOG_FILE = path.join(CLAUDE_MEMORY_ROOT, 'debug.log')
export const LOCKS_DIR = path.join(CLAUDE_MEMORY_ROOT, 'locks')
