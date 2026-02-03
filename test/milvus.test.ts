import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import { MilvusClient } from '@zilliz/milvus2-sdk-node'
import { DEFAULT_CONFIG, type MemoryRecord } from '../src/lib/types.js'
import * as milvusClient from '../src/lib/milvus-client.js'
import * as milvusCrud from '../src/lib/milvus-crud.js'
import * as milvusSchema from '../src/lib/milvus-schema.js'
import * as milvusRecords from '../src/lib/milvus-records.js'
import * as milvusSearch from '../src/lib/milvus-search.js'
import { embed } from '../src/lib/embed.js'

vi.mock('@zilliz/milvus2-sdk-node', () => ({
  MilvusClient: vi.fn(),
  DataType: {
    VarChar: 'VarChar',
    Int64: 'Int64',
    Bool: 'Bool',
    FloatVector: 'FloatVector'
  }
}))

vi.mock('../src/lib/embed.js', () => ({
  embed: vi.fn(),
  ensureEmbeddingDim: vi.fn()
}))

const mockedEmbed = vi.mocked(embed)
const mockedMilvusClient = vi.mocked(MilvusClient)

const makeMockClient = () => ({
  hasCollection: vi.fn().mockResolvedValue({ value: true }),
  releaseCollection: vi.fn().mockResolvedValue(undefined),
  loadCollection: vi.fn().mockResolvedValue(undefined),
  closeConnection: vi.fn().mockResolvedValue(undefined),
  insert: vi.fn().mockResolvedValue(undefined),
  upsert: vi.fn().mockResolvedValue(undefined),
  delete: vi.fn().mockResolvedValue(undefined),
  dropCollection: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue({ data: [] }),
  queryIterator: vi.fn(),
  search: vi.fn(),
  count: vi.fn(),
  flush: vi.fn().mockResolvedValue(undefined),
  describeCollection: vi.fn().mockResolvedValue({ schema: { fields: [] } }),
  addCollectionFields: vi.fn().mockResolvedValue({ error_code: 'Success' }),
  createCollection: vi.fn().mockResolvedValue(undefined),
  createIndex: vi.fn().mockResolvedValue(undefined)
})

const createCommandRecord = (overrides: Partial<MemoryRecord> = {}): MemoryRecord => ({
  id: 'cmd-1',
  type: 'command',
  command: 'npm test',
  exitCode: 0,
  outcome: 'success',
  context: {
    project: 'project-x',
    cwd: '/repo',
    intent: 'run tests'
  },
  timestamp: 1700000000000,
  ...overrides
})

const createErrorRecord = (overrides: Partial<MemoryRecord> = {}): MemoryRecord => ({
  id: 'err-1',
  type: 'error',
  errorText: 'TypeError: boom',
  errorType: 'runtime',
  resolution: 'fix it',
  context: {
    project: 'project-x',
    file: 'src/index.ts',
    tool: 'node'
  },
  timestamp: 1700000000000,
  ...overrides
})

const createDiscoveryRecord = (overrides: Partial<MemoryRecord> = {}): MemoryRecord => ({
  id: 'disc-1',
  type: 'discovery',
  what: 'Uses ESM',
  where: 'package.json',
  evidence: 'Found "type": "module"',
  confidence: 'verified',
  timestamp: 1700000000000,
  ...overrides
})

const createProcedureRecord = (overrides: Partial<MemoryRecord> = {}): MemoryRecord => ({
  id: 'proc-1',
  type: 'procedure',
  name: 'Deploy',
  steps: ['build', 'deploy'],
  context: {
    project: 'project-x',
    domain: 'deploy'
  },
  timestamp: 1700000000000,
  ...overrides
})

const createWarningRecord = (overrides: Partial<MemoryRecord> = {}): MemoryRecord => ({
  id: 'warn-1',
  type: 'warning',
  avoid: 'rm -rf /',
  useInstead: 'rm -i',
  reason: 'safer',
  severity: 'critical',
  timestamp: 1700000000000,
  ...overrides
})

beforeEach(() => {
  vi.clearAllMocks()
  mockedEmbed.mockResolvedValue([0.1, 0.2])
})

afterEach(async () => {
  vi.useRealTimers()
  await milvusClient.closeMilvus()
  vi.restoreAllMocks()
})

describe('milvus-client', () => {
  it('initMilvus creates collection when missing', async () => {
    const client = makeMockClient()
    client.hasCollection.mockResolvedValue({ value: false })
    mockedMilvusClient.mockImplementation(function () {
      return client as any
    })

    const createSpy = vi.spyOn(milvusSchema, 'createCollection').mockResolvedValue(undefined)
    const ensureSpy = vi.spyOn(milvusSchema, 'ensureSchemaFields').mockResolvedValue(undefined)

    await milvusClient.initMilvus(DEFAULT_CONFIG)

    expect(createSpy).toHaveBeenCalledWith(client, DEFAULT_CONFIG)
    expect(ensureSpy).not.toHaveBeenCalled()
    expect(client.releaseCollection).toHaveBeenCalled()
    expect(client.loadCollection).toHaveBeenCalled()
  })

  it('initMilvus ensures fields when collection exists', async () => {
    const client = makeMockClient()
    client.hasCollection.mockResolvedValue({ value: true })
    mockedMilvusClient.mockImplementation(function () {
      return client as any
    })

    const createSpy = vi.spyOn(milvusSchema, 'createCollection').mockResolvedValue(undefined)
    const ensureSpy = vi.spyOn(milvusSchema, 'ensureSchemaFields').mockResolvedValue(undefined)

    await milvusClient.initMilvus(DEFAULT_CONFIG)

    expect(createSpy).not.toHaveBeenCalled()
    expect(ensureSpy).toHaveBeenCalledWith(client, DEFAULT_CONFIG)
    expect(client.releaseCollection).toHaveBeenCalled()
    expect(client.loadCollection).toHaveBeenCalled()
  })

  it('ensureClient reuses client for same config and reinitializes on change', async () => {
    const clientA = makeMockClient()
    const clientB = makeMockClient()
    clientA.hasCollection.mockResolvedValue({ value: false })
    clientB.hasCollection.mockResolvedValue({ value: false })
    mockedMilvusClient
      .mockImplementationOnce(function () {
        return clientA as any
      })
      .mockImplementationOnce(function () {
        return clientB as any
      })

    vi.spyOn(milvusSchema, 'createCollection').mockResolvedValue(undefined)

    const first = await milvusClient.ensureClient(DEFAULT_CONFIG)
    const second = await milvusClient.ensureClient(DEFAULT_CONFIG)
    const otherConfig = {
      ...DEFAULT_CONFIG,
      milvus: {
        ...DEFAULT_CONFIG.milvus,
        collection: 'other_collection'
      }
    }
    const third = await milvusClient.ensureClient(otherConfig)

    expect(first).toBe(clientA)
    expect(second).toBe(clientA)
    expect(third).toBe(clientB)
    expect(mockedMilvusClient).toHaveBeenCalledTimes(2)
  })
})

describe('milvus-schema', () => {
  it('ensureSchemaFields adds missing fields', async () => {
    const client = makeMockClient()
    client.describeCollection.mockResolvedValue({
      schema: {
        fields: [{ name: 'id' }, { name: 'type' }]
      }
    })

    await milvusSchema.ensureSchemaFields(client as any, DEFAULT_CONFIG)

    const expectedFields = [
      'retrieval_count',
      'usage_count',
      'scope',
      'generalized',
      'last_generalization_check',
      'last_global_check',
      'last_consolidation_check',
      'last_conflict_check',
      'last_warning_synthesis_check',
      'source_session_id',
      'source_excerpt'
    ]

    expect(client.addCollectionFields).toHaveBeenCalledTimes(1)
    const call = client.addCollectionFields.mock.calls[0]?.[0]
    expect(call.collection_name).toBe(DEFAULT_CONFIG.milvus.collection)
    const fieldNames = call.fields.map((field: { name: string }) => field.name)
    expect(fieldNames).toHaveLength(expectedFields.length)
    expect(fieldNames).toEqual(expect.arrayContaining(expectedFields))
  })

  it('ensureSchemaFields skips when fields exist', async () => {
    const client = makeMockClient()
    const existingFields = [
      'retrieval_count',
      'usage_count',
      'scope',
      'generalized',
      'last_generalization_check',
      'last_global_check',
      'last_consolidation_check',
      'last_conflict_check',
      'last_warning_synthesis_check',
      'source_session_id',
      'source_excerpt'
    ]
    client.describeCollection.mockResolvedValue({
      schema: {
        fields: existingFields.map(name => ({ name }))
      }
    })

    await milvusSchema.ensureSchemaFields(client as any, DEFAULT_CONFIG)

    expect(client.addCollectionFields).not.toHaveBeenCalled()
  })
})

describe('milvus-crud', () => {
  it('updateRecord returns false when missing', async () => {
    const client = makeMockClient()
    client.query.mockResolvedValue({ data: [] })
    vi.spyOn(milvusClient, 'ensureClient').mockResolvedValue(client as any)

    const result = await milvusCrud.updateRecord('missing', { successCount: 2 }, DEFAULT_CONFIG, { flush: 'never' })

    expect(result).toBe(false)
    expect(client.upsert).not.toHaveBeenCalled()
  })

  it('updateRecord preserves embedding when no re-embed is needed', async () => {
    const client = makeMockClient()
    const existing = createCommandRecord({
      id: 'record-1',
      timestamp: 1000,
      successCount: 1,
      embedding: [0.5, 0.6]
    })

    client.query.mockResolvedValue({ data: [{}] })
    vi.spyOn(milvusClient, 'ensureClient').mockResolvedValue(client as any)
    vi.spyOn(milvusRecords, 'parseRecordFromRow').mockReturnValue(existing)
    const buildSpy = vi.spyOn(milvusRecords, 'buildMilvusRow').mockImplementation(async record => ({
      id: record.id,
      embedding: record.embedding
    }))

    const result = await milvusCrud.updateRecord(
      existing.id,
      { successCount: 2 },
      DEFAULT_CONFIG,
      { flush: 'never' }
    )

    expect(result).toBe(true)
    expect(client.upsert).toHaveBeenCalled()
    const updated = buildSpy.mock.calls[0]?.[0] as MemoryRecord
    expect(updated.embedding).toEqual(existing.embedding)
    expect(updated.successCount).toBe(2)
    expect(updated.timestamp).toBe(existing.timestamp)
  })

  it('updateRecord refreshes embedding and timestamp when content changes', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2024-01-01T00:00:00Z'))

    const client = makeMockClient()
    const existing = createCommandRecord({
      id: 'record-2',
      timestamp: 1000,
      resolution: 'use yarn',
      embedding: [0.2, 0.3]
    })

    client.query.mockResolvedValue({ data: [{}] })
    vi.spyOn(milvusClient, 'ensureClient').mockResolvedValue(client as any)
    vi.spyOn(milvusRecords, 'parseRecordFromRow').mockReturnValue(existing)
    const buildSpy = vi.spyOn(milvusRecords, 'buildMilvusRow').mockImplementation(async record => ({
      id: record.id,
      embedding: record.embedding
    }))

    const result = await milvusCrud.updateRecord(
      existing.id,
      { resolution: 'use pnpm' },
      DEFAULT_CONFIG,
      { flush: 'never' }
    )

    expect(result).toBe(true)
    const updated = buildSpy.mock.calls[0]?.[0] as MemoryRecord
    expect(updated.embedding).toBeUndefined()
    expect(updated.timestamp).toBe(new Date('2024-01-01T00:00:00Z').getTime())
  })

  it('incrementRecordCounters applies deltas and updates lastUsed', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2024-02-01T00:00:00Z'))

    const client = makeMockClient()
    const existing = createCommandRecord({
      id: 'record-3',
      retrievalCount: 1,
      usageCount: 2,
      embedding: [0.9, 0.8]
    })

    client.query.mockResolvedValue({ data: [{}] })
    vi.spyOn(milvusClient, 'ensureClient').mockResolvedValue(client as any)
    vi.spyOn(milvusRecords, 'parseRecordFromRow').mockReturnValue(existing)
    const buildSpy = vi.spyOn(milvusRecords, 'buildMilvusRow').mockImplementation(async record => ({
      id: record.id,
      embedding: record.embedding
    }))

    const result = await milvusCrud.incrementRecordCounters(
      existing.id,
      { retrievalCount: 2, usageCount: 1 },
      DEFAULT_CONFIG
    )

    expect(result).toBe(true)
    expect(client.upsert).toHaveBeenCalled()
    const updated = buildSpy.mock.calls[0]?.[0] as MemoryRecord
    expect(updated.retrievalCount).toBe(3)
    expect(updated.usageCount).toBe(3)
    expect(updated.lastUsed).toBe(new Date('2024-02-01T00:00:00Z').getTime())
    expect(updated.embedding).toEqual(existing.embedding)
  })

  it('deleteRecord escapes filters and flushes', async () => {
    vi.useFakeTimers()

    const client = makeMockClient()
    vi.spyOn(milvusClient, 'ensureClient').mockResolvedValue(client as any)

    const id = 'id "with" \\\\ slash'
    const promise = milvusCrud.deleteRecord(id, DEFAULT_CONFIG)

    await vi.runAllTimersAsync()
    await promise

    expect(client.delete).toHaveBeenCalledWith({
      collection_name: DEFAULT_CONFIG.milvus.collection,
      filter: 'id == "id \\"with\\" \\\\\\\\ slash"'
    })
    expect(client.flush).toHaveBeenCalledWith({
      collection_names: [DEFAULT_CONFIG.milvus.collection]
    })
  })

  it('resetCollection drops and recreates collection', async () => {
    const client = makeMockClient()
    client.hasCollection.mockResolvedValue({ value: true })
    vi.spyOn(milvusClient, 'ensureClient').mockResolvedValue(client as any)
    vi.spyOn(milvusSchema, 'createCollection').mockResolvedValue(undefined)

    const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(true)
    const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation(() => undefined)
    const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined)

    await milvusCrud.resetCollection(DEFAULT_CONFIG)

    expect(client.dropCollection).toHaveBeenCalledWith({
      collection_name: DEFAULT_CONFIG.milvus.collection
    })
    expect(client.loadCollection).toHaveBeenCalledWith({
      collection_name: DEFAULT_CONFIG.milvus.collection
    })
    expect(existsSpy).toHaveBeenCalled()
    expect(rmSpy).toHaveBeenCalled()
    expect(mkdirSpy).toHaveBeenCalled()
  })

  it('getRecordStats returns stats map', async () => {
    const client = makeMockClient()
    client.query.mockResolvedValue({
      data: [
        { id: 'a', retrieval_count: 2, usage_count: 1, success_count: 3, failure_count: 0 },
        { id: 'b', retrieval_count: 4, usage_count: 2, success_count: 0, failure_count: 1 }
      ]
    })
    vi.spyOn(milvusClient, 'ensureClient').mockResolvedValue(client as any)

    const stats = await milvusCrud.getRecordStats(['a', 'b', 'a'], DEFAULT_CONFIG)

    expect(client.query).toHaveBeenCalledWith(expect.objectContaining({
      filter: 'id in ["a", "b"]'
    }))
    expect(stats.get('a')).toEqual({
      id: 'a',
      retrievalCount: 2,
      usageCount: 1,
      successCount: 3,
      failureCount: 0
    })
    expect(stats.get('b')).toEqual({
      id: 'b',
      retrievalCount: 4,
      usageCount: 2,
      successCount: 0,
      failureCount: 1
    })
  })

  it('getDomainExamples groups and limits examples', async () => {
    const client = makeMockClient()
    client.query.mockResolvedValue({
      data: [
        { domain: 'node', content: JSON.stringify({ type: 'command', command: 'npm test' }) },
        { domain: 'node', content: JSON.stringify({ type: 'command', command: 'npm run build' }) },
        { domain: 'db', content: JSON.stringify({ type: 'error', errorText: 'connection lost' }) },
        { domain: '', content: JSON.stringify({ type: 'command', command: 'skip me' }) }
      ]
    })
    vi.spyOn(milvusClient, 'ensureClient').mockResolvedValue(client as any)

    const examples = await milvusCrud.getDomainExamples(1, DEFAULT_CONFIG)

    expect(examples).toEqual([
      { domain: 'db', examples: ['connection lost'] },
      { domain: 'node', examples: ['npm test'] }
    ])
  })
})

describe('milvus-records', () => {
  it('buildMilvusRow normalizes defaults and resolves context', async () => {
    const record = createCommandRecord({
      project: undefined,
      scope: undefined,
      domain: undefined,
      successCount: undefined,
      retrievalCount: undefined,
      usageCount: undefined,
      lastUsed: undefined,
      embedding: [0.1, 0.2]
    })

    const row = await milvusRecords.buildMilvusRow(record, DEFAULT_CONFIG)

    expect(row.project).toBe('project-x')
    expect(row.scope).toBe('project')
    expect(row.domain).toBe('')
    expect(row.success_count).toBe(0)
    expect(row.retrieval_count).toBe(0)
    expect(row.usage_count).toBe(0)
    expect(row.last_used).toBe(record.timestamp)
    expect(mockedEmbed).not.toHaveBeenCalled()
  })

  it('buildMilvusRow resolves procedure domain and project', async () => {
    const record = createProcedureRecord({
      project: undefined,
      domain: undefined,
      embedding: [0.3, 0.4]
    })

    const row = await milvusRecords.buildMilvusRow(record, DEFAULT_CONFIG)

    expect(row.project).toBe('project-x')
    expect(row.domain).toBe('deploy')
    expect(row.scope).toBe('project')
  })

  it('buildMilvusRow supports all record types', async () => {
    const records: MemoryRecord[] = [
      createCommandRecord({ embedding: [0.1, 0.2] }),
      createErrorRecord({ embedding: [0.1, 0.2] }),
      createDiscoveryRecord({ embedding: [0.1, 0.2] }),
      createProcedureRecord({ embedding: [0.1, 0.2] }),
      createWarningRecord({ embedding: [0.1, 0.2] })
    ]

    const rows = await Promise.all(records.map(record => milvusRecords.buildMilvusRow(record, DEFAULT_CONFIG)))

    expect(rows.map(row => row.type)).toEqual(['command', 'error', 'discovery', 'procedure', 'warning'])
    expect(rows.every(row => row.scope === 'project')).toBe(true)
  })

  it('buildMilvusRow uses embedding input when embedding missing', async () => {
    const record = createCommandRecord({
      resolution: 'use pnpm',
      embedding: undefined
    })

    mockedEmbed.mockResolvedValue([0.9, 0.8])

    const row = await milvusRecords.buildMilvusRow(record, DEFAULT_CONFIG)

    expect(mockedEmbed).toHaveBeenCalledWith('npm test\nuse pnpm', DEFAULT_CONFIG)
    expect(row.embedding).toEqual([0.9, 0.8])
  })

  it('buildEmbeddingInput combines exact and supplemental text', () => {
    const command = createCommandRecord({ resolution: 'use pnpm' })
    const error = createErrorRecord({ cause: 'null', resolution: 'restart' })
    const discovery = createDiscoveryRecord({ evidence: 'read docs' })
    const procedure = createProcedureRecord({
      prerequisites: ['token'],
      verification: 'curl /health'
    })
    const warning = createWarningRecord()

    expect(milvusRecords.buildEmbeddingInput(command)).toBe('npm test\nuse pnpm')
    expect(milvusRecords.buildEmbeddingInput(error)).toBe('TypeError: boom\nnull\nrestart')
    expect(milvusRecords.buildEmbeddingInput(discovery)).toBe('Uses ESM\npackage.json\nread docs')
    expect(milvusRecords.buildEmbeddingInput(procedure)).toBe('Deploy\nbuild\ndeploy\ntoken\ncurl /health')
    expect(milvusRecords.buildEmbeddingInput(warning)).toBe('rm -rf /\nrm -i\nsafer')
  })

  it('parseRecordFromRow validates required fields', () => {
    const invalidRows: Array<Record<string, unknown>> = [
      { id: 'c1', type: 'command', content: JSON.stringify({ type: 'command', id: 'c1', exitCode: 0, outcome: 'success', context: {} }) },
      { id: 'e1', type: 'error', content: JSON.stringify({ type: 'error', id: 'e1', errorText: 'oops', resolution: 'fix', context: {} }) },
      { id: 'd1', type: 'discovery', content: JSON.stringify({ type: 'discovery', id: 'd1', what: 'x', where: 'y', confidence: 'verified' }) },
      { id: 'p1', type: 'procedure', content: JSON.stringify({ type: 'procedure', id: 'p1', name: 'n', steps: [], context: {} }) },
      { id: 'w1', type: 'warning', content: JSON.stringify({ type: 'warning', id: 'w1', avoid: 'x', useInstead: 'y', reason: 'z', severity: 'unknown' }) }
    ]

    for (const row of invalidRows) {
      expect(milvusRecords.parseRecordFromRow(row)).toBeNull()
    }
  })

  it('parseRecordFromRow parses valid rows and counts', () => {
    const record = createCommandRecord({
      id: 'cmd-parse',
      embedding: [0.4, 0.5]
    })
    const row = {
      id: record.id,
      type: record.type,
      content: JSON.stringify(record),
      success_count: '2',
      retrieval_count: '3',
      usage_count: '1',
      embedding: [0.4, 0.5]
    }

    const parsed = milvusRecords.parseRecordFromRow(row)

    expect(parsed?.id).toBe('cmd-parse')
    expect(parsed?.successCount).toBe(2)
    expect(parsed?.retrievalCount).toBe(3)
    expect(parsed?.usageCount).toBe(1)
    expect(parsed?.embedding).toEqual([0.4, 0.5])
  })
})

describe('milvus-search', () => {
  it('escapeLikeValue escapes wildcards and filter chars', () => {
    const input = '100%_match "quote" \\ path'
    const escaped = milvusSearch.escapeLikeValue(input)

    expect(escaped).toBe('100\\\\%\\\\_match \\"quote\\" \\\\ path')
  })

  it('buildKeywordFilter handles base filter and empty query', () => {
    const filter = milvusSearch.buildKeywordFilter('', 'project == "proj"')

    expect(filter).toBe('project == "proj" && exact_text like "%%"')
  })

  it('buildKeywordFilter preserves unicode and escapes wildcards', () => {
    const filter = milvusSearch.buildKeywordFilter('caf\u00e9_%')

    expect(filter).toBe('exact_text like "%caf\u00e9\\\\_\\\\%%"')
  })
})
