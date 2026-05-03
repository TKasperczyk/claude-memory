import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAnthropicClient } from '../src/lib/anthropic.js'
import { generateRetrievalQueryPlan } from '../src/lib/retrieval-query-generator.js'

vi.mock('../src/lib/anthropic.js', () => ({
  CLAUDE_CODE_SYSTEM_PROMPT: 'Claude Code system prompt',
  createAnthropicClient: vi.fn()
}))

const mockedCreateAnthropicClient = vi.mocked(createAnthropicClient)
const mockedCreateMessage = vi.fn()

function queryPlanResponse(input: Record<string, unknown>) {
  return {
    content: [{
      type: 'tool_use',
      id: 'toolu_1',
      name: 'emit_query_plan',
      input
    }],
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0
    }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedCreateAnthropicClient.mockResolvedValue({
    messages: {
      create: mockedCreateMessage
    }
  } as any)
})

describe('Retrieval query generator', () => {
  it('returns one semantic query when expansion count is 1', async () => {
    mockedCreateMessage.mockResolvedValue(queryPlanResponse({
      resolvedQuery: 'How do I build the Docker image?',
      keywordQueries: ['docker build'],
      semanticQueries: ['Build a Docker image for this project.']
    }))

    const result = await generateRetrievalQueryPlan('How do I build it?', undefined, {
      expansionCount: 1
    })

    expect(result?.plan).toEqual({
      resolvedQuery: 'How do I build the Docker image?',
      keywordQueries: ['docker build'],
      semanticQueries: ['Build a Docker image for this project.']
    })
    expect(mockedCreateMessage).toHaveBeenCalledTimes(1)
    const request = mockedCreateMessage.mock.calls[0][0]
    expect(request.tools[0].input_schema.properties.semanticQueries.minItems).toBe(1)
    expect(request.tools[0].input_schema.properties.semanticQueries.maxItems).toBe(1)
    expect(request.messages[0].content).toContain('SEMANTIC_VARIANT_COUNT:\n1')
  })

  it('returns three distinct semantic queries in one Haiku call', async () => {
    const semanticQueries = [
      'ubiquiti gateway docker setup',
      'UniFi gateway controller container configuration',
      'docker exec MongoDB queries for UniFi controller setup'
    ]
    mockedCreateMessage.mockResolvedValue(queryPlanResponse({
      resolvedQuery: 'Do you remember our ubiquiti gateway docker setup?',
      keywordQueries: ['ubiquiti', 'UniFi', 'docker', 'docker exec'],
      semanticQueries
    }))

    const result = await generateRetrievalQueryPlan(
      'Do you remember our ubiquiti gateway docker setup?',
      undefined,
      { expansionCount: 3 }
    )

    expect(result?.plan?.semanticQueries).toEqual(semanticQueries)
    expect(new Set(result?.plan?.semanticQueries).size).toBe(3)
    expect(mockedCreateMessage).toHaveBeenCalledTimes(1)
    const request = mockedCreateMessage.mock.calls[0][0]
    expect(request.tools[0].input_schema.properties.semanticQueries.minItems).toBe(3)
    expect(request.tools[0].input_schema.properties.semanticQueries.maxItems).toBe(3)
    expect(request.messages[0].content).toContain('SEMANTIC_VARIANT_COUNT:\n3')
  })
})
