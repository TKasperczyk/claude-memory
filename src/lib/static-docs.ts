import fs from 'fs'
import os from 'os'
import path from 'path'
import { buildSearchText, truncateText } from './shared.js'
import type { MemoryRecord } from './types.js'

export interface StaticDocEntry {
  path: string
  label: string
  kind?: 'primary' | 'skill'
  content: string
  mtimeMs: number
  chunks: Array<{ text: string; tokens: Set<string> }>
}

export interface StaticDocSnapshot {
  entries: StaticDocEntry[]
  /** Compact digest suitable for injection into the extraction prompt so static facts aren't re-extracted. */
  digest: string
}

export interface LoadStaticProjectDocsOptions {
  homeDir?: string
}

const MAX_FILE_CHARS = 64_000
const MAX_SECTION_CHUNK_CHARS = 3_500
const MAX_TOTAL_DIGEST_CHARS = 6_000
const PRIMARY_DIGEST_BUDGET_WITH_SKILLS = 4_000
const MAX_PROJECT_SKILLS = 16
const MAX_GLOBAL_SKILLS = 32
const MIN_SKILL_DIGEST_CHARS = 100
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'do', 'for', 'from', 'has',
  'have', 'in', 'into', 'is', 'it', 'its', 'no', 'not', 'of', 'on', 'or', 'our',
  'that', 'the', 'their', 'this', 'to', 'use', 'using', 'via', 'we', 'when',
  'with', 'you', 'your', 'only', 'also', 'must', 'should', 'can', 'will'
])

type CachedDoc = {
  mtimeMs: number
  entry: StaticDocEntry
}

const docCache = new Map<string, CachedDoc>()

function tokenizeNormalized(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/[`*_#>\[\]()]/g, ' ')
    .match(/[a-z0-9_./:-]{3,}/g) ?? []
  const result = new Set<string>()
  for (const token of tokens) {
    const trimmed = token.replace(/^[-.:/]+|[-.:/]+$/g, '')
    if (trimmed.length < 3 || STOPWORDS.has(trimmed)) continue
    result.add(trimmed)
  }
  return result
}

function splitIntoChunks(content: string): Array<{ text: string; tokens: Set<string> }> {
  const chunks: Array<{ text: string; tokens: Set<string> }> = []
  // Include bounded markdown heading sections so multi-paragraph facts under one
  // heading (e.g. a SKILL.md or CLAUDE.md subsection) match cleanly without whole-file false positives.
  const headingSections = content.split(/(?=^#{1,3}\s)/m)
  if (headingSections.length > 1) {
    for (const section of headingSections) {
      const trimmedSection = section.trim()
      if (!trimmedSection || trimmedSection.length > MAX_SECTION_CHUNK_CHARS) continue
      chunks.push({ text: trimmedSection, tokens: tokenizeNormalized(trimmedSection) })
    }
  }
  // Split by blank lines and markdown list items/headings so individual facts can match cleanly
  const paragraphs = content.split(/\n{2,}/)
  for (const para of paragraphs) {
    const trimmed = para.trim()
    if (!trimmed) continue
    chunks.push({ text: trimmed, tokens: tokenizeNormalized(trimmed) })
    const lines = trimmed.split('\n')
    if (lines.length > 1) {
      for (const line of lines) {
        const clean = line.trim()
        if (clean.length >= 25) {
          chunks.push({ text: clean, tokens: tokenizeNormalized(clean) })
        }
      }
    }
  }
  return chunks
}

type CandidateFile = {
  path: string
  label: string
  kind: 'primary' | 'skill'
}

function loadSingleDoc(candidate: CandidateFile): StaticDocEntry | null {
  try {
    if (!fs.existsSync(candidate.path)) return null
    const stat = fs.statSync(candidate.path)
    if (!stat.isFile() || stat.size === 0) return null
    const cached = docCache.get(candidate.path)
    if (
      cached
      && cached.mtimeMs === stat.mtimeMs
      && cached.entry.label === candidate.label
      && cached.entry.kind === candidate.kind
    ) {
      return cached.entry
    }
    const raw = fs.readFileSync(candidate.path, 'utf-8')
    const content = truncateText(raw.trim(), MAX_FILE_CHARS)
    const entry: StaticDocEntry = {
      path: candidate.path,
      label: candidate.label,
      kind: candidate.kind,
      content,
      mtimeMs: stat.mtimeMs,
      chunks: splitIntoChunks(content)
    }
    docCache.set(candidate.path, { mtimeMs: stat.mtimeMs, entry })
    return entry
  } catch {
    return null
  }
}

function discoverSkillsInDir(
  skillsDir: string,
  formatLabel: (skillName: string) => string,
  maxSkills: number,
  push: (filePath: string, label: string, kind: 'primary' | 'skill') => void
): void {
  try {
    if (!fs.existsSync(skillsDir) || !fs.statSync(skillsDir).isDirectory()) return
    const names = fs.readdirSync(skillsDir).sort((a, b) => a.localeCompare(b))
    let added = 0
    for (const name of names) {
      if (added >= maxSkills) break
      if (!name || name.startsWith('.')) continue
      const skillPath = path.join(skillsDir, name, 'SKILL.md')
      try {
        const stat = fs.statSync(skillPath)
        if (!stat.isFile() || stat.size === 0) continue
      } catch {
        continue
      }
      push(skillPath, formatLabel(name), 'skill')
      added += 1
    }
  } catch {
    // ignore unreadable skill dirs
  }
}

function discoverCandidateFiles(
  projectRoot?: string,
  cwd?: string,
  homeDir: string = os.homedir()
): CandidateFile[] {
  const seen = new Set<string>()
  const files: CandidateFile[] = []
  const push = (filePath: string, label: string, kind: 'primary' | 'skill'): void => {
    const resolved = path.resolve(filePath)
    let dedupeKey = resolved
    try {
      dedupeKey = fs.realpathSync(resolved)
    } catch {
      // File may not exist or realpath may fail; fall back to path.resolve.
    }
    if (seen.has(dedupeKey)) return
    seen.add(dedupeKey)
    files.push({ path: resolved, label, kind })
  }

  const resolvedHome = path.resolve(homeDir)
  const dirs = Array.from(new Set([projectRoot, cwd].filter((d): d is string => Boolean(d && d.trim()))))
  for (const dir of dirs) {
    const resolvedDir = path.resolve(dir)
    const baseLabel = path.basename(resolvedDir) || resolvedDir
    push(path.join(resolvedDir, 'CLAUDE.md'), `${baseLabel}/CLAUDE.md`, 'primary')
    push(path.join(resolvedDir, 'AGENTS.md'), `${baseLabel}/AGENTS.md`, 'primary')

    // Avoid labeling ~/.claude/* under the home basename when cwd/projectRoot is $HOME.
    if (resolvedDir !== resolvedHome) {
      push(path.join(resolvedDir, '.claude', 'CLAUDE.md'), `${baseLabel}/.claude/CLAUDE.md`, 'primary')
      push(path.join(resolvedDir, '.claude', 'AGENTS.md'), `${baseLabel}/.claude/AGENTS.md`, 'primary')
      discoverSkillsInDir(
        path.join(resolvedDir, '.claude', 'skills'),
        name => `skill:${name}`,
        MAX_PROJECT_SKILLS,
        push
      )
    }
  }

  const homeClaudeDir = path.join(resolvedHome, '.claude')
  push(path.join(homeClaudeDir, 'CLAUDE.md'), '~/.claude/CLAUDE.md', 'primary')
  push(path.join(homeClaudeDir, 'AGENTS.md'), '~/.claude/AGENTS.md', 'primary')
  discoverSkillsInDir(
    path.join(homeClaudeDir, 'skills'),
    name => `~/.claude/skills/${name}/SKILL.md`,
    MAX_GLOBAL_SKILLS,
    push
  )

  return files
}

function extractFrontmatterDescription(frontmatter: string): string {
  const lines = frontmatter.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^description\s*:\s*(.*)$/.exec(lines[i])
    if (!match) continue
    const inline = match[1].trim()
    if (inline && !/^[|>][+-]?$/.test(inline)) {
      return inline.replace(/^["']|["']$/g, '').trim()
    }
    // Collect indented continuation lines for YAML block scalars (`description: >` / `|`)
    const blockLines: string[] = []
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j]
      if (!next.trim()) {
        if (blockLines.length > 0) blockLines.push('')
        continue
      }
      if (!/^\s+/.test(next)) break
      blockLines.push(next.trim())
    }
    const joined = blockLines.filter(Boolean).join(' ').trim()
    if (joined) return joined
  }
  return ''
}

function formatSkillForDigest(content: string, maxChars: number): string {
  const trimmed = content.trim()
  if (trimmed.length <= maxChars) return trimmed

  // Prefer YAML frontmatter description + markdown headings when compacting large SKILL.md files.
  const frontmatterMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(trimmed)
  if (!frontmatterMatch) {
    return truncateText(trimmed, maxChars)
  }

  const frontmatter = frontmatterMatch[1]
  const body = frontmatterMatch[2].trim()
  const description = extractFrontmatterDescription(frontmatter)
  const headings = body
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => /^#{1,3}\s+\S/.test(line))
    .slice(0, 6)

  const parts: string[] = []
  if (description) parts.push(description)
  if (headings.length > 0) parts.push(`Sections: ${headings.map(h => h.replace(/^#{1,3}\s+/, '')).join(' | ')}`)
  if (parts.length === 0) return truncateText(body || trimmed, maxChars)

  return truncateText(parts.join('\n'), maxChars)
}

function buildBudgetedDigest(entries: StaticDocEntry[]): string {
  if (entries.length === 0) return ''

  const primaryEntries = entries.filter(entry => entry.kind !== 'skill')
  const skillEntries = entries.filter(entry => entry.kind === 'skill')

  const sections: string[] = []
  let usedChars = 0

  const appendSection = (section: string, maxTotal: number): boolean => {
    const sepLen = sections.length > 0 ? 2 : 0
    const remaining = maxTotal - usedChars - sepLen
    if (remaining <= 20) return false
    const fitted = section.length <= remaining ? section : truncateText(section, remaining)
    sections.push(fitted)
    usedChars += sepLen + fitted.length
    return true
  }

  // Primary docs (CLAUDE.md, AGENTS.md, ~/.claude/CLAUDE.md, ~/.claude/AGENTS.md) get priority budget first.
  const primaryBudget = skillEntries.length > 0
    ? PRIMARY_DIGEST_BUDGET_WITH_SKILLS
    : MAX_TOTAL_DIGEST_CHARS

  if (primaryEntries.length > 0) {
    const perPrimaryCap = Math.max(400, Math.floor(primaryBudget / primaryEntries.length))
    for (const entry of primaryEntries) {
      const header = `--- ${entry.label} ---\n`
      const bodyCap = Math.max(120, perPrimaryCap - header.length)
      const section = `${header}${truncateText(entry.content, bodyCap)}`
      if (!appendSection(section, primaryBudget)) break
    }
  }

  // Unused primary budget rolls over to skills so large skill collections stay compact & bounded.
  if (skillEntries.length > 0) {
    const remainingForSkills = MAX_TOTAL_DIGEST_CHARS - usedChars
    const perSkillCap = Math.max(
      MIN_SKILL_DIGEST_CHARS,
      Math.floor(remainingForSkills / skillEntries.length)
    )
    let includedSkills = 0
    for (const entry of skillEntries) {
      const header = `--- ${entry.label} ---\n`
      const bodyCap = Math.max(60, perSkillCap - header.length)
      const section = `${header}${formatSkillForDigest(entry.content, bodyCap)}`
      const sepLen = sections.length > 0 ? 2 : 0
      // Reserve small tail if more skills remain after this one
      const moreRemaining = skillEntries.length - (includedSkills + 1)
      const reserveForNotice = moreRemaining > 0 ? 48 : 0
      if (usedChars + sepLen + Math.min(section.length, header.length + 40) + reserveForNotice > MAX_TOTAL_DIGEST_CHARS) {
        const omitted = skillEntries.length - includedSkills
        appendSection(`... (+${omitted} more skills indexed for overlap checks)`, MAX_TOTAL_DIGEST_CHARS)
        break
      }
      if (!appendSection(section, MAX_TOTAL_DIGEST_CHARS - reserveForNotice)) {
        const omitted = skillEntries.length - includedSkills
        appendSection(`... (+${omitted} more skills indexed for overlap checks)`, MAX_TOTAL_DIGEST_CHARS)
        break
      }
      includedSkills += 1
    }
  }

  return truncateText(sections.join('\n\n'), MAX_TOTAL_DIGEST_CHARS)
}

/**
 * Load Tier-0 static docs (CLAUDE.md, AGENTS.md, project skills, ~/.claude/CLAUDE.md,
 * ~/.claude/AGENTS.md, and ~/.claude/skills/<name>/SKILL.md) cached by mtime so
 * extraction and maintenance can reconcile against static instructions.
 */
export function loadStaticProjectDocs(
  projectRoot?: string,
  cwd?: string,
  options: LoadStaticProjectDocsOptions = {}
): StaticDocSnapshot {
  const candidates = discoverCandidateFiles(projectRoot, cwd, options.homeDir)
  const entries: StaticDocEntry[] = []

  for (const candidate of candidates) {
    const loaded = loadSingleDoc(candidate)
    if (loaded) entries.push(loaded)
  }

  if (entries.length === 0) {
    return { entries: [], digest: '' }
  }

  return { entries, digest: buildBudgetedDigest(entries) }
}

export interface StaticDocOverlapMatch {
  matchedFile: string
  matchedLabel: string
  overlapRatio: number
  matchedTokens: number
}

/**
 * Deterministic overlap check: returns a match when a memory record's core tokens
 * are already substantially covered by a Tier-0 static doc chunk (e.g. CLAUDE.md/AGENTS.md).
 */
export function findStaticDocOverlap(
  record: MemoryRecord,
  docs: StaticDocSnapshot,
  minContainment: number = 0.72,
  minMatchedTokens: number = 5
): StaticDocOverlapMatch | null {
  if (docs.entries.length === 0) return null

  const recordText = buildSearchText(record)
  const recordTokens = tokenizeNormalized(recordText)
  if (recordTokens.size < minMatchedTokens) return null

  let best: StaticDocOverlapMatch | null = null

  for (const entry of docs.entries) {
    for (const chunk of entry.chunks) {
      if (chunk.tokens.size < minMatchedTokens) continue
      let overlap = 0
      for (const token of recordTokens) {
        if (chunk.tokens.has(token)) overlap += 1
      }
      if (overlap < minMatchedTokens) continue
      const containment = overlap / recordTokens.size
      if (containment >= minContainment && (!best || containment > best.overlapRatio)) {
        best = {
          matchedFile: entry.path,
          matchedLabel: entry.label,
          overlapRatio: Number(containment.toFixed(3)),
          matchedTokens: overlap
        }
      }
    }
  }

  return best
}

export function clearStaticDocCache(): void {
  docCache.clear()
}
