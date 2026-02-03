import { BaseLogger, LOG_LEVELS, formatTimestamp, type LogLevel } from '../../../src/lib/logger-base.js'

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

function formatLine(level: LogLevel, context: string, message: string): string {
  const color = LEVEL_COLORS[level]
  const levelTag = level.toUpperCase().padEnd(5)
  const timestamp = formatTimestamp()
  const contextTag = context ? `[${context}]` : ''

  return `${color}${timestamp} ${levelTag}${RESET} ${contextTag} ${message}`
}

class Logger extends BaseLogger {
  constructor(context: string = '') {
    super(context, getMinLevel(), formatLine)
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
