#!/usr/bin/env node

import fs from 'fs'
import { appendMemoryWriteHint, createMemoryWriteHint } from '../lib/memory-write-hints.js'
import { isPlainObject } from '../lib/parsing.js'
import { loadSettings } from '../lib/settings.js'
import { isProcessEntrypoint } from '../lib/shared.js'

export const MEMORY_WRITE_STDIN_MAX_BYTES = 10 * 1024 * 1024

export function readStdinSync(): string {
  const chunks: Buffer[] = []
  const buffer = Buffer.alloc(4096)
  let totalBytes = 0
  let bytesRead = 0
  try {
    while (totalBytes < MEMORY_WRITE_STDIN_MAX_BYTES) {
      const remaining = MEMORY_WRITE_STDIN_MAX_BYTES - totalBytes
      bytesRead = fs.readSync(0, buffer, 0, Math.min(buffer.length, remaining), null)
      if (bytesRead <= 0) break
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)))
      totalBytes += bytesRead
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EOF' && code !== 'EAGAIN') throw error
  }
  return Buffer.concat(chunks, totalBytes).toString('utf8')
}

const NATIVE_CLAUDE_MEMORY_FILE_REGEX = /(?:^|\/)\.claude\/projects\/[^/]+\/memory\/[^/]+\.md$|(?:^|\/)MEMORY\.md$/

export function isNativeAutoMemoryFileWrite(parsed: Record<string, unknown>): boolean {
  const toolName = parsed.tool_name
  if (toolName !== 'Write' && toolName !== 'Edit') return false
  const input = isPlainObject(parsed.tool_input) ? parsed.tool_input : null
  const filePath = typeof input?.file_path === 'string'
    ? input.file_path
    : typeof input?.path === 'string'
      ? input.path
      : ''
  return NATIVE_CLAUDE_MEMORY_FILE_REGEX.test(filePath)
}

export function captureMemoryWriteHint(raw: string): boolean {
  if (!raw.trim()) return false

  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return false
  }
  if (!isPlainObject(parsed)) return false
  if (parsed.hook_event_name !== 'PostToolUse') return false
  const isMemoryWriteTool = parsed.tool_name === 'memory_write'
  const isNativeFileWrite = isNativeAutoMemoryFileWrite(parsed)
  if (!isMemoryWriteTool && !isNativeFileWrite) return false
  if (!loadSettings().enableMemoryWriteHints) return false

  const event = createMemoryWriteHint(parsed)
  return event ? appendMemoryWriteHint(event) : false
}

function main(): void {
  try {
    captureMemoryWriteHint(readStdinSync())
  } catch (error) {
    console.error('[claude-memory] Failed to capture memory_write hint:', error)
  }
}

if (isProcessEntrypoint(import.meta.url)) {
  main()
  process.exitCode = 0
}
