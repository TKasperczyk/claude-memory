import path from 'path'
import { DEFAULT_CONFIG, createConfig, type Config } from './types.js'
import { readJsonFileSafe } from './json.js'

export function loadConfig(root: string): Config {
  if (!root) return DEFAULT_CONFIG
  const configPath = path.join(root, 'config.json')
  return readJsonFileSafe(configPath, {
    fallback: DEFAULT_CONFIG,
    errorMessage: '[claude-memory] Failed to load config.json:',
    coerce: data => createConfig(data as Partial<Config>)
  }) ?? DEFAULT_CONFIG
}
