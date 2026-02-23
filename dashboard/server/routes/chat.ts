import { readFileSync } from 'fs'
import express from 'express'
import type { ServerContext } from '../context.js'
import { createLogger } from '../lib/logger.js'
import { createSseStream } from '../lib/sse.js'
import { ensureConfigInitialized } from '../utils/milvus.js'
import { isPlainObject } from '../utils/params.js'
import { CLAUDE_CODE_SYSTEM_PROMPT, createAnthropicClient } from '../../../src/lib/anthropic.js'
import { applyToolUseDelta, finalizeToolUses, type ToolUseAccumulator } from '../../../src/lib/anthropic-stream.js'
import { CHAT_TOOLS, executeChatTool, type ChatToolName } from '../lib/chat-tools.js'
import { loadSettings } from '../../../src/lib/settings.js'
import type { Settings } from '../../../src/lib/settings.js'
import { buildMemoryStats } from '../../../src/lib/memory-stats.js'
import type { Config } from '../../../src/lib/types.js'
import type { MemoryStatsSummary } from '../../../shared/types.js'

const logger = createLogger('chat')

const STATIC_PROMPT = readFileSync(
  new URL('../lib/chat-system-prompt.md', import.meta.url), 'utf-8'
)

const CHAT_MAX_TOKENS = 10000
const CHAT_TEMPERATURE = 0.2
const MAX_TOOL_ROUNDS = 50
const EFFORT_MODELS = ['claude-opus-4-5', 'claude-opus-4-6', 'claude-sonnet-4-6']

function supportsEffort(model: string): boolean {
  return EFFORT_MODELS.some(prefix => model.startsWith(prefix))
}

type ChatMessage = {
  role: 'user' | 'assistant'
  content: string
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (!isPlainObject(value)) return false
  const role = value.role
  const content = value.content
  if (role !== 'user' && role !== 'assistant') return false
  return typeof content === 'string'
}

function formatStatsForPrompt(stats: MemoryStatsSummary): string {
  const typeCounts = Object.entries(stats.byType)
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `${count} ${type}`)
    .join(', ')

  const scopeCounts = Object.entries(stats.byScope)
    .sort((a, b) => b[1] - a[1])
    .map(([scope, count]) => `${count} ${scope}`)
    .join(', ')

  const lines = [
    `## Current Database Stats`,
    `- Total memories: ${stats.total} (${stats.deprecated} deprecated)`,
    `- By type: ${typeCounts || 'none'}`,
    `- By scope: ${scopeCounts || 'none'}`,
  ]
  lines.push(
    `- Avg retrieval count: ${stats.avgRetrievalCount.toFixed(1)}, avg usage ratio: ${stats.avgUsageRatio.toFixed(2)}`
  )
  return lines.join('\n')
}

function formatSettingsForPrompt(settings: Settings): string {
  const lines = [
    `## Current Settings (Retrieval)`,
    `- minScore: ${settings.minScore}, minSemanticSimilarity: ${settings.minSemanticSimilarity}`,
    `- maxRecords: ${settings.maxRecords}, maxTokens: ${settings.maxTokens}`,
    `- mmrLambda: ${settings.mmrLambda}, keywordBonus: ${settings.keywordBonus}, usageRatioWeight: ${settings.usageRatioWeight}`,
    `- Haiku query planning: ${settings.enableHaikuRetrieval ? 'enabled' : 'disabled'}`,
  ]
  return lines.join('\n')
}

async function buildSystemPrompt(config: Config, project?: string): Promise<string> {
  const settings = loadSettings()

  let statsBlock = ''
  try {
    const stats = await buildMemoryStats(config)
    statsBlock = formatStatsForPrompt(stats)
  } catch (err) {
    logger.warn('Failed to fetch memory stats for chat prompt', err)
  }

  const settingsBlock = formatSettingsForPrompt(settings)

  const parts = [STATIC_PROMPT]
  if (project) parts.push(`\n## Active Project\n${project}`)
  if (settingsBlock) parts.push(settingsBlock)
  if (statsBlock) parts.push(statsBlock)

  return parts.join('\n')
}

export function createChatRouter(context: ServerContext): express.Router {
  const router = express.Router()
  const { config: baseConfig } = context

  router.post('/api/chat', async (req, res) => {
    if (!isPlainObject(req.body)) {
      return res.status(400).json({ error: 'Invalid payload' })
    }

    const { messages, project } = req.body
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array required' })
    }

    const normalizedMessages: ChatMessage[] = []
    for (const entry of messages) {
      if (!isChatMessage(entry)) {
        return res.status(400).json({ error: 'Each message must have role and content' })
      }
      const trimmed = entry.content.trim()
      if (!trimmed) continue
      normalizedMessages.push({ role: entry.role, content: trimmed })
    }

    if (normalizedMessages.length === 0) {
      return res.status(400).json({ error: 'messages array required' })
    }

    const stream = createSseStream(res)

    try {
      const client = await createAnthropicClient()
      if (!client) {
        stream.send('error', { error: 'Anthropic authentication not configured.' })
        return
      }

      const config = await ensureConfigInitialized(req, baseConfig)
      const systemPrompt = await buildSystemPrompt(config, typeof project === 'string' ? project.trim() : undefined)

      const conversation: Array<{ role: 'user' | 'assistant'; content: unknown }> = normalizedMessages.map(message => ({
        role: message.role,
        content: message.content
      }))

      let rounds = 0

      while (!stream.signal.aborted && rounds < MAX_TOOL_ROUNDS) {
        rounds += 1

        const { chatModel } = loadSettings()
        logger.info(`Using chat model: ${chatModel}`)
        const createParams: Record<string, unknown> = {
          model: chatModel,
          max_tokens: CHAT_MAX_TOKENS,
          temperature: CHAT_TEMPERATURE,
          system: [
            { type: 'text', text: CLAUDE_CODE_SYSTEM_PROMPT },
            { type: 'text', text: systemPrompt }
          ],
          messages: conversation,
          tools: CHAT_TOOLS,
          tool_choice: { type: 'auto' },
          stream: true
        }
        if (supportsEffort(chatModel)) {
          createParams.output_config = { effort: 'high' }
        }
        const responseStream = await (client.messages.create as Function)(
          createParams, stream.signal ? { signal: stream.signal } : undefined
        )

        const { contentBlocks, toolUses } = await consumeChatStream(responseStream, stream)

        if (stream.signal.aborted) break

        if (contentBlocks.length > 0) {
          conversation.push({ role: 'assistant', content: contentBlocks })
        }

        if (toolUses.length === 0) {
          stream.send('done', { done: true })
          return
        }

        const toolResultBlocks: Array<{ type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }> = []

        for (const toolUse of toolUses) {
          if (stream.signal.aborted) break
          stream.send('tool_use', { id: toolUse.id, name: toolUse.name, input: toolUse.input })

          let executionResult: unknown
          let isError = false
          try {
            const execution = await executeChatTool(toolUse.name as ChatToolName, toolUse.input, {
              config,
              project: typeof project === 'string' ? project.trim() : undefined
            })
            executionResult = execution.result
            isError = Boolean(execution.isError)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            executionResult = { error: message || 'Tool execution failed' }
            isError = true
          }

          stream.send('tool_result', {
            tool_use_id: toolUse.id,
            name: toolUse.name,
            result: executionResult,
            is_error: isError
          })

          toolResultBlocks.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: JSON.stringify(executionResult),
            is_error: isError
          })
        }

        if (stream.signal.aborted) break

        conversation.push({ role: 'user', content: toolResultBlocks })
      }

      if (!stream.signal.aborted) {
        stream.send('error', { error: 'Tool call limit reached.' })
      }
    } catch (error) {
      if (!stream.signal.aborted) {
        const message = error instanceof Error ? error.message : String(error)
        logger.error('Chat failed', error)
        stream.send('error', { error: message || 'Chat request failed' })
      }
    } finally {
      stream.end()
    }
  })

  return router
}

async function consumeChatStream(
  responseStream: AsyncIterable<unknown>,
  stream: ReturnType<typeof createSseStream>
): Promise<{ contentBlocks: Array<{ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown }>; toolUses: Array<{ id: string; name: string; input: unknown }> }> {
  const contentByIndex = new Map<number, { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown }>()
  const toolInputs = new Map<number, ToolUseAccumulator>()

  for await (const rawEvent of responseStream) {
    const event = rawEvent as { type?: string; index?: number; content_block?: any; delta?: any }
    if (stream.signal.aborted) break
    applyToolUseDelta(toolInputs, event)

    if (event.type === 'content_block_start') {
      const block = event.content_block
      if (block.type === 'text') {
        const initialText = block.text ?? ''
        contentByIndex.set(event.index, { type: 'text', text: initialText })
        if (initialText) {
          stream.send('text', { text: initialText })
        }
      } else if (block.type === 'tool_use') {
        contentByIndex.set(event.index, {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.input
        })
      }
      continue
    }

    if (event.type === 'content_block_delta') {
      if (event.delta.type === 'text_delta') {
        const textChunk = event.delta.text ?? ''
        if (!textChunk) continue
        const existing = contentByIndex.get(event.index)
        if (existing && existing.type === 'text') {
          existing.text += textChunk
        } else {
          contentByIndex.set(event.index, { type: 'text', text: textChunk })
        }
        stream.send('text', { text: textChunk })
        continue
      }
    }
  }

  const toolUses = finalizeToolUses(toolInputs).map(entry => {
    const existingBlock = contentByIndex.get(entry.index)
    if (existingBlock && existingBlock.type === 'tool_use') {
      existingBlock.input = entry.input
    }
    return {
      id: entry.id,
      name: entry.name,
      input: entry.input
    }
  })

  const orderedBlocks = Array.from(contentByIndex.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, block]) => block)

  const contentBlocks = orderedBlocks.filter(block => {
    if (block.type === 'text') {
      return block.text.trim().length > 0
    }
    return true
  })

  return { contentBlocks, toolUses }
}
