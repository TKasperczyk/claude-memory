import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import { createConfig, EMBEDDING_DIM, type MemoryRecord } from '../src/lib/types.js'
import {
  batchUpdateRecords,
  buildFilter,
  buildKeywordFilter,
  closeLanceDB,
  countRecords,
  deleteRecord,
  escapeFilterValue,
  escapeLikeValue,
  getRecord,
  incrementRecordCounters,
  initLanceDB,
  insertRecord,
  iterateRecords,
  queryRecords,
  updateRecord,
  vectorSearchSimilar
} from '../src/lib/lancedb.js'

function makeEmbedding(value: number): number[] {
  const embedding = new Array<number>(EMBEDDING_DIM).fill(0)
  embedding[0] = value
  return embedding
}

function makeCommandRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const id = randomUUID()
  return {
    id,
    type: 'command',
    command: 'pnpm build',
    exitCode: 0,
    outcome: 'success',
    context: {
      project: '/tmp/test',
      cwd: '/tmp/test',
      intent: 'run build'
    },
    project: '/tmp/test',
    scope: 'project',
    timestamp: Date.now(),
    successCount: 1,
    failureCount: 0,
    retrievalCount: 0,
    usageCount: 0,
    lastUsed: Date.now(),
    deprecated: false,
    ...overrides
  } as MemoryRecord
}

describe('LanceDB core API', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-memory-lancedb-unit-'))
  const table = `unit_${randomUUID().replace(/-/g, '')}`
  const config = createConfig({
    lancedb: {
      directory: tempDir,
      table
    }
  })

  beforeAll(async () => {
    await initLanceDB(config)
  })

  afterAll(async () => {
    await closeLanceDB()
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('inserts and gets records round-trip', async () => {
    const record = makeCommandRecord({ embedding: makeEmbedding(1) })
    await insertRecord(record, config)

    const loaded = await getRecord(record.id, config, { includeEmbedding: true })
    expect(loaded).not.toBeNull()
    expect(loaded?.id).toBe(record.id)
    expect((loaded as any).command).toBe('pnpm build')
    expect(Array.isArray(loaded?.embedding)).toBe(true)
    expect(loaded?.embedding?.length).toBe(EMBEDDING_DIM)
  })

  it('supports SQL filters in query/count', async () => {
    const a = makeCommandRecord({ embedding: makeEmbedding(1), project: '/p1', deprecated: false })
    const b = makeCommandRecord({ embedding: makeEmbedding(2), project: '/p2', deprecated: true })
    await insertRecord(a, config)
    await insertRecord(b, config)

    const visible = await queryRecords({ filter: "project = '/p1' AND deprecated = false" }, config)
    expect(visible.map(r => r.id)).toContain(a.id)
    expect(visible.map(r => r.id)).not.toContain(b.id)

    const total = await countRecords({ filter: 'deprecated = true' }, config)
    expect(total).toBeGreaterThanOrEqual(1)
  })

  it('converts cosine distance to similarity', async () => {
    const e = makeEmbedding(1)
    const r1 = makeCommandRecord({ embedding: e })
    const r2 = makeCommandRecord({ embedding: e })
    await insertRecord(r1, config)
    await insertRecord(r2, config)

    const results = await vectorSearchSimilar(e, { limit: 10, filter: `id <> '${escapeFilterValue(r1.id)}'` }, config)
    const match = results.find(entry => entry.record.id === r2.id)
    expect(match).toBeTruthy()
    expect((match as any).similarity).toBeGreaterThan(0.99)
  })

  it('builds SQL filters and LIKE clauses', () => {
    const filter = buildFilter({
      project: '/proj',
      ancestorProjects: ['/anc'],
      includeGlobal: true,
      type: 'command',
      excludeId: "id'with",
      excludeDeprecated: true
    })

    expect(filter).toContain("project IN ('/proj', '/anc')")
    expect(filter).toContain("OR scope = 'global'")
    expect(filter).toContain("type = 'command'")
    expect(filter).toContain("id <> 'id''with'")
    expect(filter).toContain('deprecated = false')

    const escaped = escapeLikeValue("café_%")
    const keyword = buildKeywordFilter("café_%")
    expect(keyword).toContain('exact_text LIKE')
    expect(keyword).toContain("ESCAPE '\\'")
    expect(keyword).toContain(escaped)
  })

  it('escapes SQL string literals', () => {
    expect(escapeFilterValue("a'b")).toBe("a''b")
  })

  it('deletes records by id', async () => {
    const record = makeCommandRecord({ embedding: makeEmbedding(3) })
    await insertRecord(record, config)
    await deleteRecord(record.id, config)
    const loaded = await getRecord(record.id, config)
    expect(loaded).toBeNull()
  })

  it('updates an existing record and returns false for missing ids', async () => {
    const project = `/tmp/update-${randomUUID()}`
    const record = makeCommandRecord({
      embedding: makeEmbedding(4),
      project,
      deprecated: false
    })
    await insertRecord(record, config)

    const updated = await updateRecord(record.id, { deprecated: true, scope: 'global' }, config)
    expect(updated).toBe(true)

    const loaded = await getRecord(record.id, config)
    expect(loaded).not.toBeNull()
    expect(loaded?.deprecated).toBe(true)
    expect(loaded?.scope).toBe('global')

    const missing = await updateRecord(`missing-${randomUUID()}`, { deprecated: true }, config)
    expect(missing).toBe(false)
  })

  it('increments retrieval and usage counters', async () => {
    const record = makeCommandRecord({
      embedding: makeEmbedding(5),
      retrievalCount: 2,
      usageCount: 1
    })
    await insertRecord(record, config)

    const updated = await incrementRecordCounters(record.id, { retrievalCount: 3, usageCount: 2 }, config)
    expect(updated).toBe(true)

    const loaded = await getRecord(record.id, config)
    expect(loaded).not.toBeNull()
    expect(loaded?.retrievalCount).toBe(5)
    expect(loaded?.usageCount).toBe(3)
    expect((loaded?.lastUsed ?? 0)).toBeGreaterThanOrEqual(record.lastUsed)

    const noDelta = await incrementRecordCounters(record.id, { retrievalCount: 0, usageCount: 0 }, config)
    expect(noDelta).toBe(true)

    const missing = await incrementRecordCounters(`missing-${randomUUID()}`, { retrievalCount: 1 }, config)
    expect(missing).toBe(false)
  })

  it('batch updates multiple records with shared updates', async () => {
    const project = `/tmp/batch-${randomUUID()}`
    const records = [
      makeCommandRecord({ embedding: makeEmbedding(6), project, deprecated: false }),
      makeCommandRecord({ embedding: makeEmbedding(7), project, deprecated: false }),
      makeCommandRecord({ embedding: makeEmbedding(8), project, deprecated: false })
    ]

    for (const record of records) {
      await insertRecord(record, config)
    }

    const result = await batchUpdateRecords(records, { deprecated: true, scope: 'global' }, config)
    expect(result).toEqual({ updated: 3, failed: 0 })

    const filter = `project = '${escapeFilterValue(project)}'`
    const updatedRecords = await queryRecords({ filter, limit: 10 }, config)
    expect(updatedRecords).toHaveLength(3)
    expect(updatedRecords.every(record => record.deprecated && record.scope === 'global')).toBe(true)
  })

  it('supports ordered pagination with limit and offset', async () => {
    const project = `/tmp/pagination-${randomUUID()}`
    const baseTimestamp = Date.UTC(2026, 0, 1, 0, 0, 0)

    for (let i = 0; i < 8; i += 1) {
      await insertRecord(makeCommandRecord({
        embedding: makeEmbedding(9),
        project,
        command: `page-${i}`,
        timestamp: baseTimestamp + i,
        lastUsed: baseTimestamp + i
      }), config)
    }

    const filter = `project = '${escapeFilterValue(project)}'`
    const page = await queryRecords({
      filter,
      orderBy: 'timestamp_asc',
      limit: 3,
      offset: 2
    }, config)

    expect(page).toHaveLength(3)
    expect(page.map(record => (record as any).command)).toEqual(['page-2', 'page-3', 'page-4'])
  })

  it('iterates all matching records without duplicates or skips', async () => {
    const project = `/tmp/iterator-${randomUUID()}`
    const sharedEmbedding = makeEmbedding(10)
    const totalRecords = 15

    for (let i = 0; i < totalRecords; i += 1) {
      await insertRecord(makeCommandRecord({
        embedding: sharedEmbedding,
        project,
        command: `iter-${i}`
      }), config)
    }

    const filter = `project = '${escapeFilterValue(project)}'`
    const seenIds = new Set<string>()

    for await (const record of iterateRecords({ filter }, config)) {
      expect(seenIds.has(record.id)).toBe(false)
      seenIds.add(record.id)
      expect(record.project).toBe(project)
    }

    expect(seenIds.size).toBe(totalRecords)
  })
})
