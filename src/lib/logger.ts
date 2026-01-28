type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
}

function getMinLevel(): LogLevel {
  const env = process.env.CLAUDE_MEMORY_LOG_LEVEL?.toLowerCase()
  if (env && env in LOG_LEVELS) return env as LogLevel
  return 'info'
}

function formatTimestamp(): string {
  return new Date().toISOString().slice(11, 23)
}

class Logger {
  private context: string
  private minLevel: number

  constructor(context: string = '') {
    this.context = context
    this.minLevel = LOG_LEVELS[getMinLevel()]
  }

  private log(level: LogLevel, message: string, meta?: unknown): void {
    if (LOG_LEVELS[level] < this.minLevel) return

    const timestamp = formatTimestamp()
    const prefix = `[${timestamp}] [${this.context}]`
    const levelTag = level.toUpperCase()

    let line = `${prefix} ${levelTag}: ${message}`
    if (meta !== undefined) {
      if (meta instanceof Error) {
        line += `\n${meta.stack || meta.message}`
      } else if (typeof meta === 'object') {
        line += ` ${JSON.stringify(meta)}`
      } else {
        line += ` ${meta}`
      }
    }

    if (level === 'error') {
      console.error(line)
    } else if (level === 'warn') {
      console.warn(line)
    } else {
      console.log(line)
    }
  }

  debug(message: string, meta?: unknown): void {
    this.log('debug', message, meta)
  }

  info(message: string, meta?: unknown): void {
    this.log('info', message, meta)
  }

  warn(message: string, meta?: unknown): void {
    this.log('warn', message, meta)
  }

  error(message: string, meta?: unknown): void {
    this.log('error', message, meta)
  }
}

export function createLogger(context: string): Logger {
  return new Logger(context)
}
