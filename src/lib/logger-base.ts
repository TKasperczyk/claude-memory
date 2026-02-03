type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
}

type LogLineFormatter = (level: LogLevel, context: string, message: string) => string

function formatTimestamp(): string {
  return new Date().toISOString().slice(11, 23)
}

function appendMeta(line: string, meta?: unknown): string {
  if (meta === undefined) return line

  if (meta instanceof Error) {
    return `${line}\n${meta.stack || meta.message}`
  }

  if (typeof meta === 'object') {
    return `${line} ${JSON.stringify(meta)}`
  }

  return `${line} ${meta}`
}

class BaseLogger {
  protected context: string
  private minLevel: number
  private formatLine: LogLineFormatter

  constructor(context: string, minLevel: LogLevel, formatLine: LogLineFormatter) {
    this.context = context
    this.minLevel = LOG_LEVELS[minLevel]
    this.formatLine = formatLine
  }

  private log(level: LogLevel, message: string, meta?: unknown): void {
    if (LOG_LEVELS[level] < this.minLevel) return

    let line = this.formatLine(level, this.context, message)
    line = appendMeta(line, meta)

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

export type { LogLevel, LogLineFormatter }
export { BaseLogger, LOG_LEVELS, formatTimestamp }
