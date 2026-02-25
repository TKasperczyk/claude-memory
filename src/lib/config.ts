import os from 'os'
import path from 'path'
import { DEFAULT_CONFIG, createConfig, type Config } from './types.js'
import { readJsonFileSafe } from './json.js'
import { loadSettings } from './settings.js'

const GLOBAL_CONFIG_PATH = path.join(os.homedir(), '.claude-memory', 'config.json')

function mergeConfig(base: Config, override: Partial<Config>): Config {
  return {
    lancedb: { ...base.lancedb, ...override.lancedb },
    embeddings: { ...base.embeddings, ...override.embeddings },
    extraction: { ...base.extraction, ...override.extraction },
    injection: { ...base.injection, ...override.injection }
  }
}

/**
 * Load config with merge order: defaults < global (~/.claude-memory/config.json) < project (root/config.json)
 */
export function loadConfig(root: string): Config {
  // Start with defaults (which include env var fallbacks)
  let config = DEFAULT_CONFIG

  // Apply global config if exists
  const globalConfig = readJsonFileSafe<Partial<Config>>(GLOBAL_CONFIG_PATH, {
    fallback: null,
    errorMessage: '[claude-memory] Failed to load global config.json:'
  })
  if (globalConfig) {
    config = mergeConfig(config, globalConfig)
  }

  // Apply project config if exists
  if (root) {
    const projectConfigPath = path.join(root, 'config.json')
    const projectConfig = readJsonFileSafe<Partial<Config>>(projectConfigPath, {
      fallback: null,
      errorMessage: '[claude-memory] Failed to load project config.json:'
    })
    if (projectConfig) {
      config = mergeConfig(config, projectConfig)
    }
  }

  // Apply extraction model from settings if no env var override
  if (!process.env.CC_EXTRACTION_MODEL) {
    const settings = loadSettings()
    config = mergeConfig(config, {
      extraction: { ...config.extraction, model: settings.extractionModel }
    })
  }

  return createConfig(config)
}
