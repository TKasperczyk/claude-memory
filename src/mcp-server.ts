#!/usr/bin/env node

/**
 * MCP server for claude-memory.
 * Exposes read-only access to the memory knowledge base.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { loadConfig } from './lib/config.js'
import { initMilvus, closeMilvus, hybridSearch } from './lib/milvus.js'
import { findAncestorProjects, formatRecordSnippet } from './lib/context.js'
import { embed } from './lib/embed.js'
import { loadSettings } from './lib/settings.js'
import type { Config, HybridSearchResult, MemoryRecord, RecordType } from './lib/types.js'

const RECORD_TYPES = ['command', 'error', 'discovery', 'procedure', 'warning'] as const

let config: Config
let initialized = false

async function ensureInitialized(): Promise<void> {
  if (initialized) return
  config = loadConfig(process.cwd())
  await initMilvus(config)
  initialized = true
}

function formatRecordForTool(record: MemoryRecord): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: record.id,
    type: record.type,
    scope: record.scope ?? 'project',
    project: record.project,
    timestamp: record.timestamp ? new Date(record.timestamp).toISOString() : undefined,
    deprecated: record.deprecated ?? false,
    snippet: formatRecordSnippet(record)
  }

  switch (record.type) {
    case 'command':
      base.command = record.command
      base.outcome = record.outcome
      base.exitCode = record.exitCode
      base.resolution = record.resolution
      base.context = record.context
      break
    case 'error':
      base.errorText = record.errorText
      base.errorType = record.errorType
      base.cause = record.cause
      base.resolution = record.resolution
      base.context = record.context
      break
    case 'discovery':
      base.what = record.what
      base.where = record.where
      base.confidence = record.confidence
      break
    case 'procedure':
      base.name = record.name
      base.steps = record.steps
      base.prerequisites = record.prerequisites
      base.verification = record.verification
      break
    case 'warning':
      base.avoid = record.avoid
      base.useInstead = record.useInstead
      base.reason = record.reason
      base.severity = record.severity
      break
  }

  // Strip undefined values
  return Object.fromEntries(Object.entries(base).filter(([, v]) => v !== undefined))
}

function formatSearchResult(result: HybridSearchResult): Record<string, unknown> {
  return {
    ...formatRecordForTool(result.record),
    similarity: Math.round(result.similarity * 1000) / 1000,
    score: Math.round(result.score * 1000) / 1000,
    keywordMatch: result.keywordMatch
  }
}

const server = new McpServer({
  name: 'claude-memory',
  version: '0.1.0'
})

server.tool(
  'search_memories',
  'Search the memory knowledge base using hybrid keyword + semantic search. DO NOT use this proactively — relevant memories are already auto-injected into context at the start of each prompt. Only use this when the user explicitly asks to search or recall stored knowledge (e.g. "what do I have stored about X?", "look up that procedure we saved").',
  {
    query: z.string().describe('Search query — a natural language description of what you are looking for'),
    project: z.string().optional().describe('Project path to scope results to. Defaults to cwd.'),
    type: z.enum(RECORD_TYPES).optional().describe('Filter by record type'),
    limit: z.number().int().min(1).max(50).default(10).describe('Maximum number of results')
  },
  async ({ query, project, type, limit }) => {
    await ensureInitialized()

    const settings = loadSettings()
    const projectPath = project ?? process.cwd()
    const ancestorProjects = findAncestorProjects(projectPath)

    let embedding: number[] | undefined
    try {
      embedding = await embed(query, config)
    } catch {
      // Fall back to keyword-only search
    }

    const results = await hybridSearch({
      query,
      limit,
      project: projectPath,
      ancestorProjects,
      type: type as RecordType | undefined,
      excludeDeprecated: true,
      embedding,
      vectorWeight: embedding ? 1 : 0,
      keywordWeight: 1,
      minSimilarity: settings.minSemanticSimilarity,
      usageRatioWeight: settings.usageRatioWeight,
      includeEmbeddings: false
    }, config) as HybridSearchResult[]

    if (results.length === 0) {
      return {
        content: [{ type: 'text' as const, text: 'No matching memories found.' }]
      }
    }

    const formatted = results.map(formatSearchResult)
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(formatted, null, 2) }]
    }
  }
)

async function main(): Promise<void> {
  const transport = new StdioServerTransport()
  await server.connect(transport)

  process.on('SIGINT', async () => {
    await closeMilvus()
    process.exit(0)
  })
  process.on('SIGTERM', async () => {
    await closeMilvus()
    process.exit(0)
  })
}

main().catch((error) => {
  console.error('[claude-memory-mcp] Fatal error:', error)
  process.exit(1)
})
