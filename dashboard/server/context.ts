import path from 'path'
import { homedir } from 'os'
import { findGitRoot } from '../../src/lib/context.js'
import { loadConfig } from '../../src/lib/config.js'
import type { Config } from '../../src/lib/types.js'
import type { RecordType } from '../../shared/types.js'

export type ServerContext = {
  configRoot: string
  config: Config
  memoryTypes: RecordType[]
  suggestionAllowedRoots: string[]
  claudeSettingsPath: string
}

export function createServerContext(): ServerContext {
  const configRoot = findGitRoot(process.cwd()) ?? process.cwd()
  const config = loadConfig(configRoot)
  const memoryTypes: RecordType[] = ['command', 'error', 'discovery', 'procedure', 'warning']
  const suggestionAllowedRoots = [
    path.resolve(configRoot),
    path.resolve(homedir(), '.claude', 'skills')
  ]
  const claudeSettingsPath = path.join(homedir(), '.claude', 'settings.json')

  return {
    configRoot,
    config,
    memoryTypes,
    suggestionAllowedRoots,
    claudeSettingsPath
  }
}
