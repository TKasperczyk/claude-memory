import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function resolveDataDir(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '~') return os.homedir()
  if (trimmed.startsWith('~/')) return path.join(os.homedir(), trimmed.slice(2))
  return path.resolve(trimmed)
}

export function setup() {
  const existing = process.env.CC_MEMORIES_DATA_DIR?.trim()
  const userRoot = path.resolve(os.homedir(), '.claude-memory')
  if (existing && resolveDataDir(existing) !== userRoot) {
    return
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-memory-test-root-'))
  process.env.CC_MEMORIES_DATA_DIR = tempRoot

  return () => {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}
