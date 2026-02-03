import fs from 'fs'
import path from 'path'

type ReadJsonFileOptions<T> = {
  fallback?: T | null
  onError?: (error: unknown) => void
  coerce?: (data: unknown) => T | null
}

type ReadJsonFileSafeOptions<T> = {
  fallback?: T | null
  coerce?: (data: unknown) => T | null
  errorMessage: string
}

type WriteJsonFileOptions = {
  ensureDir?: boolean
  pretty?: number | boolean
  onError?: (error: unknown) => void
}

export function readJsonFile<T>(filePath: string, options: ReadJsonFileOptions<T> = {}): T | null {
  const fallback = options.fallback ?? null
  if (!fs.existsSync(filePath)) return fallback

  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (options.coerce) {
      const coerced = options.coerce(parsed)
      return coerced === null ? fallback : coerced
    }
    return parsed as T
  } catch (error) {
    if (options.onError) {
      options.onError(error)
      return fallback
    }
    throw error
  }
}

function isEnoentError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

export function readJsonFileSafe<T>(filePath: string, options: ReadJsonFileSafeOptions<T>): T | null {
  return readJsonFile(filePath, {
    fallback: options.fallback,
    coerce: options.coerce,
    onError: error => {
      if (isEnoentError(error)) return
      console.error(options.errorMessage, error)
    }
  })
}

export function writeJsonFile(filePath: string, value: unknown, options: WriteJsonFileOptions = {}): void {
  const spacing = options.pretty === false
    ? undefined
    : typeof options.pretty === 'number'
      ? options.pretty
      : 2

  try {
    if (options.ensureDir) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
    }
    fs.writeFileSync(filePath, JSON.stringify(value, null, spacing))
  } catch (error) {
    if (options.onError) {
      options.onError(error)
      return
    }
    throw error
  }
}

export function safeJsonStringify(value: unknown): string | undefined {
  if (value === undefined) return undefined
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function safeJsonStringifyCompact(value: unknown): string | undefined {
  try {
    const serialized = JSON.stringify(value)
    return serialized && serialized !== '{}' ? serialized : undefined
  } catch {
    return undefined
  }
}

export function safeStringify(value: unknown): string {
  try {
    const serialized = JSON.stringify(value)
    return typeof serialized === 'string' ? serialized : String(value)
  } catch {
    return String(value)
  }
}
