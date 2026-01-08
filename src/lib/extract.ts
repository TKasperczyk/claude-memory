import Anthropic from '@anthropic-ai/sdk'
import { randomUUID } from 'crypto'
import { DEFAULT_CONFIG, type CommandRecord, type Config, type DiscoveryRecord, type ErrorRecord, type InjectedMemoryEntry, type MemoryRecord, type ProcedureRecord, type WarningRecord, type WarningSeverity } from './types.js'
import type { Transcript, TranscriptEvent } from './transcript.js'
import { getDomainExamples, type DomainExample } from './milvus.js'
import { stripNoiseWords } from './context.js'
import { CLAUDE_CODE_SYSTEM_PROMPT, createAnthropicClient } from './anthropic.js'
import { getRecordSchemaOneOf } from './record-schema.js'

export interface ExtractionContext {
  sessionId: string
  cwd: string
  project?: string
  transcriptPath?: string
  intent?: string
  domain?: string
}

const TOOL_NAME = 'emit_records'
const USEFULNESS_TOOL_NAME = 'emit_usefulness'
const MAX_TRANSCRIPT_CHARS = 60000
const MAX_USEFULNESS_TRANSCRIPT_CHARS = 40000
const MAX_INTENT_CHARS = 240
const MAX_TRUNCATED_OUTPUT_CHARS = 6000
const MAX_TOOL_INPUT_CHARS = 4000
const USEFULNESS_MAX_TOKENS = 800
const DOMAIN_EXAMPLES_TTL_MS = 5 * 60 * 1000

let cachedDomainExamples: {
  fetchedAt: number
  cacheKey: string
  examples: DomainExample[]
} | null = null

const SYSTEM_PROMPT_BASE = `You extract durable technical knowledge from Claude Code transcripts.

Rules:
- Output ONLY via the tool call "${TOOL_NAME}" exactly once.
- Do NOT paraphrase commands or error messages. Copy them EXACTLY from the transcript.
- If you are unsure about a field, omit the record entirely.
- Extract only durable, re-usable items (commands, errors + resolutions, discoveries, procedures, warnings).
- Ignore chit-chat, long code listings, and private thinking blocks.
- Commands and errors must be verbatim from tool calls/output.
- When transcript output includes a "[truncated]" marker, do not include that marker in extracted text.
- Extract warnings when Claude explicitly learns that an approach doesn't work and identifies a better alternative.

CRITICAL - Source Evidence:
- EVERY record MUST include a sourceExcerpt field with a verbatim quote from the transcript.
- The sourceExcerpt must contain the actual text that supports the extraction.
- For commands: quote the tool call or result that shows the command.
- For errors: quote the error message as it appears in the transcript.
- For discoveries: quote the specific transcript segment that establishes the fact.
- For procedures: quote the steps as they appear in the conversation.
- For warnings: quote the conversation that shows the failed approach and the working alternative.
- If you cannot find a specific transcript segment to cite, DO NOT extract that record.
- Do not synthesize or infer information that isn't directly supported by transcript text.

Priority guidance:
- Prefer extracting project-level context over routine commands.
- A single "project uses SvelteKit with Supabase" discovery is more valuable than 10 routine build commands.
- Focus on insights that would help orient a future session in this codebase.
- Extract warnings when there's a clear "don't do X, do Y instead" pattern.

Scope guidance:
If a discovery or procedure applies universally (not specific to this project),
set scope: "global". Examples: general CLI flags, common error patterns,
language features. Project-specific: architecture decisions, file locations.
`

const DOMAIN_INSTRUCTIONS = `
Domain assignment:
- Use an existing domain when the record fits its category.
- Only create a new domain if no existing domain is appropriate.
- Domain names should be lowercase, hyphenated (e.g., "cloud-infra", "web-dev").
- Keep domains broad enough to group related tools (e.g., "docker" not "docker-compose").
`

const USEFULNESS_SYSTEM_PROMPT = `You evaluate which injected memories were actually used or helpful.

Rules:
- Only return IDs from the provided list.
- Only include a memory if it clearly influenced the solution.
- If unsure, omit it.
- Output ONLY via the tool call "${USEFULNESS_TOOL_NAME}" exactly once.
`

function buildSystemPrompt(domainExamples: DomainExample[]): string {
  if (domainExamples.length === 0) {
    return SYSTEM_PROMPT_BASE
  }

  const domainList = domainExamples
    .map(d => `- ${d.domain}: ${d.examples.map(e => `"${e}"`).join(', ')}`)
    .join('\n')

  return SYSTEM_PROMPT_BASE + DOMAIN_INSTRUCTIONS + `
Existing domains:
${domainList}
`
}

const EMIT_RECORDS_TOOL: Anthropic.Tool = {
  name: TOOL_NAME,
  description: 'Emit extracted technical knowledge records.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['records'],
    properties: {
      records: {
        type: 'array',
        items: {
          oneOf: getRecordSchemaOneOf()
        }
      }
    }
  }
}

const EMIT_USEFULNESS_TOOL: Anthropic.Tool = {
  name: USEFULNESS_TOOL_NAME,
  description: 'Return IDs of injected memories that were helpful.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['helpfulIds'],
    properties: {
      helpfulIds: {
        type: 'array',
        items: { type: 'string' }
      }
    }
  }
}

type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: unknown }

export async function extractRecords(
  transcript: Transcript,
  context: ExtractionContext,
  config: Config = DEFAULT_CONFIG
): Promise<MemoryRecord[]> {
  const derivedIntent = context.intent ?? inferIntent(transcript) ?? 'unknown'
  const resolvedContext: ExtractionContext = {
    ...context,
    intent: truncateIntent(stripNoiseWords(derivedIntent))
  }

  try {
    const client = await createAnthropicClient()
    if (!client) {
      console.error('[claude-memory] No authentication available for extraction. Set ANTHROPIC_API_KEY or run kira login.')
      return []
    }

    // Fetch existing domains to guide consistent domain assignment
    const domainExamples = await getCachedDomainExamples(2, config)
    const systemPrompt = buildSystemPrompt(domainExamples)

    const userPrompt = buildUserPrompt(transcript, resolvedContext)

    const response = await client.messages.create({
      model: config.extraction.model,
      max_tokens: config.extraction.maxTokens,
      temperature: 0,
      system: [
        { type: 'text', text: CLAUDE_CODE_SYSTEM_PROMPT },
        { type: 'text', text: systemPrompt }
      ],
      messages: [{ role: 'user', content: userPrompt }],
      tools: [EMIT_RECORDS_TOOL],
      tool_choice: { type: 'tool', name: TOOL_NAME }
    })

    const toolInput = response.content.find((block): block is ToolUseBlock => isToolUseBlock(block) && block.name === TOOL_NAME)?.input
    if (!toolInput) return []
    return coerceExtractionResult(toolInput, resolvedContext)
  } catch (error) {
    console.error('[claude-memory] extractRecords failed:', error)
    return []
  }
}

async function getCachedDomainExamples(limit: number, config: Config): Promise<DomainExample[]> {
  const now = Date.now()
  const cacheKey = `${config.milvus.address}|${config.milvus.collection}|${limit}`
  if (cachedDomainExamples
    && cachedDomainExamples.cacheKey === cacheKey
    && now - cachedDomainExamples.fetchedAt < DOMAIN_EXAMPLES_TTL_MS) {
    return cachedDomainExamples.examples
  }

  const examples = await getDomainExamples(limit, config)
  cachedDomainExamples = { fetchedAt: now, cacheKey, examples }
  return examples
}

export async function rateInjectedMemories(
  transcript: Transcript,
  injectedMemories: InjectedMemoryEntry[],
  config: Config = DEFAULT_CONFIG
): Promise<string[]> {
  if (injectedMemories.length === 0) return []

  const client = await createAnthropicClient()
  if (!client) {
    throw new Error('No authentication available for usefulness rating. Set ANTHROPIC_API_KEY or run kira login.')
  }

  const userPrompt = buildUsefulnessPrompt(transcript, injectedMemories)

  const response = await client.messages.create({
    model: config.extraction.model,
    max_tokens: Math.min(USEFULNESS_MAX_TOKENS, config.extraction.maxTokens),
    temperature: 0,
    system: [
      { type: 'text', text: CLAUDE_CODE_SYSTEM_PROMPT },
      { type: 'text', text: USEFULNESS_SYSTEM_PROMPT }
    ],
    messages: [{ role: 'user', content: userPrompt }],
    tools: [EMIT_USEFULNESS_TOOL],
    tool_choice: { type: 'tool', name: USEFULNESS_TOOL_NAME }
  })

  const toolInput = response.content.find((block): block is ToolUseBlock =>
    isToolUseBlock(block) && block.name === USEFULNESS_TOOL_NAME
  )?.input
  if (!toolInput) {
    throw new Error('Usefulness tool call missing in response.')
  }

  const allowedIds = new Set(injectedMemories.map(entry => entry.id))
  return coerceUsefulnessResult(toolInput, allowedIds)
}

function buildUserPrompt(transcript: Transcript, context: ExtractionContext): string {
  const project = context.project ?? context.cwd ?? 'unknown'
  const cwd = context.cwd ?? 'unknown'
  const transcriptText = formatTranscript(transcript.events, MAX_TRANSCRIPT_CHARS)

  return `Context:
- session_id: ${context.sessionId}
- project: ${project}
- cwd: ${cwd}
- transcript_path: ${context.transcriptPath ?? 'unknown'}
- intent: ${context.intent ?? 'unknown'}

Extraction guidance:
1) CommandRecord: for notable shell commands with meaningful outcomes. Skip routine commands
   like "pnpm build" or "git status" unless they revealed something important.
2) ErrorRecord: include exact error text + resolution if a fix was found.
3) DiscoveryRecord: durable factual discoveries. Prioritize project-level context:
   - Architecture & tech stack ("SvelteKit 2 with Svelte 5 runes, Supabase backend")
   - Key patterns & conventions ("API routes at /api/[resource]/+server.ts")
   - Important dependencies & integrations ("uses TanStack Query for data fetching")
   - Project structure insights ("tests in /tests, e2e uses Playwright")
   Also include specific tool/config discoveries when genuinely useful.
4) ProcedureRecord: step-by-step procedures with exact commands.
5) WarningRecord: extract when Claude learns something doesn't work.
   - avoid: the approach that failed (be specific)
   - useInstead: what works instead
   - reason: why it fails (error message, behavior issue)
   - severity: "caution" (minor inconvenience), "warning" (will fail), "critical" (data loss/security)
   Example: "Don't use 'npm run build' in this project, use 'npm run build:prod' (deprecated script)"

Formatting rules:
- Keep command and errorText EXACT (verbatim).
- Use short, specific intent strings.
- If exit code is not explicit, infer 0 for success and 1 for failure.
- Do not include the "[truncated]" marker in extracted fields.
- sourceExcerpt MUST be a verbatim quote from the transcript above that justifies this extraction.
- If no transcript segment directly supports the extraction, do not extract the record.

Transcript:
${transcriptText}
`
}

function buildUsefulnessPrompt(transcript: Transcript, injectedMemories: InjectedMemoryEntry[]): string {
  const transcriptText = formatTranscript(transcript.events, MAX_USEFULNESS_TRANSCRIPT_CHARS)
  const memoriesText = injectedMemories.map(formatInjectedMemory).join('\n')

  return `Question: Which of these injected memories were actually used or helpful in solving the user's task?

Injected memories:
${memoriesText || '(none)'}

Transcript:
${transcriptText}
`
}

function formatInjectedMemory(entry: InjectedMemoryEntry): string {
  const injectedAt = new Date(entry.injectedAt).toISOString()
  const snippet = cleanInline(entry.snippet)
  return `- id: ${entry.id}\n  injected_at: ${injectedAt}\n  snippet: ${snippet}`
}

function formatTranscript(events: TranscriptEvent[], maxChars: number): string {
  const formatted: string[] = []
  for (const event of events) {
    const block = formatEvent(event)
    if (block) formatted.push(block)
  }

  let total = 0
  const selected: string[] = []
  for (let i = formatted.length - 1; i >= 0; i -= 1) {
    const block = formatted[i]
    const blockLength = block.length + 2
    if (total + blockLength > maxChars && selected.length > 0) break
    selected.push(block)
    total += blockLength
  }

  return selected.reverse().join('\n\n')
}

function formatEvent(event: TranscriptEvent): string | null {
  const cwd = event.cwd ? ` cwd=${event.cwd}` : ''
  switch (event.type) {
    case 'user':
      return `[User${cwd}]\n${event.text}`
    case 'assistant':
      return `[Assistant${cwd}]\n${event.text}`
    case 'tool_call': {
      const header = `[Tool Call${cwd}] name=${event.name}${event.id ? ` id=${event.id}` : ''}`
      const input = formatJson(event.input)
      const truncatedInput = input ? truncateBlock(input, MAX_TOOL_INPUT_CHARS) : undefined
      return truncatedInput ? `${header}\ninput:\n${truncatedInput}` : header
    }
    case 'tool_result': {
      const header = `[Tool Result${cwd}]${event.name ? ` name=${event.name}` : ''}${event.toolUseId ? ` id=${event.toolUseId}` : ''}`
      const meta = formatToolResultMeta(event.metadata, event.isError)
      const output = event.outputText?.trim()
      const parts = [header]
      if (meta) parts.push(`meta: ${meta}`)
      if (output) parts.push(`output:\n${output}`)
      return parts.join('\n')
    }
    default:
      return null
  }
}

function formatToolResultMeta(meta: unknown, isError?: boolean): string | undefined {
  const parts: string[] = []
  if (isError) parts.push('isError=true')
  if (!meta || typeof meta !== 'object') return parts.length > 0 ? parts.join(', ') : undefined

  const record = meta as Record<string, unknown>
  const exitCode = record.exitCode
  if (typeof exitCode === 'number' && Number.isFinite(exitCode)) {
    parts.push(`exitCode=${Math.trunc(exitCode)}`)
  }
  if (record.interrupted === true) parts.push('interrupted=true')

  return parts.length > 0 ? parts.join(', ') : undefined
}

function formatJson(value: unknown): string | undefined {
  if (value === undefined) return undefined
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function truncateBlock(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  const head = value.slice(0, Math.max(0, maxLength - 200))
  const tail = value.slice(-200)
  return `${head}\n...[truncated]...\n${tail}`
}

function isToolUseBlock(value: unknown): value is ToolUseBlock {
  return (
    isPlainObject(value) &&
    value.type === 'tool_use' &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    'input' in value
  )
}

function coerceExtractionResult(input: unknown, context: ExtractionContext): MemoryRecord[] {
  if (!isPlainObject(input)) return []
  const rawRecords = Array.isArray(input.records) ? input.records : []
  const records: MemoryRecord[] = []

  for (const item of rawRecords) {
    if (!isPlainObject(item)) continue
    const type = asString(item.type)
    if (type === 'command') {
      const record = coerceCommandRecord(item, context)
      if (record) records.push(record)
      continue
    }
    if (type === 'error') {
      const record = coerceErrorRecord(item, context)
      if (record) records.push(record)
      continue
    }
    if (type === 'discovery') {
      const record = coerceDiscoveryRecord(item, context)
      if (record) records.push(record)
      continue
    }
    if (type === 'procedure') {
      const record = coerceProcedureRecord(item, context)
      if (record) records.push(record)
      continue
    }
    if (type === 'warning') {
      const record = coerceWarningRecord(item, context)
      if (record) records.push(record)
    }
  }

  return records
}

function coerceCommandRecord(input: Record<string, unknown>, context: ExtractionContext): CommandRecord | null {
  const commandRaw = asString(input.command)
  const command = commandRaw ? stripTruncationMarkers(commandRaw) : undefined
  const exitCodeRaw = asNumber(input.exitCode)
  const outcome = coerceOutcome(input.outcome)
  const sourceExcerptRaw = asString(input.sourceExcerpt)
  const sourceExcerpt = sourceExcerptRaw ? stripTruncationMarkers(sourceExcerptRaw) : undefined
  if (!command || exitCodeRaw === null || !outcome || !sourceExcerpt) return null

  const contextInput = isPlainObject(input.context) ? input.context : {}
  const project = pickProject(asString((contextInput as Record<string, unknown>).project), context)
  const cwd = asString((contextInput as Record<string, unknown>).cwd) ?? context.cwd ?? project
  const intentRaw = asString((contextInput as Record<string, unknown>).intent) ?? context.intent ?? 'unknown'
  const intent = stripNoiseWords(intentRaw)

  const record: CommandRecord = {
    id: randomUUID(),
    type: 'command',
    command,
    exitCode: Math.trunc(exitCodeRaw),
    outcome,
    sourceExcerpt,
    context: {
      project,
      cwd,
      intent: truncateIntent(intent)
    }
  }

  const scope = coerceScope(input.scope)
  if (scope) record.scope = scope

  const truncatedOutputRaw = asString(input.truncatedOutput)
  const truncatedOutput = truncatedOutputRaw ? stripTruncationMarkers(truncatedOutputRaw) : undefined
  if (truncatedOutput) {
    record.truncatedOutput = truncateOutput(truncatedOutput)
  }
  const resolution = asString(input.resolution)
  if (resolution) record.resolution = resolution

  const projectOverride = asString(input.project)
  if (projectOverride) record.project = projectOverride
  const domainOverride = asString(input.domain)
  if (domainOverride) record.domain = domainOverride

  return record
}

function coerceErrorRecord(input: Record<string, unknown>, context: ExtractionContext): ErrorRecord | null {
  const errorTextRaw = asString(input.errorText)
  const errorText = errorTextRaw ? stripTruncationMarkers(errorTextRaw) : undefined
  const errorType = asString(input.errorType)
  const resolution = asString(input.resolution)
  const sourceExcerptRaw = asString(input.sourceExcerpt)
  const sourceExcerpt = sourceExcerptRaw ? stripTruncationMarkers(sourceExcerptRaw) : undefined
  if (!errorText || !errorType || !resolution || !sourceExcerpt) return null

  const contextInput = isPlainObject(input.context) ? input.context : {}
  const project = pickProject(asString((contextInput as Record<string, unknown>).project), context)
  const record: ErrorRecord = {
    id: randomUUID(),
    type: 'error',
    errorText,
    errorType,
    resolution,
    sourceExcerpt,
    context: {
      project
    }
  }

  const scope = coerceScope(input.scope)
  if (scope) record.scope = scope

  const cause = asString(input.cause)
  if (cause) record.cause = cause

  const file = asString((contextInput as Record<string, unknown>).file)
  if (file) record.context.file = file
  const tool = asString((contextInput as Record<string, unknown>).tool)
  if (tool) record.context.tool = tool

  const projectOverride = asString(input.project)
  if (projectOverride) record.project = projectOverride
  const domainOverride = asString(input.domain)
  if (domainOverride) record.domain = domainOverride

  return record
}

function coerceDiscoveryRecord(input: Record<string, unknown>, context: ExtractionContext): DiscoveryRecord | null {
  const what = asString(input.what)
  const where = asString(input.where)
  const evidence = asString(input.evidence)
  const confidence = coerceConfidence(input.confidence)
  const sourceExcerptRaw = asString(input.sourceExcerpt)
  const sourceExcerpt = sourceExcerptRaw ? stripTruncationMarkers(sourceExcerptRaw) : undefined
  if (!what || !where || !evidence || !confidence || !sourceExcerpt) return null

  const record: DiscoveryRecord = {
    id: randomUUID(),
    type: 'discovery',
    what,
    where,
    evidence,
    confidence,
    sourceExcerpt
  }

  const scope = coerceScope(input.scope)
  if (scope) record.scope = scope

  const project = asString(input.project) ?? context.project ?? context.cwd
  if (project) record.project = project
  const domain = asString(input.domain) ?? context.domain
  if (domain) record.domain = domain

  return record
}

function coerceProcedureRecord(input: Record<string, unknown>, context: ExtractionContext): ProcedureRecord | null {
  const name = asString(input.name)
  const steps = coerceStringArray(input.steps)
  const sourceExcerptRaw = asString(input.sourceExcerpt)
  const sourceExcerpt = sourceExcerptRaw ? stripTruncationMarkers(sourceExcerptRaw) : undefined
  if (!name || steps.length === 0 || !sourceExcerpt) return null

  const contextInput = isPlainObject(input.context) ? input.context : {}
  const domain = asString((contextInput as Record<string, unknown>).domain) ?? context.domain ?? 'general'

  const record: ProcedureRecord = {
    id: randomUUID(),
    type: 'procedure',
    name,
    steps,
    sourceExcerpt,
    context: {
      domain
    }
  }

  const scope = coerceScope(input.scope)
  if (scope) record.scope = scope

  const project = pickProject(asString((contextInput as Record<string, unknown>).project), context)
  if (project) record.context.project = project

  const prerequisites = coerceStringArray(input.prerequisites)
  if (prerequisites.length > 0) record.prerequisites = prerequisites

  const verification = asString(input.verification)
  if (verification) record.verification = verification

  const projectOverride = asString(input.project)
  if (projectOverride) record.project = projectOverride
  const domainOverride = asString(input.domain)
  if (domainOverride) record.domain = domainOverride

  return record
}

function coerceWarningRecord(input: Record<string, unknown>, context: ExtractionContext): WarningRecord | null {
  const avoid = asString(input.avoid)
  const useInstead = asString(input.useInstead)
  const reason = asString(input.reason)
  const severity = coerceSeverity(input.severity)
  const sourceExcerptRaw = asString(input.sourceExcerpt)
  const sourceExcerpt = sourceExcerptRaw ? stripTruncationMarkers(sourceExcerptRaw) : undefined
  if (!avoid || !useInstead || !reason || !severity || !sourceExcerpt) return null

  const record: WarningRecord = {
    id: randomUUID(),
    type: 'warning',
    avoid,
    useInstead,
    reason,
    severity,
    sourceExcerpt,
    synthesizedAt: Date.now()
  }

  const scope = coerceScope(input.scope)
  if (scope) record.scope = scope

  const project = asString(input.project) ?? context.project ?? context.cwd
  if (project) record.project = project
  const domain = asString(input.domain) ?? context.domain
  if (domain) record.domain = domain

  return record
}

function coerceSeverity(value: unknown): WarningSeverity | null {
  if (value === 'caution' || value === 'warning' || value === 'critical') return value
  return null
}

function inferIntent(transcript: Transcript): string | undefined {
  for (let i = transcript.messages.length - 1; i >= 0; i -= 1) {
    const message = transcript.messages[i]
    if (message.role !== 'user') continue
    const text = message.text.trim()
    if (text) return text.slice(0, MAX_INTENT_CHARS)
  }
  return undefined
}

function cleanInline(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function truncateIntent(value: string): string {
  if (value.length <= MAX_INTENT_CHARS) return value
  return value.slice(0, MAX_INTENT_CHARS)
}

function truncateOutput(value: string): string {
  if (value.length <= MAX_TRUNCATED_OUTPUT_CHARS) return value
  const head = value.slice(0, Math.max(0, MAX_TRUNCATED_OUTPUT_CHARS - 300))
  const tail = value.slice(-300)
  return `${head}\n...[truncated]...\n${tail}`
}

function stripTruncationMarkers(value: string): string {
  return value
    .replace(/\.\.\.\s*\[truncated\]\s*\.\.\./gi, '')
    .replace(/\[truncated\]/gi, '')
    .trim()
}

function pickProject(project: string | undefined, context: ExtractionContext): string {
  return project ?? context.project ?? context.cwd ?? 'unknown'
}

function coerceScope(value: unknown): 'global' | 'project' | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (normalized === 'global' || normalized === 'project') return normalized
  return null
}

function coerceOutcome(value: unknown): CommandRecord['outcome'] | null {
  if (value === 'success' || value === 'failure' || value === 'partial') return value
  return null
}

function coerceConfidence(value: unknown): DiscoveryRecord['confidence'] | null {
  if (value === 'verified' || value === 'inferred' || value === 'tentative') return value
  return null
}

function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const items: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    if (!item.trim()) continue
    items.push(item)
  }
  return items
}

function coerceUsefulnessResult(input: unknown, allowedIds: Set<string>): string[] {
  if (!isPlainObject(input)) return []

  const rawIds = coerceStringArray((input as Record<string, unknown>).helpfulIds)
  const result: string[] = []
  const seen = new Set<string>()

  for (const id of rawIds) {
    if (!allowedIds.has(id)) continue
    if (seen.has(id)) continue
    seen.add(id)
    result.push(id)
  }

  return result
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
