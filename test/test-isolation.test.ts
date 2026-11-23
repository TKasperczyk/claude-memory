import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CLAUDE_MEMORY_ROOT, DEBUG_LOG_FILE, LOCKS_DIR } from '../src/lib/paths.js'
import { setup as runGlobalSetup } from './global-setup.js'
import { getTempTranscriptDir } from './helpers.js'

describe('test filesystem isolation', () => {
  it('isolates CLAUDE_MEMORY_ROOT and temp transcripts away from ~/.claude-memory during vitest runs', () => {
    const userRoot = path.resolve(os.homedir(), '.claude-memory')
    expect(process.env.CC_MEMORIES_DATA_DIR).toBeTruthy()
    expect(path.resolve(CLAUDE_MEMORY_ROOT)).not.toBe(userRoot)
    expect(DEBUG_LOG_FILE).toBe(path.join(CLAUDE_MEMORY_ROOT, 'debug.log'))
    expect(LOCKS_DIR).toBe(path.join(CLAUDE_MEMORY_ROOT, 'locks'))
    expect(getTempTranscriptDir()).toBe(path.join(CLAUDE_MEMORY_ROOT, 'transcripts-test'))
  })

  it('overrides CC_MEMORIES_DATA_DIR in globalSetup when inherited env points to ~/.claude-memory', () => {
    const original = process.env.CC_MEMORIES_DATA_DIR
    let teardown: (() => void) | undefined
    try {
      process.env.CC_MEMORIES_DATA_DIR = '~/.claude-memory'
      teardown = runGlobalSetup()
      const isolated = process.env.CC_MEMORIES_DATA_DIR
      expect(isolated).toBeTruthy()
      expect(path.resolve(isolated!)).not.toBe(path.resolve(os.homedir(), '.claude-memory'))
      expect(fs.existsSync(isolated!)).toBe(true)
      teardown?.()
      expect(fs.existsSync(isolated!)).toBe(false)
      teardown = undefined
    } finally {
      teardown?.()
      if (original === undefined) delete process.env.CC_MEMORIES_DATA_DIR
      else process.env.CC_MEMORIES_DATA_DIR = original
    }
  })

  it('resolves CC_MEMORIES_DATA_DIR overrides including tilde and default fallback', async () => {
    const original = process.env.CC_MEMORIES_DATA_DIR
    try {
      process.env.CC_MEMORIES_DATA_DIR = '~/custom-claude-memory-test'
      vi.resetModules()
      const tildePaths = await import('../src/lib/paths.js')
      expect(tildePaths.CLAUDE_MEMORY_ROOT).toBe(path.join(os.homedir(), 'custom-claude-memory-test'))

      delete process.env.CC_MEMORIES_DATA_DIR
      vi.resetModules()
      const defaultPaths = await import('../src/lib/paths.js')
      expect(defaultPaths.CLAUDE_MEMORY_ROOT).toBe(path.join(os.homedir(), '.claude-memory'))
    } finally {
      if (original === undefined) delete process.env.CC_MEMORIES_DATA_DIR
      else process.env.CC_MEMORIES_DATA_DIR = original
      vi.resetModules()
    }
  })
})
