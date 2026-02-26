import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SKIP_EXTRACTION_MARKER, SKIP_MARKER } from './claude-commands.js'
import {
  ClaudeSettingsError,
  getHookStatus,
  installCommands,
  installHooks,
  uninstallCommands,
  uninstallHooks
} from './installer.js'

let tempDir = ''
let settingsPath = ''

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-memory-installer-'))
  settingsPath = path.join(tempDir, 'settings.json')
})

afterEach(() => {
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
  tempDir = ''
  settingsPath = ''
})

describe('installer command safety', () => {
  it('installCommands creates file when missing and is idempotent', () => {
    const first = installCommands(settingsPath)
    const filePath = first['prior-knowledge'].path
    expect(fs.existsSync(filePath)).toBe(true)
    const original = fs.readFileSync(filePath, 'utf-8')

    const status = installCommands(settingsPath)
    const after = fs.readFileSync(filePath, 'utf-8')

    expect(after).toBe(original)
    expect(status['prior-knowledge'].installed).toBe(true)
    expect(status['prior-knowledge'].modified).toBe(false)
  })

  it('installCommands reports modified and preserves custom content', () => {
    const first = installCommands(settingsPath)
    const filePath = first['prior-knowledge'].path
    fs.writeFileSync(filePath, 'custom content', 'utf-8')

    const status = installCommands(settingsPath)
    const after = fs.readFileSync(filePath, 'utf-8')

    expect(after).toBe('custom content')
    expect(status['prior-knowledge'].installed).toBe(false)
    expect(status['prior-knowledge'].modified).toBe(true)
  })

  it('uninstallCommands deletes file when content matches expected', () => {
    const first = installCommands(settingsPath)
    const filePath = first['prior-knowledge'].path
    expect(fs.existsSync(filePath)).toBe(true)

    const status = uninstallCommands(settingsPath)

    expect(fs.existsSync(filePath)).toBe(false)
    expect(status['prior-knowledge'].installed).toBe(false)
    expect(status['prior-knowledge'].modified).toBe(false)
  })

  it('uninstallCommands preserves custom file and reports modified', () => {
    const first = installCommands(settingsPath)
    const filePath = first['prior-knowledge'].path
    fs.writeFileSync(filePath, 'custom content', 'utf-8')

    const status = uninstallCommands(settingsPath)

    expect(fs.existsSync(filePath)).toBe(true)
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('custom content')
    expect(status['prior-knowledge'].installed).toBe(false)
    expect(status['prior-knowledge'].modified).toBe(true)
  })

  it('uninstallCommands returns uninstalled status when file is missing', () => {
    const status = uninstallCommands(settingsPath)
    expect(status['prior-knowledge'].installed).toBe(false)
    expect(status['prior-knowledge'].modified).toBe(false)
  })

  it('installCommands creates skip-extraction with both skip markers', () => {
    const status = installCommands(settingsPath)
    const skipExtraction = status['skip-extraction']
    expect(skipExtraction.installed).toBe(true)
    expect(skipExtraction.modified).toBe(false)

    const content = fs.readFileSync(skipExtraction.path, 'utf-8')
    expect(content).toContain(SKIP_MARKER)
    expect(content).toContain(SKIP_EXTRACTION_MARKER)
  })
})

describe('installer hook management', () => {
  it('installHooks writes expected hook commands and uninstallHooks removes them', () => {
    const configRoot = path.join(tempDir, 'config-root')
    const installed = installHooks(settingsPath, configRoot)

    expect(installed.UserPromptSubmit.installed).toBe(true)
    expect(installed.SessionEnd.installed).toBe(true)
    expect(installed.PreCompact.installed).toBe(true)
    expect(installed.UserPromptSubmit.configured).toBe(installed.UserPromptSubmit.expected)

    const uninstalled = uninstallHooks(settingsPath, configRoot)
    expect(uninstalled.UserPromptSubmit.installed).toBe(false)
    expect(uninstalled.SessionEnd.installed).toBe(false)
    expect(uninstalled.PreCompact.installed).toBe(false)
  })

  it('uninstallHooks preserves unrelated hook commands', () => {
    const configRoot = path.join(tempDir, 'config-root')
    const customCommand = 'node "/tmp/custom-hook.js"'

    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              { type: 'command', command: customCommand, timeout: 10 }
            ]
          }
        ]
      }
    }), 'utf-8')

    installHooks(settingsPath, configRoot)
    uninstallHooks(settingsPath, configRoot)

    const status = getHookStatus(settingsPath, configRoot)
    expect(status.UserPromptSubmit.installed).toBe(false)

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
      hooks?: { UserPromptSubmit?: Array<{ hooks?: Array<{ command?: string }> }> }
    }
    const userPromptHooks = settings.hooks?.UserPromptSubmit ?? []
    const remainingCommands = userPromptHooks.flatMap(entry => (entry.hooks ?? []).map(hook => hook.command ?? ''))
    expect(remainingCommands).toContain(customCommand)
  })
})

describe('installer settings parsing errors', () => {
  it('throws ClaudeSettingsError when settings.json is invalid JSON', () => {
    fs.writeFileSync(settingsPath, '{', 'utf-8')
    expect(() => installHooks(settingsPath, tempDir)).toThrowError(ClaudeSettingsError)
    expect(() => installHooks(settingsPath, tempDir)).toThrowError('settings.json is not valid JSON')
  })

  it('throws ClaudeSettingsError when settings.json is not an object', () => {
    fs.writeFileSync(settingsPath, '[]', 'utf-8')
    expect(() => installHooks(settingsPath, tempDir)).toThrowError(ClaudeSettingsError)
    expect(() => installHooks(settingsPath, tempDir)).toThrowError('settings.json must be a JSON object')
  })
})
