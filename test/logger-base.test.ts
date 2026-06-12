import { describe, expect, it, vi } from 'vitest'
import { BaseLogger, type LogLineFormatter } from '../src/lib/logger-base.js'

class TestLogger extends BaseLogger {
  constructor(formatter: LogLineFormatter) {
    super('test', 'debug', formatter)
  }
}

describe('BaseLogger', () => {
  it('routes debug and info messages to stderr', () => {
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => {})
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const logger = new TestLogger((level, context, message) => `${level}:${context}:${message}`)

    try {
      logger.debug('debug line')
      logger.info('info line')
      logger.warn('warn line')
      logger.error('error line')

      expect(stdout).not.toHaveBeenCalled()
      expect(stderr).toHaveBeenCalledWith('debug:test:debug line')
      expect(stderr).toHaveBeenCalledWith('info:test:info line')
      expect(warn).toHaveBeenCalledWith('warn:test:warn line')
      expect(stderr).toHaveBeenCalledWith('error:test:error line')
    } finally {
      stdout.mockRestore()
      stderr.mockRestore()
      warn.mockRestore()
    }
  })
})
