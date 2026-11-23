import path from 'path'
import { DEFAULT_CONFIG, createConfig, type Config } from './types.js'
import { readJsonFileSafe } from './json.js'
import { asStringArray, isPlainObject } from './parsing.js'
import { isValidTableName } from './shared.js'
import { loadSettings } from './settings.js'
import { canonicalizePath, CLAUDE_MEMORY_ROOT } from './paths.js'

const GLOBAL_CONFIG_PATH = path.join(CLAUDE_MEMORY_ROOT, 'config.json')
const PROJECT_CONFIG_FILENAME = '.claude-memory.json'

function coercePartialConfig(value: unknown): Partial<Config> | null {
  if (!isPlainObject(value)) return null
  const partial: Partial<Config> = {}
  if (isPlainObject(value.lancedb)) {
    const lancedb = { ...value.lancedb } as Record<string, unknown>
    if (typeof lancedb.table === 'string') {
      const trimmed = lancedb.table.trim()
      if (!isValidTableName(trimmed)) {
        delete lancedb.table
      } else {
        lancedb.table = trimmed
      }
    } else if ('table' in lancedb) {
      delete lancedb.table
    }
    if (Object.keys(lancedb).length > 0) {
      partial.lancedb = lancedb as Config['lancedb']
    }
  }
  if (isPlainObject(value.embeddings)) {
    partial.embeddings = value.embeddings as Config['embeddings']
  }
  if (isPlainObject(value.extraction)) {
    partial.extraction = value.extraction as Config['extraction']
  }
  if (isPlainObject(value.injection)) {
    partial.injection = value.injection as Config['injection']
  }
  if (Array.isArray(value.linkedWorkspaces)) {
    const workspaces = asStringArray(value.linkedWorkspaces, { trim: true, filterEmpty: true, unique: true })
      .map(entry => canonicalizePath(entry))
    if (workspaces.length > 0) {
      partial.linkedWorkspaces = Array.from(new Set(workspaces))
    }
  }
  return Object.keys(partial).length > 0 ? partial : null
}

function mergeConfig(base: Config, override: Partial<Config>): Config {
  const linkedWorkspaces = Array.from(new Set([
    ...(base.linkedWorkspaces ?? []),
    ...(override.linkedWorkspaces ?? [])
  ]))
  return {
    lancedb: { ...base.lancedb, ...override.lancedb },
    embeddings: { ...base.embeddings, ...override.embeddings },
    extraction: { ...base.extraction, ...override.extraction },
    injection: { ...base.injection, ...override.injection },
    ...(linkedWorkspaces.length > 0 ? { linkedWorkspaces } : {})
  }
}

/**
 * Load config with merge order: defaults < global (~/.claude-memory/config.json) < project (root/.claude-memory.json)
 */
export function loadConfig(root: string): Config {
  // Start with defaults (which include env var fallbacks)
  let config = DEFAULT_CONFIG

  // Apply global config if exists
  const globalConfig = readJsonFileSafe<Partial<Config>>(GLOBAL_CONFIG_PATH, {
    fallback: null,
    coerce: coercePartialConfig,
    errorMessage: '[claude-memory] Failed to load global config.json:'
  })
  if (globalConfig) {
    config = mergeConfig(config, globalConfig)
  }

  // Apply project config if exists
  if (root) {
    const projectConfigPath = path.join(root, PROJECT_CONFIG_FILENAME)
    const projectConfig = readJsonFileSafe<Partial<Config>>(projectConfigPath, {
      fallback: null,
      coerce: coercePartialConfig,
      errorMessage: `[claude-memory] Failed to load project ${PROJECT_CONFIG_FILENAME}:`
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
