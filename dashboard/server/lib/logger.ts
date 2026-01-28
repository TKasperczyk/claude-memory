type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
}

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: '\x1b[90m', // gray
  info: '\x1b[36m',  // cyan
  warn: '\x1b[33m',  // yellow
  error: '\x1b[31m'  // red
}

const RESET = '\x1b[0m'

function getMinLevel(): LogLevel {
  const env = process.env.LOG_LEVEL?.toLowerCase()
  if (env && env in LOG_LEVELS) return env as LogLevel
  return process.env.NODE_ENV === 'production' ? 'info' : 'debug'
}

function formatTimestamp(): string {
  return new Date().toISOString().slice(11, 23) // HH:mm:ss.SSS
}

function formatMessage(level: LogLevel, context: string, message: string, meta?: unknown): string {
  const color = LEVEL_COLORS[level]
  const levelTag = level.toUpperCase().padEnd(5)
  const timestamp = formatTimestamp()
  const contextTag = context ? `[${context}]` : ''

  let line = `${color}${timestamp} ${levelTag}${RESET} ${contextTag} ${message}`

  if (meta !== undefined) {
    if (meta instanceof Error) {
      line += `\n${meta.stack || meta.message}`
    } else if (typeof meta === 'object') {
      line += ` ${JSON.stringify(meta)}`
    } else {
      line += ` ${meta}`
    }
  }

  return line
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
    const formatted = formatMessage(level, this.context, message, meta)

    if (level === 'error') {
      console.error(formatted)
    } else if (level === 'warn') {
      console.warn(formatted)
    } else {
      console.log(formatted)
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

  child(context: string): Logger {
    const childContext = this.context ? `${this.context}:${context}` : context
    return new Logger(childContext)
  }
}

export const logger = new Logger()

export function createLogger(context: string): Logger {
  return new Logger(context)
}
