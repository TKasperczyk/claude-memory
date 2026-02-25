import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import { createConfig, EMBEDDING_DIM, type MemoryRecord } from '../src/lib/types.js'
import {
  buildFilter,
  buildKeywordFilter,
  closeLanceDB,
  countRecords,
  deleteRecord,
  escapeFilterValue,
  escapeLikeValue,
  getRecord,
  initLanceDB,
  insertRecord,
  queryRecords,
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

describe('legacy DB API (LanceDB backend)', () => {
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
})
