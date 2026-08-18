import { describe, expect, it } from 'vitest'
import { MIGRATION_COLUMNS } from '../src/lib/lancedb-schema.js'

describe('LanceDB migration expressions', () => {
  it('creates nullable source metadata columns with concrete string types', () => {
    const columns = new Map(MIGRATION_COLUMNS.map(column => [column.name, column.valueSql]))

    expect(columns.get('source_session_id')).toBe('CAST(NULL AS STRING)')
    expect(columns.get('source_excerpt')).toBe('CAST(NULL AS STRING)')
  })
})
