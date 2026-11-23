import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  backfillSearchText,
  bm25Search,
  closeLanceDB,
  hybridSearch,
  initLanceDB,
  insertRecord
} from '../src/lib/lancedb.js'
import { DEFAULT_CONFIG, EMBEDDING_DIM, type Config, type DiscoveryRecord, type ErrorRecord, type CommandRecord } from '../src/lib/types.js'
import { expandViaRelations } from '../src/lib/retrieval.js'
import { readPrePromptTelemetry, recordPrePromptTelemetry, resetPrePromptTelemetryStores } from '../src/lib/pre-prompt-telemetry.js'
import { buildSearchText } from '../src/lib/shared.js'

function unitVector(axis: number): number[] {
  const v = new Array(EMBEDDING_DIM).fill(0)
  v[axis % EMBEDDING_DIM] = 1
  return v
}

function makeTempConfig(): { dir: string; config: Config } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-phase2-test-'))
  const config: Config = {
    ...DEFAULT_CONFIG,
    lancedb: {
      directory: path.join(dir, 'lancedb'),
      table: 'phase2_test_memories'
    }
  }
  return { dir, config }
}

describe('Phase 2: Native LanceDB BM25 FTS, expanded search_text, and causal maxTimestamp', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await closeLanceDB()
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('indexes command.context.intent, error.cause, error.resolution, discovery.evidence, and entities via BM25 FTS', async () => {
    const { dir, config } = makeTempConfig()
    tempDirs.push(dir)
    await initLanceDB(config)

    const cmdRec: CommandRecord = {
      id: '11111111-1111-4111-8111-111111111111',
      type: 'command',
      command: 'systemctl restart caddy',
      exitCode: 0,
      outcome: 'success',
      context: {
        project: '/repo/app',
        cwd: '/repo/app',
        intent: 'reload tls reverse proxy certificates after renewal'
      },
      entities: ['caddy', 'acme-dns'],
      project: '/repo/app',
      scope: 'project',
      timestamp: 1000,
      lastUsed: 1000,
      deprecated: false,
      embedding: unitVector(0)
    }

    const errRec: ErrorRecord = {
      id: '22222222-2222-4222-8222-222222222222',
      type: 'error',
      errorText: 'ECONNREFUSED 127.0.0.1:5432',
      errorType: 'network',
      cause: 'pgbouncer socket pool exhausted due to idle transactions',
      resolution: 'set default_pool_size=40 and idle_in_transaction_session_timeout',
      context: { project: '/repo/app' },
      entities: ['pgbouncer', 'postgres16'],
      project: '/repo/app',
      scope: 'project',
      timestamp: 2000,
      lastUsed: 2000,
      deprecated: false,
      embedding: unitVector(1)
    }

    const discRec: DiscoveryRecord = {
      id: '33333333-3333-4333-8333-333333333333',
      type: 'discovery',
      what: 'Use NVMe mount for build cache',
      where: '/etc/fstab',
      evidence: 'verified via fio benchmark showing 4x throughput on zfs-nvme-pool',
      confidence: 'verified',
      entities: ['zfs-nvme-pool'],
      project: '/repo/app',
      scope: 'project',
      timestamp: 3000,
      lastUsed: 3000,
      deprecated: false,
      embedding: unitVector(2)
    }

    expect(buildSearchText(cmdRec)).toContain('renewal')
    expect(buildSearchText(errRec)).toContain('pgbouncer')
    expect(buildSearchText(errRec)).toContain('default_pool_size')
    expect(buildSearchText(discRec)).toContain('zfs-nvme-pool')

    await insertRecord(cmdRec, config)
    await insertRecord(errRec, config)
    await insertRecord(discRec, config)

    // Query against command.context.intent (absent from exact_text)
    const intentHits = await bm25Search({ query: 'certificates renewal', project: '/repo/app' }, config)
    expect(intentHits.map(r => r.record.id)).toContain(cmdRec.id)
    expect(intentHits[0].bm25Score).toBeGreaterThan(0)

    // Query against error.cause & error.resolution (absent from exact_text)
    const causeHits = await bm25Search({ query: 'pgbouncer idle transactions', project: '/repo/app' }, config)
    expect(causeHits.map(r => r.record.id)).toContain(errRec.id)

    const resolutionHits = await bm25Search({ query: 'default_pool_size', project: '/repo/app' }, config)
    expect(resolutionHits.map(r => r.record.id)).toContain(errRec.id)

    // Query against discovery.evidence + entity
    const evidenceHits = await bm25Search({ query: 'fio benchmark zfs-nvme-pool', project: '/repo/app' }, config)
    expect(evidenceHits.map(r => r.record.id)).toContain(discRec.id)

    // backfillSearchText should report 0 updated since search_text is already current
    const backfill = await backfillSearchText(config)
    expect(backfill.scanned).toBe(3)
    expect(backfill.updated).toBe(0)
  })

  it('strictly enforces causal maxTimestamp across BM25, vector search, and relation expansion', async () => {
    const { dir, config } = makeTempConfig()
    tempDirs.push(dir)
    await initLanceDB(config)

    const pastRec: DiscoveryRecord = {
      id: '44444444-4444-4444-8444-444444444444',
      type: 'discovery',
      what: 'Past discovery about kubernetes ingress timeout',
      where: 'k8s/ingress.yaml',
      evidence: 'observed before session',
      confidence: 'verified',
      project: '/repo/k8s',
      scope: 'project',
      timestamp: 1000,
      lastUsed: 1000,
      deprecated: false,
      embedding: unitVector(5),
      relations: [{
        targetId: '55555555-5555-4555-8555-555555555555',
        kind: 'relates_to',
        weight: 0.9,
        createdAt: new Date(5000).toISOString(),
        lastReinforcedAt: new Date(5000).toISOString(),
        reinforcementCount: 1
      }]
    }

    const futureRec: DiscoveryRecord = {
      id: '55555555-5555-4555-8555-555555555555',
      type: 'discovery',
      what: 'Future discovery about kubernetes ingress timeout',
      where: 'k8s/ingress.yaml',
      evidence: 'created after prompt timestamp',
      confidence: 'verified',
      project: '/repo/k8s',
      scope: 'project',
      timestamp: 5000,
      lastUsed: 5000,
      deprecated: false,
      embedding: unitVector(5)
    }

    await insertRecord(pastRec, config)
    await insertRecord(futureRec, config)

    // BM25 with maxTimestamp=3000 must exclude futureRec (timestamp=5000)
    const bm25Causal = await bm25Search({
      query: 'kubernetes ingress timeout',
      project: '/repo/k8s',
      maxTimestamp: 3000
    }, config)
    expect(bm25Causal.map(r => r.record.id)).toEqual([pastRec.id])

    // Vector hybridSearch with maxTimestamp=3000 must exclude futureRec
    const vecCausal = await hybridSearch({
      query: '',
      embedding: unitVector(5),
      project: '/repo/k8s',
      vectorWeight: 1,
      keywordWeight: 0,
      minSimilarity: 0.5,
      minScore: 0,
      maxTimestamp: 3000
    }, config)
    expect(vecCausal.map(r => r.record.id)).toEqual([pastRec.id])

    // Relation expansion with maxTimestamp=3000 must not pull futureRec via relates_to edge
    const expanded = await expandViaRelations(
      [{ record: pastRec, score: 0.9, similarity: 0.9, keywordMatch: false }],
      config,
      { maxRelationHops: 1, maxRelationExpansions: 5, relationHopDecay: 0.6, enableEntityEdges: false },
      { project: '/repo/k8s', maxTimestamp: 3000 }
    )
    expect(expanded.map(r => r.record.id)).toEqual([pastRec.id])
  })

  it('writes and reads structured pre-prompt telemetry JSONL events', () => {
    resetPrePromptTelemetryStores()
    const collection = `test_tel_${Date.now()}`
    const ts = Date.now()
    const dateKey = new Date(ts).toISOString().slice(0, 10)

    recordPrePromptTelemetry({
      timestamp: ts,
      sessionId: 'sess-123',
      cwd: '/repo/app',
      project: '/repo/app',
      status: 'injected',
      pipeline: 'stage2-rerank',
      promptLength: 88,
      errorSignalCount: 1,
      commandSignalCount: 0,
      stage1CandidateCount: 12,
      bm25HitCount: 5,
      vectorHitCount: 9,
      suppressedCount: 2,
      rerankerCalled: true,
      rerankerAbstained: false,
      rerankerFallback: false,
      injectedCount: 2,
      injectedIds: ['id-a', 'id-b'],
      contextChars: 420,
      timings: { totalMs: 910, stage1EmbedMs: 410, stage1SearchMs: 425, stage2RerankMs: 450 }
    }, { collection })

    const rows = readPrePromptTelemetry(dateKey, { collection })
    expect(rows).toHaveLength(1)
    expect(rows[0].pipeline).toBe('stage2-rerank')
    expect(rows[0].injectedIds).toEqual(['id-a', 'id-b'])
    expect(rows[0].timings.stage2RerankMs).toBe(450)
  })
})
