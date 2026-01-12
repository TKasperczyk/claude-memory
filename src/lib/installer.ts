import fs from 'fs'
import path from 'path'
import { SKIP_MARKER, getCommandFilePath } from './claude-commands.js'
import { readFileIfExists } from './shared.js'
import { isPlainObject } from './parsing.js'
import type { CommandStatus, HookEvent, HookStatus, InstallationStatus } from '../../shared/types.js'

export type { CommandStatus, HookEvent, HookStatus, InstallationStatus } from '../../shared/types.js'

type HookDefinition = {
  script: string
  command: string
}

type CommandDefinition = {
  filename: string
  content: string
}

type CommandEntry = {
  key: string
  path: string
  content: string
}

export class ClaudeSettingsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ClaudeSettingsError'
  }
}

const CLAUDE_HOOK_TIMEOUT_SECONDS = 5

const HOOK_SCRIPTS: Record<HookEvent, string> = {
  UserPromptSubmit: 'pre-prompt.js',
  SessionEnd: 'post-session.js',
  PreCompact: 'post-session.js'
}

const MEMORY_COMMAND_CONTENT = `---
description: Show injected prior knowledge from this session
---

${SKIP_MARKER}

Display the full contents of the <prior-knowledge> section that was injected at the start of this conversation. Show it exactly as it appears, formatted nicely, without summarizing or omitting anything.
`

const COMMAND_DEFINITIONS: Record<string, CommandDefinition> = {
  memory: {
    filename: 'memory.md',
    content: MEMORY_COMMAND_CONTENT
  }
}

export function getInstallationStatus(claudeSettingsPath: string, configRoot: string): InstallationStatus {
  const hookDefinitions = buildHookDefinitions(configRoot)
  const settings = readClaudeSettingsFile(claudeSettingsPath)
  const hooks = buildHookStatus(settings, configRoot, hookDefinitions)
  const commands = buildCommandStatus(getCommandEntries(claudeSettingsPath))
  return { hooks, commands }
}

export function getHookStatus(claudeSettingsPath: string, configRoot: string): Record<HookEvent, HookStatus> {
  const hookDefinitions = buildHookDefinitions(configRoot)
  const settings = readClaudeSettingsFile(claudeSettingsPath)
  return buildHookStatus(settings, configRoot, hookDefinitions)
}

export function installAll(claudeSettingsPath: string, configRoot: string): InstallationStatus {
  const hooks = installHooks(claudeSettingsPath, configRoot)
  const commands = installCommands(claudeSettingsPath)
  return { hooks, commands }
}

export function uninstallAll(claudeSettingsPath: string, configRoot: string): InstallationStatus {
  const hooks = uninstallHooks(claudeSettingsPath, configRoot)
  const commands = uninstallCommands(claudeSettingsPath)
  return { hooks, commands }
}

export function installHooks(claudeSettingsPath: string, configRoot: string): Record<HookEvent, HookStatus> {
  const hookDefinitions = buildHookDefinitions(configRoot)
  const settings = (readClaudeSettingsFile(claudeSettingsPath) ?? {}) as Record<string, unknown>
  const hooksConfig = isPlainObject(settings.hooks)
    ? settings.hooks as Record<string, unknown>
    : {}
  settings.hooks = hooksConfig

  updateHooksConfig(hooksConfig, hookDefinitions, configRoot, 'install')
  writeClaudeSettingsFile(claudeSettingsPath, settings)

  return buildHookStatus(settings, configRoot, hookDefinitions)
}

export function uninstallHooks(claudeSettingsPath: string, configRoot: string): Record<HookEvent, HookStatus> {
  const hookDefinitions = buildHookDefinitions(configRoot)
  const settings = readClaudeSettingsFile(claudeSettingsPath)
  if (!settings) {
    return buildHookStatus(null, configRoot, hookDefinitions)
  }
  if (!isPlainObject(settings.hooks)) {
    return buildHookStatus(settings, configRoot, hookDefinitions)
  }

  const hooksConfig = settings.hooks as Record<string, unknown>
  updateHooksConfig(hooksConfig, hookDefinitions, configRoot, 'uninstall')
  writeClaudeSettingsFile(claudeSettingsPath, settings)

  return buildHookStatus(settings, configRoot, hookDefinitions)
}

export function installCommands(claudeSettingsPath: string): Record<string, CommandStatus> {
  const entries = getCommandEntries(claudeSettingsPath)
  for (const entry of entries) {
    fs.mkdirSync(path.dirname(entry.path), { recursive: true })
    const existing = readFileIfExists(entry.path)
    if (existing === null || existing === entry.content) {
      fs.writeFileSync(entry.path, entry.content, 'utf-8')
    }
  }
  return buildCommandStatus(entries)
}

export function uninstallCommands(claudeSettingsPath: string): Record<string, CommandStatus> {
  const entries = getCommandEntries(claudeSettingsPath)
  for (const entry of entries) {
    const existing = readFileIfExists(entry.path)
    if (existing === null || existing !== entry.content) {
      continue
    }
    removeFileIfExists(entry.path)
  }
  return buildCommandStatus(entries)
}

function buildHookDefinitions(configRoot: string): Record<HookEvent, HookDefinition> {
  const hooksRoot = path.resolve(configRoot, 'dist', 'hooks')
  const definitions = {} as Record<HookEvent, HookDefinition>
  const entries = Object.entries(HOOK_SCRIPTS) as [HookEvent, string][]
  for (const [eventName, script] of entries) {
    definitions[eventName] = {
      script,
      command: `node "${path.join(hooksRoot, script)}"`
    }
  }
  return definitions
}

function updateHooksConfig(
  hooksConfig: Record<string, unknown>,
  hookDefinitions: Record<HookEvent, HookDefinition>,
  configRoot: string,
  action: 'install' | 'uninstall'
): void {
  const entries = Object.entries(hookDefinitions) as [HookEvent, HookDefinition][]
  for (const [eventName, hookDefinition] of entries) {
    if (action === 'install') {
      hooksConfig[eventName] = ensureHookInstalled(hooksConfig[eventName], hookDefinition, configRoot)
      continue
    }
    if (!Object.prototype.hasOwnProperty.call(hooksConfig, eventName)) continue
    hooksConfig[eventName] = removeHookEntries(hooksConfig[eventName], hookDefinition, configRoot)
  }
}

function buildHookStatus(
  settings: Record<string, unknown> | null,
  configRoot: string,
  hookDefinitions: Record<HookEvent, HookDefinition>
): Record<HookEvent, HookStatus> {
  const hooksConfig = settings && isPlainObject(settings.hooks)
    ? settings.hooks as Record<string, unknown>
    : {}
  const status = {} as Record<HookEvent, HookStatus>
  const entries = Object.entries(hookDefinitions) as [HookEvent, HookDefinition][]
  for (const [eventName, hook] of entries) {
    const commands = collectHookCommands(hooksConfig[eventName])
    const configured = commands.find(command => matchesClaudeHook(command, configRoot, hook.script)) ?? null
    status[eventName] = {
      installed: Boolean(configured),
      configured,
      expected: hook.command
    }
  }
  return status
}

function collectHookCommands(eventConfig: unknown): string[] {
  if (!Array.isArray(eventConfig)) return []
  const commands: string[] = []
  for (const entry of eventConfig) {
    if (!isPlainObject(entry)) continue
    const hooks = entry.hooks
    if (!Array.isArray(hooks)) continue
    for (const hook of hooks) {
      if (!isPlainObject(hook)) continue
      if (typeof hook.command === 'string') {
        commands.push(hook.command)
      }
    }
  }
  return commands
}

function ensureHookInstalled(eventConfig: unknown, hook: HookDefinition, configRoot: string): unknown[] {
  const entries = Array.isArray(eventConfig) ? eventConfig.slice() : []
  let found = false

  for (const entry of entries) {
    if (!isPlainObject(entry)) continue
    const hooks = Array.isArray(entry.hooks) ? entry.hooks : null
    if (!hooks) continue
    for (const item of hooks) {
      if (!isPlainObject(item)) continue
      const command = typeof item.command === 'string' ? item.command : ''
      if (command && matchesClaudeHook(command, configRoot, hook.script)) {
        item.type = 'command'
        item.command = hook.command
        item.timeout = CLAUDE_HOOK_TIMEOUT_SECONDS
        found = true
      }
    }
  }

  if (!found) {
    entries.push({
      hooks: [
        {
          type: 'command',
          command: hook.command,
          timeout: CLAUDE_HOOK_TIMEOUT_SECONDS
        }
      ]
    })
  }

  return entries
}

function removeHookEntries(eventConfig: unknown, hook: HookDefinition, configRoot: string): unknown {
  if (!Array.isArray(eventConfig)) return eventConfig
  const entries: unknown[] = []

  for (const entry of eventConfig) {
    if (!isPlainObject(entry)) {
      entries.push(entry)
      continue
    }
    const hooks = Array.isArray(entry.hooks) ? entry.hooks : null
    if (!hooks) {
      entries.push(entry)
      continue
    }
    const retainedHooks = hooks.filter(item => {
      if (!isPlainObject(item)) return true
      const command = typeof item.command === 'string' ? item.command : ''
      if (!command) return true
      return !matchesClaudeHook(command, configRoot, hook.script)
    })
    if (retainedHooks.length === hooks.length) {
      entries.push(entry)
      continue
    }
    if (retainedHooks.length > 0) {
      entries.push({ ...entry, hooks: retainedHooks })
      continue
    }
    const hasMetadata = Object.keys(entry).some(key => key !== 'hooks')
    if (hasMetadata) {
      entries.push({ ...entry, hooks: [] })
    }
  }

  return entries
}

function normalizeHookCommand(value: string): string {
  return value.replace(/\\/g, '/')
}

function matchesClaudeHook(command: string, configRoot: string, scriptName: string): boolean {
  const normalizedCommand = normalizeHookCommand(command)
  const resolvedConfigRoot = path.resolve(configRoot)
  const normalizedConfigRoot = normalizeHookCommand(resolvedConfigRoot)
  if (!normalizedCommand.includes(normalizedConfigRoot)) return false
  const scriptPath = normalizeHookCommand(path.join(resolvedConfigRoot, 'dist', 'hooks', scriptName))
  return normalizedCommand.includes(scriptPath)
}

function readClaudeSettingsFile(settingsPath: string): Record<string, unknown> | null {
  let raw: string
  try {
    raw = fs.readFileSync(settingsPath, 'utf-8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    throw error
  }

  let parsed: unknown
  const trimmed = raw.trim()
  if (!trimmed) return {}

  try {
    parsed = JSON.parse(trimmed)
  } catch {
    throw new ClaudeSettingsError('settings.json is not valid JSON')
  }

  if (!isPlainObject(parsed)) {
    throw new ClaudeSettingsError('settings.json must be a JSON object')
  }

  return parsed
}

function writeClaudeSettingsFile(settingsPath: string, settings: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8')
}

function getCommandEntries(claudeSettingsPath: string): CommandEntry[] {
  return Object.entries(COMMAND_DEFINITIONS).map(([key, definition]) => ({
    key,
    path: getCommandFilePath(definition.filename, claudeSettingsPath),
    content: definition.content
  }))
}

function buildCommandStatus(entries: CommandEntry[]): Record<string, CommandStatus> {
  const status: Record<string, CommandStatus> = {}
  for (const entry of entries) {
    const existing = readFileIfExists(entry.path)
    status[entry.key] = {
      installed: existing !== null && existing === entry.content,
      modified: existing !== null && existing !== entry.content,
      path: entry.path
    }
  }
  return status
}

function removeFileIfExists(filePath: string): void {
  try {
    fs.unlinkSync(filePath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return
    throw error
  }
}
