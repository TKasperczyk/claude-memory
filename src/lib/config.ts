import path from 'path'
import { DEFAULT_CONFIG, createConfig, type Config } from './types.js'
import { readJsonFile } from './json.js'

export function loadConfig(root: string): Config {
  if (!root) return DEFAULT_CONFIG
  const configPath = path.join(root, 'config.json')
  return readJsonFile(configPath, {
    fallback: DEFAULT_CONFIG,
    onError: error => console.error('[claude-memory] Failed to load config.json:', error),
    coerce: data => createConfig(data as Partial<Config>)
  }) ?? DEFAULT_CONFIG
}
