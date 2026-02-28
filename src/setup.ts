#!/usr/bin/env -S npx tsx

import fs from 'fs'
import os from 'os'
import path from 'path'
import readline from 'readline'
import { fileURLToPath } from 'url'
import { readJsonFileSafe, writeJsonFile } from './lib/json.js'
import { loadSettings, saveSettings } from './lib/settings.js'
import { MODEL_OPTIONS } from './lib/settings-schema.js'
import { installAll } from './lib/installer.js'
import { loadCredentials } from './lib/anthropic.js'
import { DEFAULT_CONFIG, EMBEDDING_DIM, type Config } from './lib/types.js'

// ---------------------------------------------------------------------------
// ANSI helpers (zero dependencies)
// ---------------------------------------------------------------------------

const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RED = '\x1b[31m'
const CYAN = '\x1b[36m'

const green = (t: string) => `${GREEN}${t}${RESET}`
const yellow = (t: string) => `${YELLOW}${t}${RESET}`
const red = (t: string) => `${RED}${t}${RESET}`
const cyan = (t: string) => `${CYAN}${t}${RESET}`
const bold = (t: string) => `${BOLD}${t}${RESET}`
const dim = (t: string) => `${DIM}${t}${RESET}`

// ---------------------------------------------------------------------------
// Readline utilities
// ---------------------------------------------------------------------------

let rl: readline.Interface
let rlClosed = false

function initReadline(): void {
  rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  rl.on('close', () => { rlClosed = true })
}

function closeReadline(): void {
  rl.close()
}

function ask(prompt: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue != null ? ` ${dim(`[${defaultValue}]`)}` : ''
  // If readline already closed (piped stdin EOF), return default immediately
  if (rlClosed) return Promise.resolve(defaultValue || '')
  return new Promise(resolve => {
    rl.question(`  ${prompt}${suffix}: `, answer => {
      resolve(answer.trim() || defaultValue || '')
    })
    // If readline closes while question is pending, resolve with default
    rl.once('close', () => resolve(defaultValue || ''))
  })
}

async function confirm(prompt: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? 'Y/n' : 'y/N'
  const answer = await ask(`${prompt} ${dim(`(${hint})`)}`)
  if (!answer) return defaultYes
  return answer.toLowerCase().startsWith('y')
}

async function choose(prompt: string, options: { value: string; label: string }[], defaultValue: string): Promise<string> {
  console.log(`\n  ${prompt}`)
  for (let i = 0; i < options.length; i++) {
    const isDefault = options[i].value === defaultValue
    const marker = isDefault ? green('*') : ' '
    const label = isDefault ? bold(options[i].label) : options[i].label
    console.log(`    ${marker} ${i + 1}) ${label}`)
  }
  const answer = await ask('Choice', String(options.findIndex(o => o.value === defaultValue) + 1))
  const index = parseInt(answer, 10) - 1
  if (index >= 0 && index < options.length) return options[index].value
  return defaultValue
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MEMORY_DIR = path.join(os.homedir(), '.claude-memory')
const CONFIG_PATH = path.join(MEMORY_DIR, 'config.json')
const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json')
const CLAUDE_CONFIG_PATH = path.join(os.homedir(), '.claude.json')

// ---------------------------------------------------------------------------
// Wizard state
// ---------------------------------------------------------------------------

interface WizardState {
  embeddings: {
    baseUrl: string
    model: string
    apiKey?: string
  }
  lancedb: {
    directory: string
    table: string
  }
  extractionModel: string
  anthropicKeyEntered: string | null
}

// ---------------------------------------------------------------------------
// Step 1: Welcome
// ---------------------------------------------------------------------------

function stepWelcome(): void {
  console.log('')
  console.log(`  ${bold(cyan('claude-memory'))} setup wizard`)
  console.log(`  ${dim('─'.repeat(40))}`)
  console.log('')
  console.log(`  Technical knowledge persistence for Claude Code.`)
  console.log(`  Extracts durable knowledge from conversations and`)
  console.log(`  injects relevant memories into future sessions.`)
  console.log('')
  console.log(`  This wizard will configure:`)
  console.log(`    1. Embedding server connection`)
  console.log(`    2. Anthropic API credentials`)
  console.log(`    3. Vector storage location`)
  console.log(`    4. Extraction model`)
  console.log(`    5. Hook & MCP installation`)
  console.log('')
}

// ---------------------------------------------------------------------------
// Step 2: Embedding server
// ---------------------------------------------------------------------------

async function testEmbeddingConnection(
  baseUrl: string, model: string, apiKey?: string
): Promise<{ ok: boolean; error?: string; dimension?: number }> {
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`

    const response = await fetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ input: 'test', model }),
      signal: AbortSignal.timeout(10000)
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      return { ok: false, error: `HTTP ${response.status}: ${text.slice(0, 200)}` }
    }

    const data = await response.json() as { data?: Array<{ embedding?: number[] }> }
    const embedding = data?.data?.[0]?.embedding
    if (!embedding || !Array.isArray(embedding)) {
      return { ok: false, error: 'Unexpected response format -- no embedding array found' }
    }

    return { ok: true, dimension: embedding.length }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: msg }
  }
}

async function stepEmbeddings(state: WizardState): Promise<void> {
  console.log(`  ${bold('Embedding Server')}`)
  console.log(`  ${dim('An embedding API is required for semantic search.')}`)
  console.log('')

  state.embeddings.baseUrl = await ask('Base URL', state.embeddings.baseUrl)
  state.embeddings.model = await ask('Model name', state.embeddings.model)

  const needsKey = await confirm('Does the server require an API key?', false)
  if (needsKey) {
    state.embeddings.apiKey = await ask('API key')
  } else {
    state.embeddings.apiKey = undefined
  }

  console.log(`\n  Testing connection...`)
  const result = await testEmbeddingConnection(
    state.embeddings.baseUrl, state.embeddings.model, state.embeddings.apiKey
  )

  if (result.ok) {
    console.log(`  ${green('OK')} -- embedding dimension: ${result.dimension}`)
    if (result.dimension !== EMBEDDING_DIM) {
      console.log(`  ${yellow('WARN')} -- expected dimension ${EMBEDDING_DIM}, got ${result.dimension}`)
      console.log(`  ${dim('claude-memory requires embeddings of dimension ' + EMBEDDING_DIM + '.')}`)
    }
  } else {
    console.log(`  ${yellow('WARN')} -- ${result.error}`)
    console.log(`  ${dim('You can configure this later. The server must be running when Claude Code starts.')}`)
  }
  console.log('')
}

// ---------------------------------------------------------------------------
// Step 3: Anthropic credentials
// ---------------------------------------------------------------------------

async function stepAnthropic(state: WizardState): Promise<void> {
  console.log(`  ${bold('Anthropic API Credentials')}`)
  console.log('')

  // Check env vars (matches runtime auth order in anthropic.ts)
  const apiKeyEnv = process.env.ANTHROPIC_API_KEY || process.env.OPENCODE_API_KEY
  if (apiKeyEnv) {
    const varName = process.env.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY' : 'OPENCODE_API_KEY'
    console.log(`  ${green('OK')} -- found ${varName} in environment`)
    console.log('')
    return
  }
  if (process.env.ANTHROPIC_AUTH_TOKEN) {
    console.log(`  ${green('OK')} -- found ANTHROPIC_AUTH_TOKEN in environment`)
    console.log('')
    return
  }

  // Check Claude Code credentials (Keychain on macOS, file on Linux)
  const creds = loadCredentials()
  if (creds) {
    const sourceLabel = creds.source === 'claude-code-keychain'
      ? 'macOS Keychain (Claude Code)'
      : 'Claude Code credentials file'
    console.log(`  ${green('OK')} -- found OAuth credentials via ${sourceLabel}`)
    console.log('')
    return
  }

  console.log(`  ${yellow('No credentials detected.')}`)
  console.log(`  ${dim('claude-memory needs Anthropic API access for extraction and maintenance.')}`)
  console.log('')

  const key = await ask('ANTHROPIC_API_KEY (or press Enter to skip)')
  if (!key) {
    console.log(`  ${dim('Skipped. Set ANTHROPIC_API_KEY in your shell profile before using claude-memory.')}`)
    console.log('')
    return
  }

  // Test the key with cheapest available model
  console.log(`\n  Testing API key...`)
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk')
    const client = new Anthropic({ apiKey: key })
    // Use haiku (cheapest), fall back to sonnet if haiku unavailable
    for (const testModel of ['claude-haiku-4-5-20251001', 'claude-sonnet-4-5-20250929']) {
      try {
        await client.messages.create({
          model: testModel,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ok' }]
        })
        console.log(`  ${green('OK')} -- API key is valid`)
        break
      } catch (e) {
        const msg = e instanceof Error ? e.message : ''
        // Model not available on this account -- try next
        if (msg.includes('model') || msg.includes('not found') || msg.includes('404')) continue
        throw e
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.log(`  ${yellow('WARN')} -- ${msg}`)
  }

  state.anthropicKeyEntered = key
  console.log('')
  console.log(`  Add this to your shell profile (${dim('.bashrc')}, ${dim('.zshrc')}, etc.):`)
  console.log(`    ${cyan(`export ANTHROPIC_API_KEY=${key}`)}`)
  console.log('')
}

// ---------------------------------------------------------------------------
// Step 4: LanceDB storage
// ---------------------------------------------------------------------------

async function stepStorage(state: WizardState): Promise<void> {
  console.log(`  ${bold('Vector Storage')}`)
  console.log(`  ${dim('LanceDB stores memory embeddings locally (no server needed).')}`)
  console.log('')

  const rawDir = await ask('Storage directory', state.lancedb.directory.replace(os.homedir(), '~'))
  state.lancedb.directory = rawDir.replace(/^~/, os.homedir())
  state.lancedb.table = await ask('Collection name', state.lancedb.table)
  console.log('')
}

// ---------------------------------------------------------------------------
// Step 5: Extraction model
// ---------------------------------------------------------------------------

async function stepExtractionModel(state: WizardState): Promise<void> {
  console.log(`  ${bold('Extraction Model')}`)
  console.log(`  ${dim('Model used to extract knowledge from conversations.')}`)

  state.extractionModel = await choose(
    'Which model?',
    MODEL_OPTIONS,
    state.extractionModel
  )
  console.log('')
}

// ---------------------------------------------------------------------------
// Step 6: Write config
// ---------------------------------------------------------------------------

function stepWriteConfig(state: WizardState): void {
  console.log(`  ${bold('Writing configuration...')}`)

  // Load existing config to preserve fields we don't manage (extraction, injection, insecure, etc.)
  const existing = readJsonFileSafe<Record<string, unknown>>(CONFIG_PATH, {
    fallback: null,
    errorMessage: ''
  }) ?? {}

  // Merge wizard-managed fields into existing config
  const config = {
    ...existing,
    lancedb: {
      ...(existing.lancedb as Record<string, unknown> ?? {}),
      directory: state.lancedb.directory,
      table: state.lancedb.table
    },
    embeddings: {
      ...(existing.embeddings as Record<string, unknown> ?? {}),
      baseUrl: state.embeddings.baseUrl,
      model: state.embeddings.model,
      ...(state.embeddings.apiKey ? { apiKey: state.embeddings.apiKey } : { apiKey: undefined })
    }
  }

  // Clean undefined values from embeddings (e.g. removed apiKey)
  const embeddings = config.embeddings as Record<string, unknown>
  for (const key of Object.keys(embeddings)) {
    if (embeddings[key] === undefined) delete embeddings[key]
  }

  writeJsonFile(CONFIG_PATH, config, { ensureDir: true, pretty: 2 })
  console.log(`  ${green('OK')} -- ${dim(CONFIG_PATH.replace(os.homedir(), '~'))}`)

  // Save extraction model to settings
  saveSettings({ extractionModel: state.extractionModel })
  console.log(`  ${green('OK')} -- extraction model saved to settings`)
  console.log('')
}

// ---------------------------------------------------------------------------
// Step 7: Install hooks & MCP
// ---------------------------------------------------------------------------

function stepInstall(): void {
  console.log(`  ${bold('Installing hooks & MCP server...')}`)

  // Check if all required dist artifacts exist
  const requiredArtifacts = [
    'dist/hooks/pre-prompt.js',
    'dist/hooks/post-session.js',
    'dist/mcp-server.js'
  ]
  const missing = requiredArtifacts.filter(f => !fs.existsSync(path.join(PROJECT_ROOT, f)))
  if (missing.length > 0) {
    console.log(`  ${yellow('WARN')} -- missing build artifacts: ${missing.join(', ')}`)
    console.log(`  ${dim('Run')} ${cyan('pnpm build')} ${dim('after setup for hooks to work.')}`)
    console.log('')
  }

  const status = installAll(CLAUDE_SETTINGS_PATH, PROJECT_ROOT, CLAUDE_CONFIG_PATH)

  // Report hooks
  for (const [event, hook] of Object.entries(status.hooks)) {
    const icon = hook.installed ? green('OK') : red('FAIL')
    console.log(`  ${icon} -- hook: ${event}`)
  }

  // Report commands
  for (const [name, cmd] of Object.entries(status.commands)) {
    const icon = cmd.installed ? green('OK') : red('FAIL')
    console.log(`  ${icon} -- command: /${name}`)
  }

  // Report MCP
  const mcpIcon = status.mcp.installed ? green('OK') : red('FAIL')
  console.log(`  ${mcpIcon} -- MCP server`)
  console.log('')
}

// ---------------------------------------------------------------------------
// Step 8: Summary
// ---------------------------------------------------------------------------

function printSummary(state: WizardState): void {
  console.log(`  ${bold(green('Setup complete'))}`)
  console.log(`  ${dim('─'.repeat(40))}`)
  console.log('')
  console.log(`  Embedding server:  ${state.embeddings.baseUrl}`)
  console.log(`  Embedding model:   ${state.embeddings.model}`)
  console.log(`  Storage:           ${state.lancedb.directory.replace(os.homedir(), '~')}`)
  console.log(`  Collection:        ${state.lancedb.table}`)
  console.log(`  Extraction model:  ${MODEL_OPTIONS.find(m => m.value === state.extractionModel)?.label ?? state.extractionModel}`)
  console.log('')

  if (state.anthropicKeyEntered) {
    console.log(`  ${yellow('Remember to add to your shell profile:')}`)
    console.log(`    export ANTHROPIC_API_KEY=${state.anthropicKeyEntered}`)
    console.log('')
  }

  console.log(`  ${bold('Next steps:')}`)
  console.log(`    1. Ensure your embedding server is running`)
  console.log(`    2. Start a Claude Code session -- memories will begin accumulating`)
  console.log(`    3. Run ${cyan('pnpm dashboard')} to view and manage your memories`)
  console.log('')
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  initReadline()

  try {
    // Load existing config as defaults
    const existing = readJsonFileSafe<Partial<Config>>(CONFIG_PATH, {
      fallback: null,
      errorMessage: ''
    })

    const state: WizardState = {
      embeddings: {
        baseUrl: existing?.embeddings?.baseUrl ?? DEFAULT_CONFIG.embeddings.baseUrl,
        model: existing?.embeddings?.model ?? DEFAULT_CONFIG.embeddings.model,
        apiKey: existing?.embeddings?.apiKey
      },
      lancedb: {
        directory: existing?.lancedb?.directory ?? DEFAULT_CONFIG.lancedb.directory,
        table: existing?.lancedb?.table ?? DEFAULT_CONFIG.lancedb.table
      },
      extractionModel: DEFAULT_CONFIG.extraction.model,
      anthropicKeyEntered: null
    }

    // Load existing settings for extraction model default
    try {
      const settings = loadSettings()
      state.extractionModel = settings.extractionModel
    } catch { /* use default */ }

    stepWelcome()
    await stepEmbeddings(state)
    await stepAnthropic(state)
    await stepStorage(state)
    await stepExtractionModel(state)
    stepWriteConfig(state)
    stepInstall()
    printSummary(state)
  } finally {
    closeReadline()
  }
}

main()
  .then(() => { process.exitCode = 0 })
  .catch(error => {
    console.error(red(`\nSetup failed: ${error instanceof Error ? error.message : String(error)}`))
    process.exitCode = 1
  })
