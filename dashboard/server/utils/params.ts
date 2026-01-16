export function parseNonNegativeInt(value: unknown, fallback: number): number {
  const raw = Array.isArray(value) ? value[0] : value
  if (raw === undefined || raw === null) return fallback
  const parsed = typeof raw === 'string' && raw.trim() === '' ? Number.NaN : Number(raw)
  if (!Number.isInteger(parsed) || parsed < 0) return fallback
  return parsed
}

export function parseOptionalBoolean(value: unknown, fallback = false): boolean {
  const raw = Array.isArray(value) ? value[0] : value
  if (raw === undefined || raw === null) return fallback
  if (typeof raw === 'boolean') return raw
  if (typeof raw === 'number') return raw !== 0
  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase()
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true
    if (['false', '0', 'no', 'off', ''].includes(normalized)) return false
  }
  return fallback
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
