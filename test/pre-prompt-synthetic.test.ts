import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isMachineGeneratedTaskNotification, main } from '../src/hooks/pre-prompt.js'
import { getDefaultSettings } from '../src/lib/settings.js'
import { DEFAULT_CONFIG, type UserPromptSubmitInput } from '../src/lib/types.js'

const prompt = '<task-notification>\n<task-id>task-1</task-id>\n<status>completed</status>\n</task-notification>'
let tempDir = ''
let transcriptPath = ''

function transcriptEntry(overrides: Record<string, unknown> = {}, content = prompt): string {
  return JSON.stringify({
    type: 'user',
    origin: { kind: 'task-notification' },
    promptSource: 'system',
    message: { role: 'user', content },
    ...overrides
  })
}

function hookPayload(pathOverride = transcriptPath): UserPromptSubmitInput {
  return {
    hook_event_name: 'UserPromptSubmit',
    session_id: 'synthetic-session',
    transcript_path: pathOverride,
    cwd: tempDir,
    prompt
  }
}

function entrypointHarness(payload: UserPromptSubmitInput) {
  const retrieve = vi.fn(async () => ({
    context: null,
    signals: { errors: [], commands: [] },
    results: [],
    injectedRecords: [],
    timedOut: false
  }))
  return {
    retrieve,
    runtime: {
      closeLanceDB: vi.fn(async () => {}),
      findGitRoot: vi.fn(() => null),
      handlePrePrompt: retrieve,
      loadConfig: vi.fn(() => DEFAULT_CONFIG),
      loadSettings: vi.fn(() => getDefaultSettings()),
      markInjectedForSuppression: vi.fn(),
      readHookInput: vi.fn(async () => payload),
      trackSession: vi.fn(),
      writeStdout: vi.fn(async () => {})
    }
  }
}

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-memory-pre-prompt-'))
  transcriptPath = path.join(tempDir, 'session.jsonl')
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(tempDir, { recursive: true, force: true })
})

describe('machine-generated task notification gate', () => {
  it('skips only an exact marker-prefixed prompt matching the final provenance entry', async () => {
    await fs.writeFile(transcriptPath, `${transcriptEntry()}\n`)

    expect(isMachineGeneratedTaskNotification(prompt, transcriptPath)).toBe(true)
    expect(isMachineGeneratedTaskNotification(` ${prompt}`, transcriptPath)).toBe(false)
    expect(isMachineGeneratedTaskNotification(`${prompt}\nextra`, transcriptPath)).toBe(false)
  })

  it('does not suppress a genuine user paste of notification-shaped content', async () => {
    await fs.writeFile(transcriptPath, `${transcriptEntry({
      origin: { kind: 'human' },
      promptSource: 'typed'
    })}\n`)

    expect(isMachineGeneratedTaskNotification(prompt, transcriptPath)).toBe(false)
  })

  it.each([
    ['missing transcript', async () => path.join(tempDir, 'missing.jsonl')],
    ['malformed final entry', async () => {
      await fs.writeFile(transcriptPath, `${transcriptEntry()}\n{not-json}\n`)
      return transcriptPath
    }],
    ['older entry without provenance', async () => {
      await fs.writeFile(transcriptPath, `${transcriptEntry({ origin: undefined, promptSource: undefined })}\n`)
      return transcriptPath
    }],
    ['lagging transcript', async () => {
      await fs.writeFile(transcriptPath, `${transcriptEntry()}\n${JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: 'prior response' }
      })}\n`)
      return transcriptPath
    }]
  ])('fails open for a %s', async (_label, arrange) => {
    expect(isMachineGeneratedTaskNotification(prompt, await arrange())).toBe(false)
  })

  it('does no provenance lookup for ordinary prompts', () => {
    expect(isMachineGeneratedTaskNotification('Please discuss task notifications', undefined)).toBe(false)
  })

  it('preserves a complete final entry beginning exactly at the tail boundary', async () => {
    const markerOnlyEntry = transcriptEntry({}, '<task-notification>')
    const fillerLength = 64 * 1024 - 1 - Buffer.byteLength(markerOnlyEntry)
    const boundaryPrompt = `<task-notification>${'x'.repeat(fillerLength)}`
    const finalEntry = `${transcriptEntry({}, boundaryPrompt)}\n`
    expect(Buffer.byteLength(finalEntry)).toBe(64 * 1024)

    await fs.writeFile(transcriptPath, `prior entry\n${finalEntry}`)

    expect(isMachineGeneratedTaskNotification(boundaryPrompt, transcriptPath)).toBe(true)
  })

  it('matches a proven task notification followed by trailing non-conversation bookkeeping lines', async () => {
    const trailing = [
      transcriptEntry(),
      JSON.stringify({ type: 'attachment', isSidechain: false, attachment: { type: 'model' } }),
      JSON.stringify({ type: 'queue-operation', operation: 'dequeue', timestamp: '2026-11-23T17:29:59.071Z' }),
      JSON.stringify({ type: 'progress', data: { status: 'running' } }),
      JSON.stringify({ type: 'last-prompt', lastPrompt: prompt }),
      JSON.stringify({ type: 'ai-title', title: 'Background task' }),
      JSON.stringify({ type: 'mode', mode: 'default' }),
      JSON.stringify({ type: 'permission-mode', permissionMode: 'default' }),
      JSON.stringify({ type: 'atis-latch' }),
      JSON.stringify({ type: 'file-history-snapshot' })
    ].join('\n')
    await fs.writeFile(transcriptPath, `${trailing}\n`)

    expect(isMachineGeneratedTaskNotification(prompt, transcriptPath)).toBe(true)
  })

  it('matches a mid-turn queued_command task-notification attachment with or without trailing queue bookkeeping', async () => {
    const queuedAttachment = JSON.stringify({
      type: 'attachment',
      isSidechain: false,
      attachment: {
        type: 'queued_command',
        prompt,
        commandMode: 'task-notification',
        origin: { kind: 'task-notification', producer: 'session-task' }
      }
    })
    await fs.writeFile(transcriptPath, `${queuedAttachment}\n`)
    expect(isMachineGeneratedTaskNotification(prompt, transcriptPath)).toBe(true)

    await fs.writeFile(
      transcriptPath,
      `${queuedAttachment}\n${JSON.stringify({ type: 'queue-operation', operation: 'remove', content: prompt })}\n${JSON.stringify({ type: 'last-prompt' })}\n`
    )
    expect(isMachineGeneratedTaskNotification(prompt, transcriptPath)).toBe(true)
  })

  it.each([
    ['assistant turn followed by bookkeeping', async () => {
      await fs.writeFile(transcriptPath, [
        transcriptEntry(),
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'prior response' } }),
        JSON.stringify({ type: 'last-prompt' }),
        JSON.stringify({ type: 'progress' })
      ].join('\n') + '\n')
      return transcriptPath
    }],
    ['malformed JSON between proven entry and bookkeeping', async () => {
      await fs.writeFile(transcriptPath, [
        transcriptEntry(),
        '{corrupt-line',
        JSON.stringify({ type: 'last-prompt' })
      ].join('\n') + '\n')
      return transcriptPath
    }],
    ['human queued_command attachment pasting notification text', async () => {
      await fs.writeFile(transcriptPath, JSON.stringify({
        type: 'attachment',
        isSidechain: false,
        attachment: {
          type: 'queued_command',
          prompt,
          commandMode: 'prompt',
          origin: { kind: 'human' },
          humanTurn: true
        }
      }) + '\n')
      return transcriptPath
    }],
    ['human queued_command following an earlier system task notification', async () => {
      await fs.writeFile(transcriptPath, [
        JSON.stringify({
          type: 'attachment',
          isSidechain: false,
          attachment: {
            type: 'queued_command',
            prompt,
            commandMode: 'task-notification',
            origin: { kind: 'task-notification', producer: 'session-task' }
          }
        }),
        JSON.stringify({
          type: 'attachment',
          isSidechain: false,
          attachment: {
            type: 'queued_command',
            prompt: 'user typed something else',
            commandMode: 'prompt',
            origin: { kind: 'human' },
            humanTurn: true
          }
        })
      ].join('\n') + '\n')
      return transcriptPath
    }],
    ['unattributed queue-operation enqueue without provenance entry', async () => {
      await fs.writeFile(transcriptPath, [
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'working' } }),
        JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: prompt })
      ].join('\n') + '\n')
      return transcriptPath
    }]
  ])('still fails open for %s', async (_label, arrange) => {
    expect(isMachineGeneratedTaskNotification(prompt, await arrange())).toBe(false)
  })

  it('skips retrieval through the hook entrypoint for a proven task notification', async () => {
    await fs.writeFile(transcriptPath, `${transcriptEntry()}\n`)
    const harness = entrypointHarness(hookPayload())

    await main(harness.runtime)

    expect(harness.retrieve).not.toHaveBeenCalled()
  })

  it.each([
    ['empty transcript', async () => {
      await fs.writeFile(transcriptPath, '')
    }],
    ['unreadable transcript', async () => {
      await fs.writeFile(transcriptPath, `${transcriptEntry()}\n`)
      vi.spyOn(fsSync, 'openSync').mockImplementationOnce(() => {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      })
    }],
    ['truncated final line', async () => {
      await fs.writeFile(transcriptPath, `${transcriptEntry()}\n{"type":"user"`)
    }]
  ])('runs retrieval through the hook entrypoint for an ambiguous %s', async (_label, arrange) => {
    await arrange()
    const harness = entrypointHarness(hookPayload())

    await main(harness.runtime)

    expect(harness.retrieve).toHaveBeenCalledTimes(1)
  })
})
