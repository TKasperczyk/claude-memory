/**
 * Entity anchor handling.
 *
 * Entities are normalized identifiers (file paths, hostnames, service names,
 * CLI tools, project names) attached to memory records. They power two
 * mechanisms, both off by default:
 *  - entity-overlap relations (kind 'shares_entity') discovered by the
 *    maintenance runner and consumed by relation expansion (enableEntityEdges)
 *  - prompt-side entity needles appended to keyword queries (enableEntityKeywords)
 *
 * Record-side extraction/backfill and prompt-side needle extraction MUST
 * normalize identically, or overlap discovery and keyword matching silently
 * degrade — every entity string passes through normalizeEntity() before use.
 */

export const ENTITY_MIN_LENGTH = 3
export const ENTITY_MAX_LENGTH = 120
export const MAX_ENTITIES_PER_RECORD = 8

/**
 * Generic tech terms that would create meaningless entity overlap between
 * unrelated records. Deliberately small: document-frequency thresholds in the
 * discovery runner handle the long tail of common-but-unlisted terms.
 */
export const GENERIC_ENTITY_STOPLIST = new Set([
  'git', 'npm', 'pnpm', 'node', 'npx', 'bash', 'zsh', 'shell', 'linux',
  'file', 'server', 'error', 'command', 'config', 'json', 'http', 'https'
])

/**
 * Token pattern shared with fallback keyword extraction
 * (FALLBACK_TOKEN_PATTERN in retrieval.ts imports this).
 */
export const ENTITY_TOKEN_PATTERN = /[\p{L}\p{N}](?:[\p{L}\p{N}\p{M}._:/@+-]*[\p{L}\p{N}\p{M}])?/gu

const WRAPPING_PUNCTUATION = /^["'`]+|["'`]+$/g
const TRAILING_PUNCTUATION = /[.,:;]+$/

/**
 * Canonicalize a raw entity string. Returns null when the value is not a
 * usable entity (wrong type, too short/long, no letters, generic term).
 */
export function normalizeEntity(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  let stripped = raw.trim()
  // Quotes and trailing punctuation can nest ('"config.json".'), so strip
  // repeatedly until stable.
  for (let previous = ''; previous !== stripped; ) {
    previous = stripped
    stripped = stripped
      .replace(WRAPPING_PUNCTUATION, '')
      .replace(TRAILING_PUNCTUATION, '')
      .trim()
  }
  stripped = stripped.toLowerCase()
  if (stripped.length < ENTITY_MIN_LENGTH || stripped.length > ENTITY_MAX_LENGTH) return null
  if (!/\p{L}/u.test(stripped)) return null
  if (GENERIC_ENTITY_STOPLIST.has(stripped)) return null
  return stripped
}

/** Normalize a raw entity list: coerce, dedupe, cap. */
export function normalizeEntities(values: unknown, max = MAX_ENTITIES_PER_RECORD): string[] {
  if (!Array.isArray(values)) return []
  const seen = new Set<string>()
  const entities: string[] = []
  for (const value of values) {
    const entity = normalizeEntity(value)
    if (!entity || seen.has(entity)) continue
    seen.add(entity)
    entities.push(entity)
    if (entities.length >= max) break
  }
  return entities
}

/**
 * Extract entity-shaped keyword needles from an already noise-stripped prompt.
 * Deterministic, no LLM. Tokens are kept in priority order:
 *   1. pathish/dotted (paths, hostnames with dots, file extensions, module refs)
 *   2. acronyms and proper nouns
 *   3. hyphenated/underscored compounds (claude-memory, post_session)
 *   4. digit-bearing tokens (sha256, k8s)
 *   5. plain lowercase words — ONLY when present in the supplied corpus entity
 *      vocabulary (lowercase hostnames like `phantom` are indistinguishable
 *      from ordinary words by shape alone)
 * Without a vocabulary, tier 5 is skipped entirely rather than guessed at.
 */
export function extractEntityNeedles(
  cleanPrompt: string,
  maxNeedles: number,
  vocabulary?: ReadonlySet<string>
): string[] {
  if (maxNeedles <= 0) return []
  const tokens = cleanPrompt.normalize('NFC').match(ENTITY_TOKEN_PATTERN) ?? []
  const tiers: string[][] = [[], [], [], [], []]
  const seen = new Set<string>()

  for (const token of tokens) {
    const entity = normalizeEntity(token)
    if (!entity || seen.has(entity)) continue

    const tokenLength = Array.from(token).length
    const isPathish = /[/:\\]/.test(token) || /\.[A-Za-z0-9]/.test(token)
    const isAcronym = tokenLength >= 3 && /^\p{Lu}[\p{Lu}\p{N}_+-]+$/u.test(token)
    const isProperNoun = tokenLength >= 3 && /^\p{Lu}/u.test(token)
    const isCompound = /\p{L}[-_]\p{L}/u.test(token)
    const hasDigit = /\d/.test(token)

    let tier: number
    if (isPathish) tier = 0
    else if (isAcronym || isProperNoun) tier = 1
    else if (isCompound) tier = 2
    else if (hasDigit) tier = 3
    else if (vocabulary?.has(entity)) tier = 4
    else continue

    seen.add(entity)
    tiers[tier].push(entity)
  }

  return tiers.flat().slice(0, maxNeedles)
}

/**
 * Normalized inverse document frequency in [0, 1] for entity-overlap edge
 * weighting: 1 for entities appearing in ~2 records, decaying toward 0 as an
 * entity approaches the whole corpus. (The discovery runner skips entities
 * above 10% document frequency anyway, so only the high-IDF range matters.)
 */
export function computeEntityIdf(df: number, corpusSize: number): number {
  if (df <= 0 || corpusSize <= 2 || df >= corpusSize) return 0
  const idf = Math.log(corpusSize / df) / Math.log(corpusSize / 2)
  return Math.min(1, Math.max(0, idf))
}
