/**
 * Apply recommendations from a saved Gemini audit JSON file.
 *
 * Usage: npx tsx scripts/apply-audit.ts <audit-file.json>
 */

import * as readline from 'readline'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { initLanceDB, closeLanceDB, iterateRecords, batchUpdateRecords, deleteRecord } from '../src/lib/lancedb.js'
import { DEFAULT_CONFIG, type MemoryRecord } from '../src/lib/types.js'

// ANSI color codes
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  bgRed: '\x1b[41m',
  white: '\x1b[37m',
}

interface AuditResult {
  duplicates: Array<{ ids: string[]; reason: string; recommendation: string }>
  conflicts: Array<{ ids: string[]; reason: string; recommendation: string; keepId?: string }>
  redundant: Array<{ id: string; reason: string }>
  summary: string
}

function printHeader(text: string): void {
  const width = 70
  const line = '═'.repeat(width)
  console.log(`\n${c.cyan}╔${line}╗${c.reset}`)
  console.log(`${c.cyan}║${c.reset} ${c.bold}${text.padEnd(width - 1)}${c.reset}${c.cyan}║${c.reset}`)
  console.log(`${c.cyan}╚${line}╝${c.reset}`)
}

function printStat(label: string, value: string | number, color: string = c.white): void {
  console.log(`  ${c.dim}•${c.reset} ${label.padEnd(25)} ${color}${c.bold}${value}${c.reset}`)
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

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const autoMode = args.includes('--auto')
  const auditFile = args.find(arg => !arg.startsWith('--'))

  if (!auditFile) {
    console.error(`${c.red}Error:${c.reset} Usage: npx tsx scripts/apply-audit.ts <audit-file.json> [--auto]`)
    console.error(`${c.dim}  --auto: automatically deprecate all redundant records without prompting${c.reset}`)
    process.exit(1)
  }

  if (!existsSync(auditFile)) {
    console.error(`${c.red}Error:${c.reset} File not found: ${auditFile}`)
    process.exit(1)
  }

  const rl = autoMode ? null : readline.createInterface({
    input: process.stdin,
    output: process.stdout
  })

  try {
    printHeader('APPLY AUDIT RECOMMENDATIONS')

    // Load audit results
    const auditJson = await readFile(auditFile, 'utf-8')
    const result: AuditResult = JSON.parse(auditJson)

    console.log(`\n${c.dim}Loaded audit results from: ${auditFile}${c.reset}`)

    const totalDupMemories = result.duplicates.reduce((sum, d) => sum + d.ids.length, 0)
    const totalConflictMemories = result.conflicts.reduce((sum, c) => sum + c.ids.length, 0)

    printStat('Duplicate groups', `${result.duplicates.length} (${totalDupMemories} memories)`, c.yellow)
    printStat('Conflicts', `${result.conflicts.length} (${totalConflictMemories} memories)`, c.red)
    printStat('Redundant', result.redundant.length, c.red)

    // Connect to LanceDB
    console.log(`\n${c.dim}Connecting to LanceDB...${c.reset}`)
    await initLanceDB(DEFAULT_CONFIG)

    console.log(`${c.dim}Loading all memories...${c.reset}`)
    const records: MemoryRecord[] = []
    for await (const record of iterateRecords({}, DEFAULT_CONFIG)) {
      records.push(record)
    }
    const recordsById = new Map(records.map(r => [r.id, r]))

    printStat('Total memories', records.length, c.cyan)

    // Check which IDs still exist
    const redundantIds = result.redundant.map(r => r.id)
    const existingRedundant = redundantIds.filter(id => recordsById.has(id))
    const alreadyGone = redundantIds.length - existingRedundant.length

    console.log('')
    printStat('Redundant (existing)', existingRedundant.length, c.yellow)
    if (alreadyGone > 0) {
      printStat('Already removed', alreadyGone, c.dim)
    }

    if (existingRedundant.length === 0) {
      console.log(`\n${c.green}✓${c.reset} All redundant memories have already been processed.`)
      await closeLanceDB()
      return
    }

    // Show sample
    console.log(`\n${c.dim}Sample of redundant memories to process:${c.reset}`)
    for (let i = 0; i < Math.min(10, result.redundant.length); i++) {
      const item = result.redundant[i]
      if (!recordsById.has(item.id)) continue
      const record = recordsById.get(item.id)!
      console.log(`  ${c.red}•${c.reset} ${item.id.slice(0, 8)}... [${record.type}] - ${item.reason}`)
    }
    if (result.redundant.length > 10) {
      console.log(`  ${c.dim}... and ${result.redundant.length - 10} more${c.reset}`)
    }

    // Ask what to do
    let choice: string
    if (autoMode) {
      console.log(`\n${c.yellow}Auto mode: deprecating all redundant records${c.reset}`)
      choice = 'd'
    } else {
      const action = await prompt(rl!, `\n${c.yellow}[d]eprecate all, (D)elete all permanently, (s)kip?${c.reset}`)
      choice = action || 'd'

      if (choice === 's') {
        console.log(`${c.dim}Skipped.${c.reset}`)
        await closeLanceDB()
        return
      }
    }

    // Create backup
    console.log(`\n${c.dim}Creating backup...${c.reset}`)
    const backupPath = await createBackup(records)
    console.log(`${c.green}✓${c.reset} Backup saved to ${c.dim}${backupPath}${c.reset}`)

    if (choice === 'd') {
      // Deprecate - fetch full records first
      const recordsToUpdate = existingRedundant.map(id => recordsById.get(id)!).filter(Boolean)

      console.log(`\n${c.yellow}Deprecating ${recordsToUpdate.length} records...${c.reset}`)

      const result = await batchUpdateRecords(recordsToUpdate, { deprecated: true }, DEFAULT_CONFIG)

      console.log(`${c.green}✓${c.reset} Deprecated ${result.updated}/${recordsToUpdate.length} records`)

      if (result.failed > 0) {
        console.log(`${c.red}✗${c.reset} Failed to update ${result.failed} records`)
      }

      printHeader('CHANGES APPLIED')
      printStat('Deprecated', result.updated, c.yellow)
      if (result.failed > 0) {
        printStat('Failed', result.failed, c.red)
      }
      printStat('Backup location', backupPath, c.dim)

    } else if (choice === 'D') {
      // Delete permanently
      const confirmed = autoMode ? false : await confirm(rl!, `${c.bgRed}${c.white} WARNING ${c.reset} This will ${c.red}permanently delete${c.reset} ${existingRedundant.length} memories. Are you sure?`)

      if (confirmed) {
        console.log(`\n${c.red}Deleting ${existingRedundant.length} records...${c.reset}`)

        for (let i = 0; i < existingRedundant.length; i++) {
          await deleteRecord(existingRedundant[i], DEFAULT_CONFIG)
          if (i % 10 === 0 || i === existingRedundant.length - 1) {
            process.stdout.write(`\r${c.red}✗${c.reset} Deleted ${i + 1}/${existingRedundant.length}`)
          }
        }
        console.log('')

        printHeader('CHANGES APPLIED')
        printStat('Deleted', existingRedundant.length, c.red)
        printStat('Backup location', backupPath, c.dim)
      } else {
        console.log(`${c.dim}Cancelled.${c.reset}`)
      }
    }

    await closeLanceDB()

  } finally {
    rl?.close()
  }
}

main().catch(err => {
  console.error(`${c.red}Error:${c.reset}`, err)
  process.exit(1)
})
