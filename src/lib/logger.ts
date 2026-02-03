import { BaseLogger, LOG_LEVELS, formatTimestamp, type LogLevel } from './logger-base.js'

function getMinLevel(): LogLevel {
  const env = process.env.CLAUDE_MEMORY_LOG_LEVEL?.toLowerCase()
  if (env && env in LOG_LEVELS) return env as LogLevel
  return 'info'
}

function formatLine(level: LogLevel, context: string, message: string): string {
  const timestamp = formatTimestamp()
  const prefix = `[${timestamp}] [${context}]`
  const levelTag = level.toUpperCase()

  return `${prefix} ${levelTag}: ${message}`
}

class Logger extends BaseLogger {
  constructor(context: string = '') {
    super(context, getMinLevel(), formatLine)
  }
}

export function createLogger(context: string): Logger {
  return new Logger(context)
}
