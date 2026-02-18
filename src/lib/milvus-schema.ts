import { DataType, type MilvusClient } from '@zilliz/milvus2-sdk-node'
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
  'domain',
  'timestamp',
  'success_count',
  'failure_count',
  'retrieval_count',
  'usage_count',
  'last_used',
  'deprecated',
  'generalized',
  'last_generalization_check',
  'last_global_check',
  'last_consolidation_check',
  'last_conflict_check',
  'last_warning_synthesis_check',
  'source_session_id',
  'source_excerpt'
]

export async function createCollection(client: MilvusClient, config: Config): Promise<void> {
  await client.createCollection({
    collection_name: config.milvus.collection,
    fields: [
      { name: 'id', data_type: DataType.VarChar, is_primary_key: true, max_length: 64 },
      { name: 'type', data_type: DataType.VarChar, max_length: 32 },
      { name: 'content', data_type: DataType.VarChar, max_length: CONTENT_MAX_LENGTH },
      { name: 'exact_text', data_type: DataType.VarChar, max_length: EXACT_TEXT_MAX_LENGTH },
      { name: 'project', data_type: DataType.VarChar, max_length: 256 },
      { name: 'scope', data_type: DataType.VarChar, max_length: 16 },
      { name: 'domain', data_type: DataType.VarChar, max_length: 64 },
      { name: 'timestamp', data_type: DataType.Int64 },
      { name: 'success_count', data_type: DataType.Int64 },
      { name: 'failure_count', data_type: DataType.Int64 },
      { name: 'retrieval_count', data_type: DataType.Int64 },
      { name: 'usage_count', data_type: DataType.Int64 },
      { name: 'last_used', data_type: DataType.Int64 },
      { name: 'deprecated', data_type: DataType.Bool },
      { name: 'generalized', data_type: DataType.Bool },
      { name: 'last_generalization_check', data_type: DataType.Int64 },
      { name: 'last_global_check', data_type: DataType.Int64 },
      { name: 'last_consolidation_check', data_type: DataType.Int64 },
      { name: 'last_conflict_check', data_type: DataType.Int64 },
      { name: 'last_warning_synthesis_check', data_type: DataType.Int64 },
      { name: 'source_session_id', data_type: DataType.VarChar, max_length: SOURCE_SESSION_ID_MAX_LENGTH, nullable: true },
      { name: 'source_excerpt', data_type: DataType.VarChar, max_length: SOURCE_EXCERPT_MAX_LENGTH, nullable: true },
      { name: 'embedding', data_type: DataType.FloatVector, dim: EMBEDDING_DIM }
    ]
  })

  await client.createIndex({
    collection_name: config.milvus.collection,
    field_name: 'embedding',
    index_type: 'IVF_FLAT',
    metric_type: 'COSINE',
    params: { nlist: 128 }
  })

  console.error('[claude-memory] Created collection:', config.milvus.collection)
}

const MIGRATION_FIELDS = [
  { name: 'retrieval_count', data_type: DataType.Int64, nullable: true },
  { name: 'usage_count', data_type: DataType.Int64, nullable: true },
  { name: 'scope', data_type: DataType.VarChar, max_length: 16, nullable: true },
  { name: 'generalized', data_type: DataType.Bool, nullable: true },
  { name: 'last_generalization_check', data_type: DataType.Int64, nullable: true },
  { name: 'last_global_check', data_type: DataType.Int64, nullable: true },
  { name: 'last_consolidation_check', data_type: DataType.Int64, nullable: true },
  { name: 'last_conflict_check', data_type: DataType.Int64, nullable: true },
  { name: 'last_warning_synthesis_check', data_type: DataType.Int64, nullable: true },
  { name: 'source_session_id', data_type: DataType.VarChar, max_length: SOURCE_SESSION_ID_MAX_LENGTH, nullable: true },
  { name: 'source_excerpt', data_type: DataType.VarChar, max_length: SOURCE_EXCERPT_MAX_LENGTH, nullable: true }
]

export async function ensureSchemaFields(client: MilvusClient, config: Config): Promise<boolean> {
  try {
    const description = await client.describeCollection({
      collection_name: config.milvus.collection
    })

    const fields = description.schema?.fields ?? []
    const fieldNames = new Set(fields.map(field => field.name))
    const missing = MIGRATION_FIELDS.filter(field => !fieldNames.has(field.name))

    if (missing.length === 0) return false

    const result = await client.addCollectionFields({
      collection_name: config.milvus.collection,
      fields: missing
    })

    if (result.error_code !== 'Success') {
      console.error(`[claude-memory] Failed to add fields: ${result.reason}`)
      return false
    }

    console.error(`[claude-memory] Added fields to ${config.milvus.collection}: ${missing.map(field => field.name).join(', ')}`)
    return true
  } catch (error) {
    console.error('[claude-memory] Failed to ensure schema fields:', error)
    return false
  }
}
