import path from 'path'
import { homedir } from 'os'
import { findGitRoot } from '../../src/lib/context.js'
import { loadConfig } from '../../src/lib/config.js'
import {
  CLAUDE_CONFIG_PATH,
  CLAUDE_SETTINGS_PATH,
  PROJECT_ROOT
} from '../../src/lib/paths.js'
import type { Config } from '../../src/lib/types.js'
import type { RecordType } from '../../shared/types.js'

export type ServerContext = {
  configRoot: string
  installationRoot: string
  config: Config
  memoryTypes: RecordType[]
  suggestionAllowedRoots: string[]
  claudeSettingsPath: string
  claudeConfigPath: string
}

export function createServerContext(): ServerContext {
  const configRoot = findGitRoot(process.cwd()) ?? process.cwd()
  const config = loadConfig(configRoot)
  const memoryTypes: RecordType[] = ['command', 'error', 'discovery', 'procedure', 'warning']
  const suggestionAllowedRoots = [
    path.resolve(configRoot),
    path.resolve(homedir(), '.claude', 'skills')
  ]
  return {
    configRoot,
    installationRoot: PROJECT_ROOT,
    config,
    memoryTypes,
    suggestionAllowedRoots,
    claudeSettingsPath: CLAUDE_SETTINGS_PATH,
    claudeConfigPath: CLAUDE_CONFIG_PATH
  }
}
