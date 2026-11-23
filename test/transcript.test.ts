import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { REMEMBER_MARKER } from '../src/lib/claude-commands.js'
import { fileContainsMarker, parseTranscript, parseTranscriptTurns } from '../src/lib/transcript.js'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-memory-transcript-test-'))

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
})

function jsonlTurn(user: string, assistant: string): string {
  return [
    JSON.stringify({ type: 'user', message: { role: 'user', content: user } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: assistant } })
  ].join('\n') + '\n'
}

describe('transcript tail parsing and chunked marker scanning', () => {
  it('parses recent turns from a >4 MiB transcript with multi-byte UTF-8 split across the 4 MiB tail boundary', async () => {
    const filePath = path.join(tempDir, 'large-utf8.jsonl')
    const tailBytes = 4 * 1024 * 1024

    // Build an ending segment slightly smaller than 4 MiB, then prepend a multi-byte UTF-8 line
    // whose bytes straddle exact offset (fileSize - 4MiB - 1).
    const recentTurns = [
      jsonlTurn('First recent user prompt', 'First recent assistant reply'),
      jsonlTurn('Second recent user prompt café 🚀', 'Second recent assistant reply 日本語')
    ].join('')
    const fillerLine = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'x'.repeat(30_000) }
    }) + '\n'

    const afterBoundaryChunks: string[] = []
    let afterBytes = Buffer.byteLength(recentTurns, 'utf-8')
    const fillerByteLen = Buffer.byteLength(fillerLine, 'utf-8')
    while (afterBytes + fillerByteLen < tailBytes - 200) {
      afterBoundaryChunks.push(fillerLine)
      afterBytes += fillerByteLen
    }
    afterBoundaryChunks.push(recentTurns)
    const tailContent = afterBoundaryChunks.join('')

    // Prepend a line packed with 4-byte emoji large enough to guarantee fileSize > 4 MiB
    // and ensure the tail boundary (fileSize - 4 MiB - 1) lands inside this multi-byte UTF-8 line.
    const emojiLine = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: '🚀'.repeat(10_000) }
    }) + '\n'
    const earlyTurn = jsonlTurn('Very early prompt', 'Very early reply')
    fs.writeFileSync(filePath, earlyTurn + emojiLine + tailContent, 'utf-8')

    const totalSize = fs.statSync(filePath).size
    expect(totalSize).toBeGreaterThan(tailBytes)
    // Verify the tail boundary genuinely falls inside emojiLine
    const earlyBytes = Buffer.byteLength(earlyTurn, 'utf-8')
    const emojiEndBytes = earlyBytes + Buffer.byteLength(emojiLine, 'utf-8')
    const boundary = totalSize - tailBytes - 1
    expect(boundary).toBeGreaterThan(earlyBytes)
    expect(boundary).toBeLessThan(emojiEndBytes)

    const turns = await parseTranscriptTurns(filePath, 2)
    expect(turns).toHaveLength(2)
    expect(turns[0]).toEqual({
      user: 'First recent user prompt',
      assistant: 'First recent assistant reply'
    })
    expect(turns[1]).toEqual({
      user: 'Second recent user prompt café 🚀',
      assistant: 'Second recent assistant reply 日本語'
    })
  })

  it('recovers turns via widened 16 MiB tail window when a single >4 MiB line sits at EOF', async () => {
    const filePath = path.join(tempDir, 'huge-last-line.jsonl')
    const priorTurn = jsonlTurn('Question before huge output', 'Answer before huge output')
    const hugeLine = JSON.stringify({
      type: 'tool_result',
      content: 'A'.repeat(4.5 * 1024 * 1024)
    }) + '\n'

    fs.writeFileSync(filePath, priorTurn + hugeLine, 'utf-8')

    const turns = await parseTranscriptTurns(filePath, 2)
    expect(turns).toHaveLength(1)
    expect(turns[0].user).toBe('Question before huge output')
    expect(turns[0].assistant).toContain('Answer before huge output')
  })

  it('detects markers spanning the 256 KiB chunk boundary in fileContainsMarker', async () => {
    const filePath = path.join(tempDir, 'chunk-boundary-marker.jsonl')
    const chunkBytes = 256 * 1024
    const marker = '<!-- CLAUDE_MEMORY_BOUNDARY_TEST_MARKER -->'
    const prefix = 'a'.repeat(chunkBytes - Math.floor(marker.length / 2))
    const suffix = 'b'.repeat(1024)

    fs.writeFileSync(filePath, prefix + marker + suffix, 'utf-8')

    expect(await fileContainsMarker(filePath, marker)).toBe(true)
    expect(await fileContainsMarker(filePath, 'NON_EXISTENT_MARKER')).toBe(false)
  })

  it('lets string-content isMeta entries with REMEMBER_MARKER through parseTranscript', async () => {
    const filePath = path.join(tempDir, 'remember-string-ismeta.jsonl')
    const lines = [
      JSON.stringify({
        type: 'user',
        isMeta: true,
        message: { role: 'user', content: `${REMEMBER_MARKER}\nRemember this durable fact.` }
      }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: 'Noted.' }
      })
    ].join('\n') + '\n'
    fs.writeFileSync(filePath, lines, 'utf-8')

    const transcript = await parseTranscript(filePath)
    expect(transcript.hasRememberMarker).toBe(true)
    expect(transcript.messages.some(m => m.text.includes('Remember this durable fact.'))).toBe(true)
  })
})
