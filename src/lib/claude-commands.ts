import fs from 'fs'
import { homedir } from 'os'
import path from 'path'

export const SKIP_MARKER = '<!-- claude-memory:skip-injection -->'

export function getCommandsDirectory(claudeSettingsPath?: string): string {
  if (claudeSettingsPath) {
    return path.join(path.dirname(claudeSettingsPath), 'commands')
  }
  return path.join(homedir(), '.claude', 'commands')
}

export function getCommandFilePath(commandName: string, claudeSettingsPath?: string): string {
  const filename = commandName.endsWith('.md') ? commandName : `${commandName}.md`
  return path.join(getCommandsDirectory(claudeSettingsPath), filename)
}

export function readFileIfExists(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    throw error
  }
}
