import Anthropic from '@anthropic-ai/sdk'
import { randomUUID } from 'crypto'
import {
  DEFAULT_CONFIG,
  type CommandRecord,
  type Config,
  type DiscoveryRecord,
  type ErrorRecord,
  type InjectedMemoryEntry,
  type MemoryRecord,
  type ProcedureRecord,
  type TokenUsage,
  type WarningRecord
} from './types.js'
import type { Transcript, TranscriptEvent } from './transcript.js'
import { getDomainExamples, type DomainExample } from './milvus.js'
import { stripNoiseWords } from './context.js'
import { CLAUDE_CODE_SYSTEM_PROMPT, createAnthropicClient } from './anthropic.js'
import { getRecordSchemaOneOf } from './record-schema.js'
import { asConfidence, asOutcome, asScope, asSeverity, isToolUseBlock, type ToolUseBlock } from './parsing.js'
import { emptyTokenUsage, extractTokenUsage } from './token-usage.js'

export interface ExtractionContext {
  sessionId: string
  cwd: string
  project?: string
  transcriptPath?: string
  intent?: string
  domain?: string
  /** Memories that were injected during this session - used to detect outdated information */
  injectedMemories?: InjectedMemoryEntry[]
}

const TOOL_NAME = 'emit_records'
const USEFULNESS_TOOL_NAME = 'emit_usefulness'
const MAX_TRANSCRIPT_CHARS = 500000  // ~125k tokens, leaves room for system prompt + response in 200k context
const MAX_USEFULNESS_TRANSCRIPT_CHARS = 300000
const MAX_INTENT_CHARS = 400
const MAX_TRUNCATED_OUTPUT_CHARS = 20000
const MAX_TOOL_INPUT_CHARS = 12000
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

CRITICAL - Source Evidence (Citation Anchor):
- EVERY record MUST include a sourceExcerpt field that anchors the record to the transcript.
- sourceExcerpt points to WHERE in the transcript this knowledge came from.

For records with clear single sources (VERBATIM required):
- Commands: quote the tool result showing the command execution
- Errors: quote the error message itself
- These have unambiguous sources - copy them exactly.

For synthesized records (DESCRIPTIVE anchor allowed):
- Discoveries: may synthesize facts from multiple transcript locations
- Procedures: may combine steps mentioned in different places
- Warnings: may combine problem identification and solution from different moments
- For these, sourceExcerpt can be EITHER:
  a) A verbatim quote from the KEY MOMENT (preferred if one exists)
  b) A short descriptive anchor like "Assistant explanation after Edit to extract.ts" or "Discussion of reviewer validation issue"
- The anchor should help someone LOCATE the relevant part of the transcript.

General rules:
- sourceExcerpt does NOT need to contain every detail in the record.
- Other fields (what, evidence, steps) can synthesize broader context.
- If the record synthesizes from multiple places, anchor to the MOST IMPORTANT moment.
- If you cannot point to any transcript location, DO NOT extract that record.

CRITICAL - No Hallucination:
- All facts in the record (what, evidence, steps, etc.) must appear SOMEWHERE in the transcript.
- The evidence field can synthesize facts from multiple transcript locations, but every fact must be grounded in actual transcript content.
- Do NOT add specific values (colors, numbers, file names) unless they literally appear in the transcript.
- Do NOT describe sources incorrectly - if you didn't see "grep output", don't say "grep output shows".
- If the transcript says "uses orange theme", extract that - don't add HSL values you didn't see.
- When in doubt, include less detail rather than risk hallucination.

Priority guidance:
- Prefer extracting project-level context over routine commands.
- A single "project uses SvelteKit with Supabase" discovery is more valuable than 10 routine build commands.
- Focus on insights that would help orient a future session in this codebase.
- Extract warnings when there's a clear "don't do X, do Y instead" pattern.

Record consolidation:
- Prefer fewer, comprehensive records over many granular ones.
- If multiple related changes were made (e.g., fixing several aspects of a system), extract ONE discovery that captures the overall change with key details, not separate records for each file touched.
- A single "overhauled authentication system: added JWT tokens, refresh logic, and logout endpoint" is better than three separate discoveries.
- Do NOT extract both a warning AND a discovery for the same issue/fix. If a discovery documents a fix, don't also extract a warning about the original problem - the discovery already captures the lesson.

Iteration and refinement (CRITICAL):
- Sessions often involve iteration: initial approach → user feedback → refinements.
- ALWAYS extract the FINAL state, not intermediate attempts.
- When you see patterns like "change X to Y", "reduce the timeout", "add a retry loop":
  - The earlier value is obsolete - extract only the final value/step
- If code was modified multiple times, look at the LAST edit to determine actual behavior.
- If manual steps were later automated in the script, describe the automated behavior.
- sourceExcerpt must also reflect the final state - don't quote an earlier iteration.
  If feature A was added then replaced by feature B, quote the moment B was added.

External system bugs:
- When the transcript reveals a bug or unexpected behavior in an external tool/system (not the project being worked on), extract it as a warning with scope: "global".
- Example: "npm has race condition in postinstall scripts" or "Docker build cache invalidates unexpectedly".
- These are valuable because they help future sessions avoid the same debugging journey.

Information retrieval patterns (IMPORTANT):
- When Claude doesn't know where to find something and the user shows how to retrieve it, extract this as a discovery.
- The pattern: "user asks for X" → "Claude doesn't know where X is" → "user/skill reveals X is in Y" → EXTRACT "X can be found by querying Y"
- These should be scope: "global" since they apply across projects.
- The discovery should capture the RETRIEVAL METHOD, not just the content. If the content changes, the retrieval method stays valid.
- This is especially valuable for credentials, tokens, configs, and any information the user expects Claude to "just know".

Skip trivial commands:
- Do NOT extract routine/trivial commands: ls, cd, cat, pwd, echo, mkdir, rm, cp, mv, touch, head, tail, wc, grep (basic usage), find (basic usage), git status, git log, git diff, git branch, git checkout, npm/pnpm/yarn install/build/test (without special flags or unless they fail interestingly), tsc, basic file reads.
- Do NOT extract verification builds (pnpm build, npm run build, tsc) that just confirm code compiles - these are routine.
- Only extract commands that required problem-solving, had non-obvious flags/options, or produced unexpected results that led to learning.
- A command is worth extracting if a future session would benefit from knowing "this specific invocation worked" or "this flag combination solved a problem".

Scope guidance:
Set scope: "global" for knowledge that applies across projects:
- General CLI flags, common error patterns, language features
- Shared infrastructure: observability, CI/CD, deployment systems, monitoring
- Corporate tooling and services used across multiple projects
- External service endpoints, credentials, and configurations
- Platform/environment knowledge (Kubernetes, cloud providers, internal tools)

Keep scope: "project" (default) for:
- Project-specific architecture decisions and file locations
- Project-specific integrations or configurations
- Knowledge that only makes sense in context of this codebase
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

export async function extractRecords(
  transcript: Transcript,
  context: ExtractionContext,
  config: Config = DEFAULT_CONFIG
): Promise<{ records: MemoryRecord[]; tokenUsage: TokenUsage }> {
  const derivedIntent = context.intent ?? inferIntent(transcript) ?? 'unknown'
  const resolvedContext: ExtractionContext = {
    ...context,
    intent: truncateIntent(stripNoiseWords(derivedIntent))
  }

  try {
    const client = await createAnthropicClient()
    if (!client) {
      console.error('[claude-memory] No authentication available for extraction. Set ANTHROPIC_API_KEY or run kira login.')
      return { records: [], tokenUsage: emptyTokenUsage() }
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

    const tokenUsage = extractTokenUsage(response)
    const toolInput = response.content.find((block): block is ToolUseBlock => isToolUseBlock(block) && block.name === TOOL_NAME)?.input
    if (!toolInput) return { records: [], tokenUsage }
    return {
      records: coerceExtractionResult(toolInput, resolvedContext),
      tokenUsage
    }
  } catch (error) {
    console.error('[claude-memory] extractRecords failed:', error)
    return { records: [], tokenUsage: emptyTokenUsage() }
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
): Promise<{ helpfulIds: string[]; tokenUsage: TokenUsage }> {
  if (injectedMemories.length === 0) {
    return { helpfulIds: [], tokenUsage: emptyTokenUsage() }
  }

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

  const tokenUsage = extractTokenUsage(response)
  const toolInput = response.content.find((block): block is ToolUseBlock =>
    isToolUseBlock(block) && block.name === USEFULNESS_TOOL_NAME
  )?.input
  if (!toolInput) {
    console.warn('[claude-memory] Usefulness tool call missing in response; treating as no helpful memories.')
    return { helpfulIds: [], tokenUsage }
  }

  const allowedIds = new Set(injectedMemories.map(entry => entry.id))
  return {
    helpfulIds: coerceUsefulnessResult(toolInput, allowedIds),
    tokenUsage
  }
}

function buildUserPrompt(transcript: Transcript, context: ExtractionContext): string {
  const project = context.project ?? context.cwd ?? 'unknown'
  const cwd = context.cwd ?? 'unknown'
  const transcriptText = formatTranscript(transcript.events, MAX_TRANSCRIPT_CHARS)
  const priorKnowledgeSection = buildPriorKnowledgeSection(context.injectedMemories)

  return `Context:
- session_id: ${context.sessionId}
- project: ${project}
- cwd: ${cwd}
- transcript_path: ${context.transcriptPath ?? 'unknown'}
- intent: ${context.intent ?? 'unknown'}
${priorKnowledgeSection}
Extraction guidance:
1) CommandRecord: for notable shell commands with meaningful outcomes. Skip routine commands
   like "pnpm build" or "git status" unless they revealed something important.
2) ErrorRecord: include exact error text + resolution if a fix was found.
3) DiscoveryRecord: durable factual discoveries. Prioritize project-level context:
   - Architecture & tech stack ("SvelteKit 2 with Svelte 5 runes, Supabase backend")
   - Key patterns & conventions ("API routes at /api/[resource]/+server.ts")
   - Important dependencies & integrations ("uses TanStack Query for data fetching")
   - Project structure insights ("tests in /tests, e2e uses Playwright")
   - Bug fixes and solutions implemented ("added lock file mechanism to prevent duplicate extractions")
   - Design decisions and their rationale ("reviewer loads actual transcript for validation")
   - Configuration changes (model versions, thresholds, limits, environment settings)
   - Information retrieval patterns: WHERE to find credentials, tokens, configs, or other information
     (HIGH PRIORITY - capture the retrieval method, not just the content)
   Also include specific tool/config discoveries when genuinely useful.
   IMPORTANT: Extract BOTH problems found AND solutions implemented - don't just extract warnings about what's wrong.
4) ProcedureRecord: step-by-step procedures with exact commands.
   CRITICAL: Extract the FINAL working version after all refinements:
   - If parameters changed during the session, use the final values
   - If manual steps were automated, describe what the final code does
   - Include ALL steps from the final implementation, even those added mid-session
   - Trace through the final code/script to verify steps match actual behavior
   Also extract brief "how to" instructions that appear in assistant messages, e.g.:
   - "To enable dark mode, add class='dark' to the <html> element"
   - "To run in dev mode, use --watch flag"
   These are valuable even if they're single-step - they document non-obvious activation patterns.
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
- sourceExcerpt anchors the record to the transcript (verbatim for commands/errors, can be descriptive for discoveries/procedures/warnings).
- If no transcript location supports the extraction, do not extract the record.

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

function buildPriorKnowledgeSection(injectedMemories?: InjectedMemoryEntry[]): string {
  if (!injectedMemories || injectedMemories.length === 0) {
    return ''
  }

  const memoriesText = injectedMemories
    .map(entry => `- [${entry.id}] ${cleanInline(entry.snippet)}`)
    .join('\n')

  return `
Prior knowledge (memories injected during this session):
${memoriesText}

IMPORTANT - Duplicate prevention:
Do NOT extract records that duplicate information already captured in prior knowledge above.
If a discovery/procedure/warning is essentially the same as an injected memory, skip it entirely.
Only extract if:
- The information is NEW (not in prior knowledge)
- OR the transcript shows prior knowledge is OUTDATED/INCORRECT (use supersedes field)

IMPORTANT - Change detection:
If the transcript shows that any of the above prior knowledge is now OUTDATED, INCORRECT, or SUPERSEDED:
- Extract a new discovery or warning that captures the CURRENT correct information
- Set the "supersedes" field to the full UUID of the outdated memory (shown in brackets above)
- Keep sourceExcerpt as a verbatim transcript quote - do NOT put the supersedes ID there
- Example: if prior knowledge [b5049b3a-...] says "uses individual updateRecord calls" but transcript shows batch updates,
  extract a discovery with supersedes: "b5049b3a-..." and sourceExcerpt quoting the relevant transcript text
`
}

export function formatTranscript(events: TranscriptEvent[], maxChars: number): string {
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
  const outcome = asOutcome(input.outcome)
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

  const scope = asScope(input.scope)
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

  const scope = asScope(input.scope)
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
  const confidence = asConfidence(input.confidence)
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

  const scope = asScope(input.scope)
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

  const scope = asScope(input.scope)
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
  const severity = asSeverity(input.severity)
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

  const scope = asScope(input.scope)
  if (scope) record.scope = scope

  const project = asString(input.project) ?? context.project ?? context.cwd
  if (project) record.project = project
  const domain = asString(input.domain) ?? context.domain
  if (domain) record.domain = domain

  return record
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
