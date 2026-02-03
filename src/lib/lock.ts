import fs from 'fs'
import path from 'path'

const DEFAULT_RETRY_DELAY_MS = 25
const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4))

export type FileLockStaleStrategy = 'pid' | 'mtime'

export type FileLockWaitOptions = {
  maxWaitMs: number
  retryDelayMs?: number
}

export type FileLockWriteOptions = {
  data?: (now: number) => string
  ignoreErrors?: boolean
}

export type FileLockOptions = {
  staleAfterMs: number
  staleStrategy: FileLockStaleStrategy
  wait?: FileLockWaitOptions
  proceedOnTimeout?: boolean
  proceedOnError?: boolean
  ensureDir?: boolean
  write?: FileLockWriteOptions
  onTimeout?: (lockPath: string) => void
  onStaleRemoved?: (lockPath: string) => void
  onStaleRemoveError?: (error: unknown, lockPath: string) => void
  onLockError?: (error: unknown, lockPath: string) => void
}

export type FileLockHandle = {
  locked: boolean
  release: () => void
}

function sleep(ms: number): void {
  Atomics.wait(SLEEP_BUFFER, 0, 0, ms)
}

function readLockPid(lockPath: string): number | null {
  try {
    const content = fs.readFileSync(lockPath, 'utf-8').trim()
    if (!content) return null
    const pid = Number.parseInt(content, 10)
    return Number.isNaN(pid) ? null : pid
  } catch {
    return null
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return false
    return true
  }
}

function isStaleLock(lockPath: string, now: number, options: FileLockOptions): boolean {
  try {
    if (options.staleStrategy === 'pid') {
      const pid = readLockPid(lockPath)
      if (pid !== null) {
        return !isProcessAlive(pid)
      }
    }

    const stats = fs.statSync(lockPath)
    const ageMs = now - stats.mtimeMs
    return ageMs >= options.staleAfterMs
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return false
    return false
  }
}

export function acquireFileLock(lockPath: string, options: FileLockOptions): FileLockHandle | null {
  if (options.ensureDir) {
    try {
      fs.mkdirSync(path.dirname(lockPath), { recursive: true })
    } catch (error) {
      if (options.onLockError) options.onLockError(error, lockPath)
      if (options.proceedOnError) {
        return { locked: false, release: () => {} }
      }
      throw error
    }
  }

  const waitOptions = options.wait
  const retryDelayMs = waitOptions?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  const start = Date.now()
  let fd: number | null = null

  while (fd === null) {
    try {
      fd = fs.openSync(lockPath, 'wx')
      const writeData = options.write?.data
      if (writeData) {
        const payload = writeData(Date.now())
        if (payload) {
          try {
            fs.writeFileSync(fd, payload)
          } catch (error) {
            if (!options.write?.ignoreErrors) {
              throw error
            }
          }
        }
      }
    } catch (error) {
      if (fd !== null) {
        try {
          fs.closeSync(fd)
        } catch {
          // ignore close errors
        }
        try {
          fs.unlinkSync(lockPath)
        } catch {
          // ignore unlink errors
        }
        fd = null
      }

      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') {
        if (options.onLockError) options.onLockError(error, lockPath)
        if (options.proceedOnError) {
          return { locked: false, release: () => {} }
        }
        throw error
      }

      const now = Date.now()
      if (isStaleLock(lockPath, now, options)) {
        let removed = false
        try {
          fs.unlinkSync(lockPath)
          removed = true
          if (options.onStaleRemoved) options.onStaleRemoved(lockPath)
        } catch (unlinkError) {
          if (options.onStaleRemoveError) options.onStaleRemoveError(unlinkError, lockPath)
        }
        if (removed) continue
      }

      if (!waitOptions) return null
      if (now - start >= waitOptions.maxWaitMs) {
        if (options.onTimeout) options.onTimeout(lockPath)
        if (options.proceedOnTimeout) {
          return { locked: false, release: () => {} }
        }
        return null
      }

      sleep(retryDelayMs)
    }
  }

  const release = (): void => {
    if (fd === null) return
    try {
      fs.closeSync(fd)
    } catch {
      // Ignore close errors
    }
    try {
      fs.unlinkSync(lockPath)
    } catch {
      // Ignore unlink errors
    }
  }

  return { locked: true, release }
}
