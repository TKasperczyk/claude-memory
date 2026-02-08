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
})
