import {
  Schema,
  Field,
  Utf8,
  Int64,
  Bool,
  Float32,
  FixedSizeList,
} from 'apache-arrow'
import { EMBEDDING_DIM, type Config } from './types.js'

export const CONTENT_MAX_LENGTH = 16384
export const EXACT_TEXT_MAX_LENGTH = 4096
export const SOURCE_SESSION_ID_MAX_LENGTH = 128
export const SOURCE_EXCERPT_MAX_LENGTH = 4000

export const OUTPUT_FIELDS = [
  'id',
  'type',
  'content',
  'exact_text',
  'project',
  'scope',
  'timestamp',
  'success_count',
  'failure_count',
  'retrieval_count',
  'usage_count',
  'last_used',
  'deprecated',
  'deprecated_at',
  'deprecated_reason',
  'superseding_record_id',
  'generalized',
  'last_generalization_check',
  'last_global_check',
  'last_consolidation_check',
  'last_conflict_check',
  'last_warning_synthesis_check',
  'source_session_id',
  'source_excerpt'
]

export function buildTableSchema(): Schema {
  return new Schema([
    new Field('id', new Utf8(), false),
    new Field('type', new Utf8(), false),
    new Field('content', new Utf8(), false),
    new Field('exact_text', new Utf8(), false),
    new Field('project', new Utf8(), false),
    new Field('scope', new Utf8(), false),
    new Field('timestamp', new Int64(), false),
    new Field('success_count', new Int64(), false),
    new Field('failure_count', new Int64(), false),
    new Field('retrieval_count', new Int64(), false),
    new Field('usage_count', new Int64(), false),
    new Field('last_used', new Int64(), false),
    new Field('deprecated', new Bool(), false),
    new Field('deprecated_at', new Int64(), true),
    new Field('deprecated_reason', new Utf8(), true),
    new Field('superseding_record_id', new Utf8(), true),
    new Field('generalized', new Bool(), false),
    new Field('last_generalization_check', new Int64(), false),
    new Field('last_global_check', new Int64(), false),
    new Field('last_consolidation_check', new Int64(), false),
    new Field('last_conflict_check', new Int64(), false),
    new Field('last_warning_synthesis_check', new Int64(), false),
    new Field('source_session_id', new Utf8(), true),
    new Field('source_excerpt', new Utf8(), true),
    new Field('embedding', new FixedSizeList(EMBEDDING_DIM, new Field('item', new Float32(), true)), false),
  ])
}

export const MIGRATION_COLUMNS: Array<{ name: string; valueSql: string }> = [
  { name: 'retrieval_count', valueSql: '0' },
  { name: 'usage_count', valueSql: '0' },
  { name: 'scope', valueSql: "'project'" },
  { name: 'generalized', valueSql: 'false' },
  { name: 'last_generalization_check', valueSql: '0' },
  { name: 'last_global_check', valueSql: '0' },
  { name: 'last_consolidation_check', valueSql: '0' },
  { name: 'last_conflict_check', valueSql: '0' },
  { name: 'last_warning_synthesis_check', valueSql: '0' },
  { name: 'source_session_id', valueSql: 'NULL' },
  { name: 'source_excerpt', valueSql: 'NULL' },
  { name: 'deprecated_at', valueSql: 'CAST(NULL AS BIGINT)' },
  { name: 'deprecated_reason', valueSql: 'CAST(NULL AS STRING)' },
  { name: 'superseding_record_id', valueSql: 'CAST(NULL AS STRING)' }
]

export async function ensureSchemaFields(
  table: {
    schema: () => Promise<{ fields: Array<{ name: string }> }>
    addColumns: (cols: Array<{ name: string; valueSql: string }>) => Promise<unknown>
    dropColumns: (names: string[]) => Promise<unknown>
  },
  config: Config
): Promise<boolean> {
  void config

  try {
    const fieldNames = await readFieldNames(table)

    const missing = MIGRATION_COLUMNS.filter(col => !fieldNames.has(col.name))
    let changed = false

    if (missing.length > 0) {
      try {
        await table.addColumns(missing)
        changed = true
        console.error(`[claude-memory] Added columns: ${missing.map(col => col.name).join(', ')}`)
      } catch (error) {
        const refreshedFieldNames = await readFieldNames(table)
        const stillMissing = missing.filter(col => !refreshedFieldNames.has(col.name))
        if (stillMissing.length === 0 && isConcurrentColumnAddError(error)) {
          console.error('[claude-memory] Columns already added by another process.')
        } else if (stillMissing.length < missing.length && isConcurrentColumnAddError(error)) {
          try {
            await table.addColumns(stillMissing)
            changed = true
            console.error(`[claude-memory] Added columns after concurrent migration: ${stillMissing.map(col => col.name).join(', ')}`)
          } catch (retryError) {
            const retryFieldNames = await readFieldNames(table)
            const retryMissing = stillMissing.filter(col => !retryFieldNames.has(col.name))
            if (retryMissing.length === 0 && isConcurrentColumnAddError(retryError)) {
              console.error('[claude-memory] Columns already added by another process.')
            } else {
              throw retryError
            }
          }
        } else {
          throw error
        }
      }
    }

    // Drop deprecated legacy column if present.
    if (fieldNames.has('domain')) {
      try {
        await table.dropColumns(['domain'])
        changed = true
        console.error('[claude-memory] Dropped deprecated column: domain')
      } catch {
        // Best-effort; dropping columns may be unsupported in older datasets.
      }
    }

    return changed
  } catch (error) {
    console.error('[claude-memory] Failed to ensure LanceDB schema fields:', error)
    throw error
  }
}

async function readFieldNames(table: { schema: () => Promise<{ fields: Array<{ name: string }> }> }): Promise<Set<string>> {
  const schema = await table.schema()
  return new Set(schema.fields.map((f: { name: string }) => f.name))
}

function isConcurrentColumnAddError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /already exists|column.*exists|field.*exists|duplicate column/i.test(message)
}
