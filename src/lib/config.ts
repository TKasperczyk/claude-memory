import fs from 'fs'
import path from 'path'
import { DEFAULT_CONFIG, createConfig, type Config } from './types.js'

export function loadConfig(root: string): Config {
  if (!root) return DEFAULT_CONFIG
  const configPath = path.join(root, 'config.json')
  if (!fs.existsSync(configPath)) return DEFAULT_CONFIG

  try {
    const raw = fs.readFileSync(configPath, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<Config>
    return createConfig(parsed)
  } catch (error) {
    console.error('[claude-memory] Failed to load config.json:', error)
    return DEFAULT_CONFIG
  }
}
