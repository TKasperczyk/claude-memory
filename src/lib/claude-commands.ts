import { homedir } from 'os'
import path from 'path'

export const SKIP_MARKER = '<!-- claude-memory:skip-injection -->'
export const SKIP_EXTRACTION_MARKER = '<!-- claude-memory:skip-extraction -->'
export const REMEMBER_MARKER = '<!-- claude-memory:remember -->'

function getCommandsDirectory(claudeSettingsPath?: string): string {
  if (claudeSettingsPath) {
    return path.join(path.dirname(claudeSettingsPath), 'commands')
  }
  return path.join(homedir(), '.claude', 'commands')
}

export function getCommandFilePath(commandName: string, claudeSettingsPath?: string): string {
  const filename = commandName.endsWith('.md') ? commandName : `${commandName}.md`
  return path.join(getCommandsDirectory(claudeSettingsPath), filename)
}
