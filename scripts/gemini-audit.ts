/**
 * Gemini-powered memory audit script.
 *
 * Analyzes the entire memory pool using Gemini 3 Pro's 1M context window to identify:
 * - Duplicates that should be merged
 * - Conflicts where one memory should be removed/updated
 * - Redundant memories that should be removed
 *
 * Interactive mode allows reviewing and applying recommendations with backup.
 *
 * Usage:
 *   pnpm run audit              # Interactive mode
 *   pnpm run audit --auto       # Auto-apply all recommendations (deprecate, not delete)
 *   pnpm run audit -y           # Same as --auto
 */

import * as readline from 'readline'
import { writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { initMilvus, closeMilvus, iterateRecords, batchUpdateRecords, deleteRecord } from '../src/lib/milvus.js'
import { DEFAULT_CONFIG, type MemoryRecord } from '../src/lib/types.js'

const GEMINI_MODEL = 'gemini-3-pro-preview'
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models'

// Parse command line args
const AUTO_MODE = process.argv.includes('--auto') || process.argv.includes('-y')

// ANSI color codes
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>
    }
    finishReason?: string
  }>
  error?: { message: string; code: number }
}

interface DuplicateGroup {
  ids: string[]
  reason: string
  recommendation: string
}

interface Conflict {
  ids: string[]
  reason: string
  recommendation: string
  keepId?: string
}

interface Redundant {
  id: string
  reason: string
}

interface AuditResult {
  duplicates: DuplicateGroup[]
  conflicts: Conflict[]
  redundant: Redundant[]
  summary: string
}

function formatRecordForAudit(record: MemoryRecord): string {
  const lines: string[] = []
  lines.push(`[${record.id}] type=${record.type} scope=${record.scope ?? 'project'} project=${record.project ?? 'unknown'} domain=${record.domain ?? 'unknown'}`)

  switch (record.type) {
    case 'command':
      lines.push(`  command: ${record.command}`)
      lines.push(`  outcome: ${record.outcome}, exitCode: ${record.exitCode}`)
      if (record.resolution) lines.push(`  resolution: ${record.resolution}`)
      if (record.context?.intent) lines.push(`  intent: ${record.context.intent}`)
      break
    case 'error':
      lines.push(`  errorType: ${record.errorType}`)
      lines.push(`  errorText: ${record.errorText}`)
      if (record.cause) lines.push(`  cause: ${record.cause}`)
      lines.push(`  resolution: ${record.resolution}`)
      break
    case 'discovery':
      lines.push(`  what: ${record.what}`)
      lines.push(`  where: ${record.where}`)
      if (record.evidence) lines.push(`  evidence: ${record.evidence}`)
      lines.push(`  confidence: ${record.confidence}`)
      break
    case 'procedure':
      lines.push(`  name: ${record.name}`)
      lines.push(`  steps: ${record.steps.join(' → ')}`)
      if (record.prerequisites?.length) lines.push(`  prerequisites: ${record.prerequisites.join(', ')}`)
      break
    case 'warning':
      lines.push(`  avoid: ${record.avoid}`)
      lines.push(`  useInstead: ${record.useInstead}`)
      lines.push(`  reason: ${record.reason}`)
      lines.push(`  severity: ${record.severity}`)
      break
  }

  if (record.deprecated) lines.push(`  [DEPRECATED]`)
  return lines.join('\n')
}

async function callGemini(prompt: string, apiKey: string): Promise<string> {
  const url = `${GEMINI_API_URL}/${GEMINI_MODEL}:generateContent?key=${apiKey}`

  // 10 minute timeout for long thinking responses
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10 * 60 * 1000)

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: controller.signal,
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 65536,
        responseMimeType: 'application/json',
        thinkingConfig: { thinkingLevel: 'high' }
      }
    })
  })

  clearTimeout(timeout)

  if (!response.ok) {
    throw new Error(`Gemini API error (${response.status}): ${await response.text()}`)
  }

  const data = await response.json() as GeminiResponse
  if (data.error) throw new Error(`Gemini error: ${data.error.message}`)

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) throw new Error('No response from Gemini')
  return text
}

function buildPrompt(records: MemoryRecord[]): string {
  const formattedRecords = records.map(formatRecordForAudit).join('\n\n')

  return `You are analyzing a memory database for a coding assistant. The database stores learnings from past sessions including commands, errors, discoveries, procedures, and warnings.

Your task is to identify quality issues in the memory pool:

1. **DUPLICATES**: Memories that contain essentially the same information and should be merged into one. Look for:
   - Same error/resolution recorded multiple times
   - Same discovery stated differently
   - Same procedure with minor variations
   - Same warning about the same issue

2. **CONFLICTS**: Memories that contradict each other where one is likely outdated or wrong. Look for:
   - Contradictory advice about the same topic
   - Different resolutions for the same error that can't both be correct
   - Discoveries that state opposite facts
   - Procedures with conflicting steps

3. **REDUNDANT**: Memories that provide no value and should be removed. Look for:
   - Overly specific memories that won't generalize
   - Memories about temporary issues that are resolved
   - Memories that are subsumed by more comprehensive ones
   - Trivial information that any developer would know

Be conservative - only flag clear issues. When in doubt, leave memories alone.

For conflicts, indicate which memory should be kept (the more accurate/recent/comprehensive one).

Respond with a JSON object matching this schema:
{
  "duplicates": [
    {
      "ids": ["id1", "id2", ...],
      "reason": "why these are duplicates",
      "recommendation": "what the merged memory should contain"
    }
  ],
  "conflicts": [
    {
      "ids": ["id1", "id2"],
      "reason": "why these conflict",
      "recommendation": "how to resolve",
      "keepId": "id of the one to keep, if applicable"
    }
  ],
  "redundant": [
    {
      "id": "memory id",
      "reason": "why this should be removed"
    }
  ],
  "summary": "brief overall assessment of memory pool quality"
}

Here are all ${records.length} memories in the database:

${formattedRecords}`
}

function printHeader(text: string): void {
  const width = 70
  const line = '═'.repeat(width)
  console.log(`\n${c.cyan}╔${line}╗${c.reset}`)
  console.log(`${c.cyan}║${c.reset} ${c.bold}${text.padEnd(width - 1)}${c.reset}${c.cyan}║${c.reset}`)
  console.log(`${c.cyan}╚${line}╝${c.reset}`)
}

function printSubHeader(text: string): void {
  console.log(`\n${c.yellow}▸ ${c.bold}${text}${c.reset}`)
  console.log(`${c.dim}${'─'.repeat(68)}${c.reset}`)
}

function printStat(label: string, value: string | number, color: string = c.white): void {
  console.log(`  ${c.dim}•${c.reset} ${label.padEnd(25)} ${color}${c.bold}${value}${c.reset}`)
}

function printBox(title: string, content: string, borderColor: string = c.blue): void {
  const lines = content.split('\n')
  const maxLen = Math.max(title.length, ...lines.map(l => l.length), 60)
  const width = Math.min(maxLen + 4, 70)

  console.log(`${borderColor}┌${'─'.repeat(width)}┐${c.reset}`)
  console.log(`${borderColor}│${c.reset} ${c.bold}${title.padEnd(width - 1)}${c.reset}${borderColor}│${c.reset}`)
  console.log(`${borderColor}├${'─'.repeat(width)}┤${c.reset}`)
  for (const line of lines) {
    const truncated = line.length > width - 2 ? line.slice(0, width - 5) + '...' : line
    console.log(`${borderColor}│${c.reset} ${truncated.padEnd(width - 1)}${borderColor}│${c.reset}`)
  }
  console.log(`${borderColor}└${'─'.repeat(width)}┘${c.reset}`)
}

async function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise(resolve => {
    rl.question(`${c.cyan}?${c.reset} ${question} `, resolve)
  })
}

async function confirm(rl: readline.Interface, question: string): Promise<boolean> {
  const answer = await prompt(rl, `${question} ${c.dim}(y/n)${c.reset}`)
  return answer.toLowerCase().startsWith('y')
}

async function createBackup(records: MemoryRecord[]): Promise<string> {
  const backupDir = `${process.env.HOME}/.claude-memory/backups`
  if (!existsSync(backupDir)) {
    await mkdir(backupDir, { recursive: true })
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = `${backupDir}/memories-${timestamp}.json`

  await writeFile(backupPath, JSON.stringify(records, null, 2))
  return backupPath
}

async function applyDuplicates(
  duplicates: DuplicateGroup[],
  recordsById: Map<string, MemoryRecord>,
  resolveId: (partialId: string) => string | undefined,
  rl: readline.Interface
): Promise<number> {
  if (duplicates.length === 0) return 0

  printSubHeader(`DUPLICATES (${duplicates.length} groups)`)

  let applied = 0
  for (let i = 0; i < duplicates.length; i++) {
    const dup = duplicates[i]
    const validIds = dup.ids.map(id => resolveId(id)).filter((id): id is string => Boolean(id))
    if (validIds.length < 2) continue

    console.log(`\n${c.magenta}[${i + 1}/${duplicates.length}]${c.reset} ${c.bold}Duplicate Group${c.reset}`)
    console.log(`${c.dim}IDs:${c.reset} ${validIds.join(', ')}`)
    console.log(`${c.dim}Reason:${c.reset} ${dup.reason}`)
    console.log(`${c.dim}Recommendation:${c.reset} ${dup.recommendation}`)

    let choice = 'k'
    if (!AUTO_MODE) {
      const action = await prompt(rl, `${c.yellow}[K]eep first & deprecate rest, (s)kip, (q)uit?${c.reset}`)
      choice = action.toLowerCase() || 'k'
      if (choice === 'q') break
    }

    if (choice === 'k') {
      const [keepId, ...deprecateIds] = validIds
      const recordsToDeprecate = deprecateIds
        .map(id => recordsById.get(id))
        .filter((r): r is MemoryRecord => Boolean(r))
      await batchUpdateRecords(recordsToDeprecate, { deprecated: true }, DEFAULT_CONFIG)
      console.log(`${c.green}✓${c.reset} Kept ${keepId.slice(0, 8)}..., deprecated ${deprecateIds.length} others`)
      applied += deprecateIds.length
    }
  }
  return applied
}

async function applyConflicts(
  conflicts: Conflict[],
  recordsById: Map<string, MemoryRecord>,
  resolveId: (partialId: string) => string | undefined,
  rl: readline.Interface
): Promise<number> {
  if (conflicts.length === 0) return 0

  printSubHeader(`CONFLICTS (${conflicts.length})`)

  let applied = 0
  for (let i = 0; i < conflicts.length; i++) {
    const conflict = conflicts[i]
    const validIds = conflict.ids.map(id => resolveId(id)).filter((id): id is string => Boolean(id))
    if (validIds.length < 2) continue

    console.log(`\n${c.red}[${i + 1}/${conflicts.length}]${c.reset} ${c.bold}Conflict${c.reset}`)
    console.log(`${c.dim}IDs:${c.reset} ${validIds.join(', ')}`)
    console.log(`${c.dim}Reason:${c.reset} ${conflict.reason}`)
    console.log(`${c.dim}Recommendation:${c.reset} ${conflict.recommendation}`)
    const resolvedKeepId = conflict.keepId ? resolveId(conflict.keepId) : undefined
    if (resolvedKeepId) console.log(`${c.green}Suggested keep:${c.reset} ${resolvedKeepId}`)

    let choice = 'a'
    if (!AUTO_MODE) {
      const action = await prompt(rl, `${c.yellow}[A]pply suggestion, (s)kip, (q)uit?${c.reset}`)
      choice = action.toLowerCase() || 'a'
      if (choice === 'q') break
    }

    if (choice === 'a' && resolvedKeepId) {
      const deprecateIds = validIds.filter(id => id !== resolvedKeepId)
      const recordsToDeprecate = deprecateIds
        .map(id => recordsById.get(id))
        .filter((r): r is MemoryRecord => Boolean(r))
      await batchUpdateRecords(recordsToDeprecate, { deprecated: true }, DEFAULT_CONFIG)
      console.log(`${c.green}✓${c.reset} Kept ${conflict.keepId.slice(0, 8)}..., deprecated ${deprecateIds.length} others`)
      applied += deprecateIds.length
    }
  }
  return applied
}

async function applyRedundant(
  redundant: Redundant[],
  recordsById: Map<string, MemoryRecord>,
  resolveId: (partialId: string) => string | undefined,
  rl: readline.Interface
): Promise<{ deprecated: number; deleted: number }> {
  if (redundant.length === 0) return { deprecated: 0, deleted: 0 }

  printSubHeader(`REDUNDANT (${redundant.length} memories)`)

  console.log(`\n${c.dim}Sample of redundant memories:${c.reset}`)
  for (const item of redundant.slice(0, 5)) {
    const fullId = resolveId(item.id)
    if (!fullId) continue
    console.log(`  ${c.red}•${c.reset} ${fullId.slice(0, 8)}... - ${item.reason}`)
  }
  if (redundant.length > 5) {
    console.log(`  ${c.dim}... and ${redundant.length - 5} more${c.reset}`)
  }

  let choice = 'd'
  if (!AUTO_MODE) {
    const action = await prompt(rl, `\n${c.yellow}[d]eprecate all, (D)elete all permanently, (s)kip?${c.reset}`)
    choice = action || 'd'
  }

  if (choice === 'd') {
    const recordsToDeprecate = redundant
      .map(r => resolveId(r.id))
      .filter((id): id is string => Boolean(id))
      .map(id => recordsById.get(id))
      .filter((r): r is MemoryRecord => Boolean(r))

    // Batch in chunks of 100
    for (let i = 0; i < recordsToDeprecate.length; i += 100) {
      const chunk = recordsToDeprecate.slice(i, i + 100)
      await batchUpdateRecords(chunk, { deprecated: true }, DEFAULT_CONFIG)
      process.stdout.write(`\r${c.green}✓${c.reset} Deprecated ${Math.min(i + 100, recordsToDeprecate.length)}/${recordsToDeprecate.length}`)
    }
    console.log('')
    return { deprecated: recordsToDeprecate.length, deleted: 0 }
  }

  if (choice === 'D') {
    const confirmed = await confirm(rl, `${c.bgRed}${c.white} WARNING ${c.reset} This will ${c.red}permanently delete${c.reset} ${redundant.length} memories. Are you sure?`)
    if (confirmed) {
      const validIds = redundant.map(r => resolveId(r.id)).filter((id): id is string => Boolean(id))
      for (let i = 0; i < validIds.length; i++) {
        await deleteRecord(validIds[i], DEFAULT_CONFIG)
        if (i % 10 === 0) {
          process.stdout.write(`\r${c.red}✗${c.reset} Deleted ${i + 1}/${validIds.length}`)
        }
      }
      console.log(`\r${c.red}✗${c.reset} Deleted ${validIds.length}/${validIds.length}`)
      return { deprecated: 0, deleted: validIds.length }
    }
  }

  return { deprecated: 0, deleted: 0 }
}

async function main(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    console.error(`${c.red}Error:${c.reset} GEMINI_API_KEY environment variable required`)
    process.exit(1)
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  })

  try {
    printHeader('GEMINI MEMORY AUDIT')

    console.log(`\n${c.dim}Connecting to Milvus...${c.reset}`)
    await initMilvus(DEFAULT_CONFIG)

    console.log(`${c.dim}Loading active memories (excluding deprecated)...${c.reset}`)
    const records: MemoryRecord[] = []
    // Include embeddings - required for batchUpdateRecords to rebuild rows
    for await (const record of iterateRecords({ includeEmbeddings: true }, DEFAULT_CONFIG)) {
      if (!record.deprecated) {
        records.push(record)
      }
    }

    const recordsById = new Map(records.map(r => [r.id, r]))

    // Gemini often truncates UUIDs - build prefix index for fuzzy matching
    const resolveId = (partialId: string): string | undefined => {
      if (recordsById.has(partialId)) return partialId
      // Try prefix match
      for (const fullId of recordsById.keys()) {
        if (fullId.startsWith(partialId)) return fullId
      }
      return undefined
    }

    printStat('Total memories', records.length, c.cyan)
    printStat('Prompt size', `~${Math.ceil(buildPrompt(records).length / 4).toLocaleString()} tokens`, c.yellow)

    console.log(`\n${c.dim}Calling Gemini (${GEMINI_MODEL})...${c.reset}`)
    console.log(`${c.dim}This may take a few minutes...${c.reset}`)

    const startTime = Date.now()
    const response = await callGemini(buildPrompt(records), apiKey)
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)

    console.log(`${c.green}✓${c.reset} Response received in ${elapsed}s`)

    let result: AuditResult
    try {
      result = JSON.parse(response) as AuditResult
    } catch {
      console.error(`${c.red}Failed to parse response as JSON${c.reset}`)
      console.log(response)
      process.exit(1)
    }

    // Save results
    const resultsFile = `gemini-audit-${new Date().toISOString().slice(0, 10)}.json`
    await writeFile(resultsFile, JSON.stringify(result, null, 2))

    // Display summary
    printHeader('AUDIT RESULTS')

    printBox('Summary', result.summary, c.blue)

    console.log('')
    const totalDupMemories = result.duplicates.reduce((sum, d) => sum + d.ids.length, 0)
    const totalConflictMemories = result.conflicts.reduce((sum, c) => sum + c.ids.length, 0)

    printStat('Duplicate groups', `${result.duplicates.length} (${totalDupMemories} memories)`, c.yellow)
    printStat('Conflicts', `${result.conflicts.length} (${totalConflictMemories} memories)`, c.red)
    printStat('Redundant', result.redundant.length, c.magenta)

    const totalFlagged = new Set([
      ...result.duplicates.flatMap(d => d.ids),
      ...result.conflicts.flatMap(c => c.ids),
      ...result.redundant.map(r => r.id)
    ]).size

    printStat('Total flagged', `${totalFlagged} (${((totalFlagged / records.length) * 100).toFixed(1)}%)`, c.cyan)
    printStat('Results saved to', resultsFile, c.dim)

    // Interactive application
    printHeader('APPLY RECOMMENDATIONS')

    const shouldApply = AUTO_MODE || await confirm(rl, 'Would you like to review and apply recommendations?')
    if (AUTO_MODE) {
      console.log(`${c.cyan}Auto mode enabled${c.reset} - applying all recommendations`)
    }

    if (shouldApply) {
      // Create backup first
      console.log(`\n${c.dim}Creating backup...${c.reset}`)
      const backupPath = await createBackup(records)
      console.log(`${c.green}✓${c.reset} Backup saved to ${c.dim}${backupPath}${c.reset}`)

      let totalDeprecated = 0
      let totalDeleted = 0

      // Apply duplicates
      totalDeprecated += await applyDuplicates(result.duplicates, recordsById, resolveId, rl)

      // Apply conflicts
      totalDeprecated += await applyConflicts(result.conflicts, recordsById, resolveId, rl)

      // Apply redundant
      const redundantResult = await applyRedundant(result.redundant, recordsById, resolveId, rl)
      totalDeprecated += redundantResult.deprecated
      totalDeleted += redundantResult.deleted

      // Final summary
      printHeader('CHANGES APPLIED')
      printStat('Deprecated', totalDeprecated, c.yellow)
      printStat('Deleted', totalDeleted, c.red)
      printStat('Backup location', backupPath, c.dim)
    }

    await closeMilvus()

    printHeader('AUDIT COMPLETE')

  } finally {
    rl.close()
  }
}

main().catch(err => {
  console.error(`${c.red}Error:${c.reset}`, err)
  process.exit(1)
})
