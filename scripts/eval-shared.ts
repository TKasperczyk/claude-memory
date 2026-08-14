/**
 * Shared helpers for the entity A/B eval scripts (eval-clone-table,
 * eval-backfill-entities, eval-discover-entity-edges, eval-retrieval,
 * eval-judge, eval-judge-gold, eval-report).
 *
 * Every eval script operates on a cloned table and hard-refuses the
 * configured production table; eval artifacts live under
 * ~/.claude-memory/eval/.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig } from '../src/lib/config.js'
import { findGitRoot } from '../src/lib/context.js'
import type { Config } from '../src/lib/types.js'

export const EVAL_TABLE_DEFAULT = 'cc_memories_eval'
export const EVAL_DATA_DIR = path.join(os.homedir(), '.claude-memory', 'eval')

export function loadProdConfig(): Config {
  const configRoot = findGitRoot(process.cwd()) ?? process.cwd()
  return loadConfig(configRoot)
}

/**
 * Derive the eval config from the production config: same directory,
 * embeddings, and extraction settings, different table. Throws when the
 * requested table would collide with production.
 */
export function buildEvalConfig(prodConfig: Config, table?: string): Config {
  const evalTable = table ?? argValue('--table') ?? EVAL_TABLE_DEFAULT
  assertNotProdTable(prodConfig, evalTable)
  return {
    ...prodConfig,
    lancedb: { ...prodConfig.lancedb, table: evalTable }
  }
}

export function assertNotProdTable(prodConfig: Config, table: string): void {
  if (table === prodConfig.lancedb.table) {
    throw new Error(
      `Refusing to operate on the production table '${table}'. Eval scripts only touch cloned tables.`
    )
  }
}

// --------------- argv helpers ---------------

export function hasFlag(flag: string): boolean {
  return process.argv.includes(flag)
}

export function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  if (index === -1 || index + 1 >= process.argv.length) return undefined
  return process.argv[index + 1]
}

export function argNumber(flag: string): number | undefined {
  const raw = argValue(flag)
  if (raw === undefined) return undefined
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric value for ${flag}: ${raw}`)
  }
  return parsed
}

// --------------- eval artifact storage ---------------

export function ensureEvalDataDir(): string {
  fs.mkdirSync(EVAL_DATA_DIR, { recursive: true })
  return EVAL_DATA_DIR
}

export function evalDataPath(fileName: string): string {
  return path.join(ensureEvalDataDir(), fileName)
}

export function readJsonLines<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return []
  const entries: T[] = []
  for (const line of fs.readFileSync(filePath, 'utf-8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      entries.push(JSON.parse(trimmed) as T)
    } catch {
      // Skip corrupt lines rather than aborting a resumable run.
    }
  }
  return entries
}

export function appendJsonLines(filePath: string, entries: unknown[]): void {
  if (entries.length === 0) return
  ensureEvalDataDir()
  const payload = entries.map(entry => JSON.stringify(entry)).join('\n') + '\n'
  fs.appendFileSync(filePath, payload, 'utf-8')
}
