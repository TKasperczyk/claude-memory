import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installCommands, uninstallCommands } from './installer.js'

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
  it('installCommands writes file when missing', () => {
    const status = installCommands(settingsPath)
    const commandStatus = status.memory
    expect(commandStatus.installed).toBe(true)
    expect(commandStatus.modified).toBe(false)
    expect(fs.existsSync(commandStatus.path)).toBe(true)
  })

  it('installCommands writes file when content matches expected (idempotent)', () => {
    const first = installCommands(settingsPath)
    const filePath = first.memory.path
    const original = fs.readFileSync(filePath, 'utf-8')

    installCommands(settingsPath)
    const after = fs.readFileSync(filePath, 'utf-8')

    expect(after).toBe(original)
  })

  it('installCommands skips writing when file exists with different content', () => {
    const first = installCommands(settingsPath)
    const filePath = first.memory.path
    fs.writeFileSync(filePath, 'custom content', 'utf-8')

    installCommands(settingsPath)
    const after = fs.readFileSync(filePath, 'utf-8')

    expect(after).toBe('custom content')
  })

  it('uninstallCommands deletes file when content matches expected', () => {
    const first = installCommands(settingsPath)
    const filePath = first.memory.path
    expect(fs.existsSync(filePath)).toBe(true)

    uninstallCommands(settingsPath)

    expect(fs.existsSync(filePath)).toBe(false)
  })

  it('uninstallCommands skips deletion when file has different content', () => {
    const first = installCommands(settingsPath)
    const filePath = first.memory.path
    fs.writeFileSync(filePath, 'custom content', 'utf-8')

    uninstallCommands(settingsPath)

    expect(fs.existsSync(filePath)).toBe(true)
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('custom content')
  })

  it('uninstallCommands no error when file does not exist', () => {
    expect(() => uninstallCommands(settingsPath)).not.toThrow()
  })
})

describe('command status logic', () => {
  it('installed is true only when file exists and matches expected', () => {
    const status = installCommands(settingsPath)
    expect(status.memory.installed).toBe(true)
    expect(status.memory.modified).toBe(false)
  })

  it('modified is true when file exists but differs from expected', () => {
    const first = installCommands(settingsPath)
    fs.writeFileSync(first.memory.path, 'custom content', 'utf-8')

    const status = installCommands(settingsPath)
    expect(status.memory.installed).toBe(false)
    expect(status.memory.modified).toBe(true)
  })

  it('installed and modified are false when file does not exist', () => {
    const status = uninstallCommands(settingsPath)
    expect(status.memory.installed).toBe(false)
    expect(status.memory.modified).toBe(false)
  })
})
