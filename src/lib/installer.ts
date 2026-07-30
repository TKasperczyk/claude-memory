import fs from 'fs'
import path from 'path'
import { SKIP_MARKER, SKIP_EXTRACTION_MARKER, REMEMBER_MARKER, getCommandFilePath } from './claude-commands.js'
import { readFileIfExists } from './shared.js'
import { isPlainObject } from './parsing.js'
import { canonicalizePath } from './paths.js'
import {
  getDistArtifactRelativePath,
  getHookArtifactRelativePath,
  getHookScriptPath,
  getMcpServerPath,
  HOOK_SCRIPTS
} from './runtime-artifacts.js'
import type { CommandStatus, HookEvent, HookStatus, InstallationStatus, McpStatus } from '../../shared/types.js'

export type { CommandStatus, HookEvent, HookStatus, InstallationStatus, McpStatus } from '../../shared/types.js'

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

const CLAUDE_HOOK_TIMEOUT_SECONDS = 15
const MCP_SERVER_NAME = 'claude-memory'
const CLAUDE_MEMORY_HOOK_PATH_SUFFIXES = [
  ...new Set(
    Object.values(HOOK_SCRIPTS).map(script =>
      `/${getDistArtifactRelativePath(getHookArtifactRelativePath(script))}`
    )
  )
]

const MEMORY_COMMAND_CONTENT = `---
description: Show injected prior knowledge from this session
---

${SKIP_MARKER}

Display the full contents of the <prior-knowledge> section that was injected at the start of this conversation. Show it exactly as it appears, formatted nicely, without summarizing or omitting anything.
`

const SKIP_EXTRACTION_COMMAND_CONTENT = `---
description: Skip memory extraction when this session ends
---

${SKIP_MARKER}
${SKIP_EXTRACTION_MARKER}

Acknowledge that memory extraction will be skipped when this session ends. Say exactly: "Memory extraction will be skipped for this session." and nothing else.
`

const REMEMBER_COMMAND_CONTENT = `---
description: Mark recent conversation for memory extraction
---

${SKIP_MARKER}
${REMEMBER_MARKER}

The user is flagging that the recent conversation contains important knowledge that should be remembered. Briefly acknowledge what you think they want remembered based on the preceding exchanges, then say: "This area has been flagged for memory extraction."
`

const COMMAND_DEFINITIONS: Record<string, CommandDefinition> = {
  'prior-knowledge': {
    filename: 'prior-knowledge.md',
    content: MEMORY_COMMAND_CONTENT
  },
  'skip-extraction': {
    filename: 'skip-extraction.md',
    content: SKIP_EXTRACTION_COMMAND_CONTENT
  },
  'remember': {
    filename: 'remember.md',
    content: REMEMBER_COMMAND_CONTENT
  }
}

export function getInstallationStatus(claudeSettingsPath: string, configRoot: string, claudeConfigPath?: string): InstallationStatus {
  const hookDefinitions = buildHookDefinitions(configRoot)
  const settings = readClaudeSettingsFile(claudeSettingsPath)
  const hooks = buildHookStatus(settings, configRoot, hookDefinitions)
  const commands = buildCommandStatus(getCommandEntries(claudeSettingsPath))
  const mcpSettings = claudeConfigPath ? readClaudeSettingsFile(claudeConfigPath) : settings
  const mcp = getMcpStatus(mcpSettings, configRoot)
  return { hooks, commands, mcp }
}

export function getHookStatus(claudeSettingsPath: string, configRoot: string): Record<HookEvent, HookStatus> {
  const hookDefinitions = buildHookDefinitions(configRoot)
  const settings = readClaudeSettingsFile(claudeSettingsPath)
  return buildHookStatus(settings, configRoot, hookDefinitions)
}

export function getRegisteredClaudeMemoryHookRoots(claudeSettingsPath: string): string[] {
  const settings = readClaudeSettingsFile(claudeSettingsPath)
  if (!settings || !isPlainObject(settings.hooks)) return []

  const roots = new Set<string>()
  for (const eventConfig of Object.values(settings.hooks)) {
    for (const command of collectHookCommands(eventConfig)) {
      for (const root of extractClaudeMemoryHookRoots(command)) {
        roots.add(canonicalizePath(root))
      }
    }
  }
  return [...roots].sort()
}

export function installAll(claudeSettingsPath: string, configRoot: string, claudeConfigPath?: string): InstallationStatus {
  const hooks = installHooks(claudeSettingsPath, configRoot)
  const commands = installCommands(claudeSettingsPath)
  const mcpPath = claudeConfigPath ?? claudeSettingsPath
  const mcp = installMcp(mcpPath, configRoot)
  return { hooks, commands, mcp }
}

export function uninstallAll(claudeSettingsPath: string, configRoot: string, claudeConfigPath?: string): InstallationStatus {
  const hooks = uninstallHooks(claudeSettingsPath, configRoot)
  const commands = uninstallCommands(claudeSettingsPath)
  const mcpPath = claudeConfigPath ?? claudeSettingsPath
  const mcp = uninstallMcp(mcpPath, configRoot)
  return { hooks, commands, mcp }
}

export function installHooks(
  claudeSettingsPath: string,
  configRoot: string,
  events?: readonly HookEvent[]
): Record<HookEvent, HookStatus> {
  const hookDefinitions = buildHookDefinitions(configRoot)
  const settings = (readClaudeSettingsFile(claudeSettingsPath) ?? {}) as Record<string, unknown>
  const hooksConfig = isPlainObject(settings.hooks)
    ? settings.hooks as Record<string, unknown>
    : {}
  settings.hooks = hooksConfig

  updateHooksConfig(
    hooksConfig,
    hookDefinitions,
    configRoot,
    'install',
    events ? new Set(events) : undefined
  )
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

export function installCommands(
  claudeSettingsPath: string,
  commandNames?: readonly string[]
): Record<string, CommandStatus> {
  const entries = getCommandEntries(claudeSettingsPath)
  const selectedNames = commandNames ? new Set(commandNames) : null
  for (const entry of entries) {
    if (selectedNames && !selectedNames.has(entry.key)) continue
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
  const definitions = {} as Record<HookEvent, HookDefinition>
  const entries = Object.entries(HOOK_SCRIPTS) as [HookEvent, string][]
  for (const [eventName, script] of entries) {
    definitions[eventName] = {
      script,
      command: `node "${getHookScriptPath(configRoot, script)}"`
    }
  }
  return definitions
}

function updateHooksConfig(
  hooksConfig: Record<string, unknown>,
  hookDefinitions: Record<HookEvent, HookDefinition>,
  configRoot: string,
  action: 'install' | 'uninstall',
  selectedEvents?: ReadonlySet<HookEvent>
): void {
  const entries = Object.entries(hookDefinitions) as [HookEvent, HookDefinition][]
  for (const [eventName, hookDefinition] of entries) {
    if (selectedEvents && !selectedEvents.has(eventName)) continue
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

function extractClaudeMemoryHookRoots(command: string): string[] {
  const normalizedCommand = normalizeHookCommand(command)
  const roots: string[] = []
  for (const suffix of CLAUDE_MEMORY_HOOK_PATH_SUFFIXES) {
    const escapedSuffix = escapeRegExp(suffix)
    const quotedPath = new RegExp(`(["'])([^"']*${escapedSuffix})\\1`, 'g')
    const unquotedPath = new RegExp(`(?:^|\\s)(\\S*${escapedSuffix})(?=\\s|$)`, 'g')
    for (const match of normalizedCommand.matchAll(quotedPath)) {
      addHookRoot(roots, match[2], suffix)
    }
    for (const match of normalizedCommand.matchAll(unquotedPath)) {
      addHookRoot(roots, match[1], suffix)
    }
  }
  return roots
}

function addHookRoot(roots: string[], scriptPath: string, suffix: string): void {
  const root = scriptPath.slice(0, -suffix.length)
  if (root) roots.push(root)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function matchesClaudeHook(command: string, configRoot: string, scriptName: string): boolean {
  const normalizedCommand = normalizeHookCommand(command)
  const resolvedConfigRoot = path.resolve(configRoot)
  const normalizedConfigRoot = normalizeHookCommand(resolvedConfigRoot)
  if (!normalizedCommand.includes(normalizedConfigRoot)) return false
  const scriptPath = normalizeHookCommand(getHookScriptPath(resolvedConfigRoot, scriptName))
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
  let destinationPath = settingsPath
  try {
    if (fs.lstatSync(settingsPath).isSymbolicLink()) {
      try {
        destinationPath = fs.realpathSync(settingsPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        // Dangling symlink (dotfiles link created before its target exists):
        // resolve the link text so we write through to the intended target
        // instead of replacing the link with a regular file.
        destinationPath = path.resolve(path.dirname(settingsPath), fs.readlinkSync(settingsPath))
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true })
  const temporaryPath = path.join(
    path.dirname(destinationPath),
    `.${path.basename(destinationPath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  )
  try {
    let mode: number | undefined
    try {
      const stats = fs.statSync(destinationPath)
      fs.accessSync(destinationPath, fs.constants.W_OK)
      mode = stats.mode & 0o777
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    fs.writeFileSync(
      temporaryPath,
      `${JSON.stringify(settings, null, 2)}\n`,
      { encoding: 'utf-8', flag: 'wx', ...(mode !== undefined ? { mode } : {}) }
    )
    if (mode !== undefined) {
      fs.chmodSync(temporaryPath, mode)
    }
    fs.renameSync(temporaryPath, destinationPath)
  } catch (error) {
    try {
      fs.unlinkSync(temporaryPath)
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Preserve the original settings-write failure.
      }
    }
    throw error
  }
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

// --- MCP server installation ---

function buildMcpCommand(configRoot: string): string {
  return `node "${getMcpServerPath(configRoot)}"`
}

function getMcpServerConfig(settings: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!settings || !isPlainObject(settings.mcpServers)) return null
  const servers = settings.mcpServers as Record<string, unknown>
  const entry = servers[MCP_SERVER_NAME]
  if (!isPlainObject(entry)) return null
  return entry as Record<string, unknown>
}

function getMcpStatus(settings: Record<string, unknown> | null, configRoot: string): McpStatus {
  const expected = buildMcpCommand(configRoot)
  const entry = getMcpServerConfig(settings)
  if (!entry) {
    return { installed: false, configured: null, expected }
  }
  const args = Array.isArray(entry.args) ? entry.args as string[] : []
  const command = typeof entry.command === 'string' ? entry.command : ''
  const configured = [command, ...args].join(' ')
  const serverPath = getMcpServerPath(configRoot)
  const installed = configured.includes(serverPath)
  return { installed, configured, expected }
}

function installMcp(claudeSettingsPath: string, configRoot: string): McpStatus {
  const settings = (readClaudeSettingsFile(claudeSettingsPath) ?? {}) as Record<string, unknown>
  const servers = isPlainObject(settings.mcpServers)
    ? settings.mcpServers as Record<string, unknown>
    : {}
  settings.mcpServers = servers

  const serverPath = getMcpServerPath(configRoot)
  servers[MCP_SERVER_NAME] = {
    type: 'stdio',
    command: 'node',
    args: [serverPath]
  }

  writeClaudeSettingsFile(claudeSettingsPath, settings)
  return getMcpStatus(settings, configRoot)
}

function uninstallMcp(claudeSettingsPath: string, configRoot: string): McpStatus {
  const settings = readClaudeSettingsFile(claudeSettingsPath)
  if (!settings || !isPlainObject(settings.mcpServers)) {
    return getMcpStatus(settings, configRoot)
  }

  const servers = settings.mcpServers as Record<string, unknown>
  delete servers[MCP_SERVER_NAME]
  if (Object.keys(servers).length === 0) {
    delete settings.mcpServers
  }

  writeClaudeSettingsFile(claudeSettingsPath, settings)
  return getMcpStatus(settings, configRoot)
}
