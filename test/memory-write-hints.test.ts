import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type HintsModule = typeof import('../src/lib/memory-write-hints.js')

let storageRoot = ''
let hints: HintsModule

function probePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: 'probe-session',
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/tmp/project',
    prompt_id: 'prompt-1',
    permission_mode: 'default',
    effort: 'medium',
    hook_event_name: 'PostToolUse',
    tool_name: 'memory_write',
    tool_input: {
      store: 'user',
      path: 'projects/claude-memory/hook-hints',
      content: `---
name: Memory write hook hints
description: Capture native writes for extraction
metadata:
  type: project
---
The post-session worker should treat these writes as extraction anchors.`
    },
    tool_response: { ok: true },
    tool_use_id: 'tool-use-1',
    duration_ms: 12,
    ...overrides
  }
}

function hintPath(sessionId: string): string {
  return path.join(storageRoot, 'memory-write-hints', 'sessions', `${sessionId}.jsonl`)
}

beforeEach(async () => {
  storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-memory-hints-'))
  vi.resetModules()
  vi.doMock('../src/lib/paths.js', () => ({
    CLAUDE_MEMORY_ROOT: storageRoot
  }))
  hints = await import('../src/lib/memory-write-hints.js')
})

afterEach(() => {
  vi.doUnmock('../src/lib/paths.js')
  vi.resetModules()
  if (storageRoot) fs.rmSync(storageRoot, { recursive: true, force: true })
  storageRoot = ''
})

describe('memory_write hint normalization and storage', () => {
  it('normalizes a probe-shaped payload and extracts native frontmatter metadata', () => {
    const event = hints.createMemoryWriteHint(probePayload(), 1_700_000_000_000)

    expect(event).toEqual({
      sessionId: 'probe-session',
      timestamp: 1_700_000_000_000,
      name: 'Memory write hook hints',
      description: 'Capture native writes for extraction',
      nativeMemoryType: 'project',
      toolUseId: 'tool-use-1',
      content: expect.stringContaining('post-session worker should treat these writes')
    })
  })

  it('never drops an unexpected tool_input shape and stores bounded raw JSON', () => {
    const event = hints.createMemoryWriteHint(probePayload({
      tool_input: ['unexpected', { nested: true }],
      tool_use_id: 'unexpected-shape'
    }), 123)

    expect(event).toMatchObject({
      sessionId: 'probe-session',
      timestamp: 123,
      name: 'memory_write',
      toolUseId: 'unexpected-shape',
      content: '[\n  "unexpected",\n  {\n    "nested": true\n  }\n]'
    })
  })

  it('appends and reads hints in the fixed sessions namespace', () => {
    const event = hints.createMemoryWriteHint(probePayload(), 100)
    if (!event) throw new Error('expected normalized hint')

    expect(hints.appendMemoryWriteHint(event)).toBe(true)
    expect(fs.existsSync(hintPath('probe-session'))).toBe(true)
    expect(hints.loadMemoryWriteHints('probe-session')).toEqual([event])
  })

  it('captures only matcher-qualified PostToolUse memory_write payloads in the blocking hook', async () => {
    const { captureMemoryWriteHint } = await import('../src/hooks/memory-write-hint.js')

    expect(captureMemoryWriteHint(JSON.stringify(probePayload()))).toBe(true)
    expect(captureMemoryWriteHint(JSON.stringify(probePayload({
      tool_name: 'Bash',
      tool_use_id: 'bash-tool'
    })))).toBe(false)
    expect(captureMemoryWriteHint('{')).toBe(false)
    expect(hints.loadMemoryWriteHints('probe-session')).toHaveLength(1)
  })

  it('tolerates malformed JSONL lines while retaining valid events', () => {
    const event = hints.createMemoryWriteHint(probePayload(), 100)
    if (!event) throw new Error('expected normalized hint')
    hints.appendMemoryWriteHint(event)
    fs.appendFileSync(hintPath('probe-session'), '{malformed\n', 'utf-8')

    expect(hints.loadMemoryWriteHints('probe-session')).toEqual([event])
  })

  it('bounds content at 12,000 characters with head-and-tail preservation', () => {
    const original = `${'h'.repeat(11_000)}${'t'.repeat(3_000)}`
    const event = hints.createMemoryWriteHint(probePayload({
      tool_input: { path: 'large-memory', content: original }
    }), 100)

    expect(event?.contentTruncated).toBe(true)
    expect(event?.content).toHaveLength(12_000)
    expect(event?.content).toContain('...[truncated]...')
    expect(event?.content?.endsWith('t'.repeat(2_000))).toBe(true)
  })

  it('appends duplicate deliveries without reading the file and deduplicates by tool_use_id on load', () => {
    const first = hints.createMemoryWriteHint(probePayload(), 100)
    const duplicate = hints.createMemoryWriteHint(probePayload(), 200)
    if (!first || !duplicate) throw new Error('expected normalized hints')

    expect(hints.appendMemoryWriteHint(first)).toBe(true)
    expect(hints.appendMemoryWriteHint(duplicate)).toBe(true)
    expect(fs.readFileSync(hintPath('probe-session'), 'utf-8').trim().split('\n')).toHaveLength(2)
    expect(hints.loadMemoryWriteHints('probe-session')).toEqual([first])
  })

  it('decodes stdin once after joining chunks split inside multibyte UTF-8', async () => {
    const { readStdinSync } = await import('../src/hooks/memory-write-hint.js')
    const input = `${'a'.repeat(4095)}€tail`
    const bytes = Buffer.from(input, 'utf8')
    let position = 0
    const readSpy = vi.spyOn(fs, 'readSync')
    readSpy.mockImplementation(((...args: unknown[]) => {
      const target = args[1] as Buffer
      const targetOffset = args[2] as number
      const length = args[3] as number
      const bytesRead = Math.min(length, bytes.length - position)
      if (bytesRead <= 0) return 0
      bytes.copy(target, targetOffset, position, position + bytesRead)
      position += bytesRead
      return bytesRead
    }) as any)

    try {
      expect(readStdinSync()).toBe(input)
    } finally {
      readSpy.mockRestore()
    }
  })

  it('stops reading stdin at the total byte cap', async () => {
    const { MEMORY_WRITE_STDIN_MAX_BYTES, readStdinSync } = await import('../src/hooks/memory-write-hint.js')
    const availableBytes = MEMORY_WRITE_STDIN_MAX_BYTES + 4096
    let position = 0
    const readSpy = vi.spyOn(fs, 'readSync')
    readSpy.mockImplementation(((...args: unknown[]) => {
      const target = args[1] as Buffer
      const targetOffset = args[2] as number
      const length = args[3] as number
      const bytesRead = Math.min(length, availableBytes - position)
      if (bytesRead <= 0) return 0
      target.fill(0x61, targetOffset, targetOffset + bytesRead)
      position += bytesRead
      return bytesRead
    }) as any)

    try {
      const input = readStdinSync()
      expect(Buffer.byteLength(input, 'utf8')).toBe(MEMORY_WRITE_STDIN_MAX_BYTES)
      expect(position).toBe(MEMORY_WRITE_STDIN_MAX_BYTES)
    } finally {
      readSpy.mockRestore()
    }
  })

  it('deletes all hints for one session', () => {
    const event = hints.createMemoryWriteHint(probePayload(), 100)
    if (!event) throw new Error('expected normalized hint')
    hints.appendMemoryWriteHint(event)

    expect(hints.deleteMemoryWriteHints('probe-session')).toBe(true)
    expect(hints.loadMemoryWriteHints('probe-session')).toEqual([])
    expect(fs.existsSync(hintPath('probe-session'))).toBe(false)
  })

  it('removes only session files older than the mtime cutoff', () => {
    const oldEvent = hints.createMemoryWriteHint(probePayload({
      session_id: 'old-session',
      tool_use_id: 'old-tool'
    }), 100)
    const freshEvent = hints.createMemoryWriteHint(probePayload({
      session_id: 'fresh-session',
      tool_use_id: 'fresh-tool'
    }), 200)
    if (!oldEvent || !freshEvent) throw new Error('expected normalized hints')
    hints.appendMemoryWriteHint(oldEvent)
    hints.appendMemoryWriteHint(freshEvent)

    fs.utimesSync(hintPath('old-session'), new Date(1_000), new Date(1_000))
    fs.utimesSync(hintPath('fresh-session'), new Date(3_000), new Date(3_000))
    hints.cleanupMemoryWriteHints(2_000)

    expect(fs.existsSync(hintPath('old-session'))).toBe(false)
    expect(fs.existsSync(hintPath('fresh-session'))).toBe(true)
  })
})
