import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function setup() {
  if (process.env.CC_MEMORIES_DATA_DIR?.trim()) {
    return
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-memory-test-root-'))
  process.env.CC_MEMORIES_DATA_DIR = tempRoot

  return () => {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}
