import fs from 'fs'
import path from 'path'
import { homedir } from 'os'
import { readJsonFileSafe, writeJsonFile } from './json.js'
import { sanitizeRunId } from './shared.js'
import { DEFAULT_CONFIG } from './types.js'

const CLAUDE_MEMORY_ROOT = path.join(homedir(), '.claude-memory')

export function getCollectionKey(collection?: string): string {
  const fallback = DEFAULT_CONFIG.milvus.collection
  const raw = (collection ?? fallback).trim()
  return sanitizeRunId(raw || fallback)
}

export function isDefaultCollection(collection?: string): boolean {
  return getCollectionKey(collection) === getCollectionKey(DEFAULT_CONFIG.milvus.collection)
}

type NamespacedStoreOptions = {
  baseDir?: string
  suffix?: string
  sanitizeKey?: (key: string) => string
}

type BuildPathOptions = {
  collection?: string
  legacy?: boolean
  suffix?: string
  sanitize?: boolean
}

type ListKeysOptions = {
  collection?: string
  suffix?: string
  includeLegacyForDefault?: boolean
}

type ExistsOptions = ListKeysOptions

type DeleteOptions = ListKeysOptions & {
  continueOnError?: boolean
  onError?: (error: unknown, filePath: string) => void
}

type CleanupByAgeOptions = ListKeysOptions & {
  cutoffMs: number
  keyToTimestamp?: (key: string, filePath: string) => number | null
}

type JsonReadOptions<T> = {
  collection?: string
  includeLegacyForDefault?: boolean
  coerce?: (data: unknown) => T | null
  fallback?: T | null
  errorMessage: string
  suffix?: string
}

type JsonWriteOptions = {
  collection?: string
  ensureDir?: boolean
  pretty?: number | boolean
  onError?: (error: unknown) => void
  suffix?: string
}

type JsonListOptions = ListKeysOptions

type JsonLinesAppendOptions = {
  collection?: string
  onError?: (error: unknown) => void
  suffix?: string
}

type JsonLinesReadOptions<T> = {
  collection?: string
  includeLegacyForDefault?: boolean
  coerce?: (data: unknown) => T | null
  onError?: (error: unknown) => void
  onLineError?: (error: unknown, line: string) => void
  suffix?: string
}

type JsonLinesListOptions = ListKeysOptions

export class NamespacedStore {
  readonly feature: string
  readonly rootDir: string
  protected readonly defaultSuffix: string
  private readonly sanitizeKeyFn: (key: string) => string

  constructor(feature: string, options: NamespacedStoreOptions = {}) {
    this.feature = feature
    this.rootDir = path.join(options.baseDir ?? CLAUDE_MEMORY_ROOT, feature)
    this.defaultSuffix = options.suffix ?? ''
    this.sanitizeKeyFn = options.sanitizeKey ?? sanitizeRunId
  }

  getCollectionDir(collection?: string): string {
    return path.join(this.rootDir, getCollectionKey(collection))
  }

  buildPath(key: string, options: BuildPathOptions = {}): string {
    const safeKey = options.sanitize === false ? key : this.sanitizeKeyFn(key)
    const suffix = this.resolveSuffix(options.suffix)
    const fileName = suffix ? `${safeKey}${suffix}` : safeKey
    const base = options.legacy ? this.rootDir : this.getCollectionDir(options.collection)
    return path.join(base, fileName)
  }

  listKeys(options: ListKeysOptions = {}): string[] {
    const suffix = this.resolveSuffix(options.suffix)
    const keys = new Set<string>()
    const dirs = [this.getCollectionDir(options.collection)]
    if (options.includeLegacyForDefault && isDefaultCollection(options.collection)) {
      dirs.push(this.rootDir)
    }

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue
      for (const key of this.listDirKeys(dir, suffix)) {
        keys.add(key)
      }
    }

    return Array.from(keys)
  }

  exists(key: string, options: ExistsOptions = {}): boolean {
    for (const filePath of this.getCandidatePaths(key, options)) {
      if (fs.existsSync(filePath)) return true
    }
    return false
  }

  delete(key: string, options: DeleteOptions = {}): boolean {
    let deleted = false

    for (const filePath of this.getCandidatePaths(key, options)) {
      if (!fs.existsSync(filePath)) continue

      try {
        fs.unlinkSync(filePath)
        deleted = true
      } catch (error) {
        if (options.onError) options.onError(error, filePath)
        if (!options.continueOnError) throw error
      }
    }

    return deleted
  }

  cleanupByAge(options: CleanupByAgeOptions): void {
    const suffix = this.resolveSuffix(options.suffix)
    const dirs = [this.getCollectionDir(options.collection)]
    if (options.includeLegacyForDefault && isDefaultCollection(options.collection)) {
      dirs.push(this.rootDir)
    }

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue
      const files = fs.readdirSync(dir).filter(file => !suffix || file.endsWith(suffix))

      for (const file of files) {
        const key = suffix ? file.slice(0, -suffix.length) : file
        const filePath = path.join(dir, file)
        const keyTimestamp = options.keyToTimestamp ? options.keyToTimestamp(key, filePath) : null
        const reference = keyTimestamp ?? fs.statSync(filePath).mtimeMs
        if (reference < options.cutoffMs) {
          fs.unlinkSync(filePath)
        }
      }
    }
  }

  protected resolveSuffix(suffix?: string): string {
    return suffix ?? this.defaultSuffix
  }

  protected getCandidatePaths(key: string, options: ListKeysOptions = {}): string[] {
    const filePaths = [this.buildPath(key, { collection: options.collection, suffix: options.suffix })]
    if (options.includeLegacyForDefault && isDefaultCollection(options.collection)) {
      filePaths.push(this.buildPath(key, { legacy: true, suffix: options.suffix }))
    }
    return filePaths
  }

  private listDirKeys(dir: string, suffix: string): string[] {
    return fs.readdirSync(dir)
      .filter(file => !suffix || file.endsWith(suffix))
      .map(file => (suffix ? file.slice(0, -suffix.length) : file))
  }
}

export class JsonStore extends NamespacedStore {
  constructor(feature: string, options: NamespacedStoreOptions = {}) {
    super(feature, { suffix: '.json', ...options })
  }

  read<T>(key: string, options: JsonReadOptions<T>): T | null {
    const primaryPath = this.buildPath(key, { collection: options.collection, suffix: options.suffix })
    const primary = readJsonFileSafe(primaryPath, {
      errorMessage: options.errorMessage,
      coerce: options.coerce,
      fallback: null
    })
    if (primary !== null) return primary

    if (options.includeLegacyForDefault && isDefaultCollection(options.collection)) {
      const legacyPath = this.buildPath(key, { legacy: true, suffix: options.suffix })
      return readJsonFileSafe(legacyPath, {
        errorMessage: options.errorMessage,
        coerce: options.coerce,
        fallback: options.fallback
      })
    }

    return options.fallback ?? null
  }

  write(key: string, value: unknown, options: JsonWriteOptions = {}): void {
    const filePath = this.buildPath(key, { collection: options.collection, suffix: options.suffix })
    writeJsonFile(filePath, value, {
      ensureDir: options.ensureDir ?? true,
      pretty: options.pretty ?? 2,
      onError: options.onError
    })
  }

  list(options: JsonListOptions = {}): string[] {
    return this.listKeys(options)
  }
}

export class JsonLinesStore extends NamespacedStore {
  constructor(feature: string, options: NamespacedStoreOptions = {}) {
    super(feature, { suffix: '.jsonl', ...options })
  }

  append(key: string, entries: unknown[], options: JsonLinesAppendOptions = {}): void {
    if (!entries || entries.length === 0) return

    const filePath = this.buildPath(key, { collection: options.collection, suffix: options.suffix })
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      const payload = entries.map(entry => JSON.stringify(entry)).join('\n') + '\n'
      fs.appendFileSync(filePath, payload, 'utf-8')
    } catch (error) {
      if (options.onError) {
        options.onError(error)
        return
      }
      throw error
    }
  }

  readLines<T>(key: string, options: JsonLinesReadOptions<T> = {}): T[] {
    const primaryPath = this.buildPath(key, { collection: options.collection, suffix: options.suffix })
    const primary = this.readLinesAtPath(primaryPath, options)
    if (primary !== null) return primary

    if (options.includeLegacyForDefault && isDefaultCollection(options.collection)) {
      const legacyPath = this.buildPath(key, { legacy: true, suffix: options.suffix })
      const legacy = this.readLinesAtPath(legacyPath, options)
      if (legacy !== null) return legacy
    }

    return []
  }

  list(options: JsonLinesListOptions = {}): string[] {
    return this.listKeys(options)
  }

  private readLinesAtPath<T>(filePath: string, options: JsonLinesReadOptions<T>): T[] | null {
    if (!fs.existsSync(filePath)) return null

    try {
      const content = fs.readFileSync(filePath, 'utf-8')
      if (!content.trim()) return []

      const entries: T[] = []
      for (const line of content.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue

        try {
          const parsed = JSON.parse(trimmed) as unknown
          if (options.coerce) {
            const coerced = options.coerce(parsed)
            if (coerced !== null) entries.push(coerced)
          } else {
            entries.push(parsed as T)
          }
        } catch (error) {
          if (options.onLineError) {
            options.onLineError(error, line)
            continue
          }
          throw error
        }
      }

      return entries
    } catch (error) {
      if (options.onError) {
        options.onError(error)
        return []
      }
      throw error
    }
  }
}
