import fs from 'fs'
import path from 'path'
import { DEFAULT_CONFIG, type Config, type MemoryRecord } from '../../types.js'
import { findGitRoot } from '../../context.js'
import { batchUpdateRecords } from '../../lancedb.js'
import { isCatchAllDirectory, isStrictCatchAllRoot } from '../../scope-attribution.js'
import { buildCandidateRecord, buildSearchText } from '../../shared.js'
import { findStaticDocOverlap, loadStaticProjectDocs } from '../../static-docs.js'
import { markDeprecated } from '../operations.js'
import { fetchRecords } from '../scans.js'
import type { MaintenanceAction, MaintenanceCandidateGroup } from '../../../../shared/types.js'
import { applyActionWithDryRun, buildActionFromRecord, buildErrorResult, buildResult } from './shared.js'
import type { MaintenanceRunResult } from './types.js'

const GRADUATION_MIN_USAGE_COUNT = 3

/**
 * Reconcile active memories against Tier-0 static docs (CLAUDE.md / AGENTS.md / skills):
 * 1. Deprecate active records already verbatim/near-verbatim covered by static docs.
 * 2. Surface high-usage proven discoveries/procedures/warnings as graduation candidates
 *    to promote into CLAUDE.md / skills (so static invariants move to Tier-0).
 */
export async function runStaticDocReconciliation(
  dryRun: boolean,
  config: Config = DEFAULT_CONFIG
): Promise<MaintenanceRunResult> {
  const actions: MaintenanceAction[] = []
  const candidateGroups: MaintenanceCandidateGroup[] = []
  let checked = 0
  let deprecated = 0
  let graduationSuggestions = 0
  let errors = 0

  try {
    const active = await fetchRecords('deprecated = false', config, false)
    checked = active.length

    const byProject = new Map<string, MemoryRecord[]>()
    for (const record of active) {
      const key = record.project && fs.existsSync(record.project) ? record.project : ''
      const list = byProject.get(key) ?? []
      list.push(record)
      byProject.set(key, list)
    }

    const coveredCandidates = []
    const graduationCandidates = []

    for (const [projectPath, records] of byProject) {
      const docs = loadStaticProjectDocs(projectPath || undefined)
      for (const record of records) {
        try {
          if (docs.entries.length > 0) {
            const overlap = findStaticDocOverlap(record, docs, 0.72, 6)
            if (overlap) {
              const reason = `covered-by-static-doc:${overlap.matchedLabel}`
              coveredCandidates.push(buildCandidateRecord(record, reason, {
                overlapRatio: overlap.overlapRatio,
                matchedTokens: overlap.matchedTokens
              }))
              const action = buildActionFromRecord({
                type: 'deprecate',
                record,
                reason,
                details: { matchedLabel: overlap.matchedLabel, overlapRatio: overlap.overlapRatio }
              })
              const applied = await applyActionWithDryRun(
                dryRun,
                actions,
                action,
                () => markDeprecated(record.id, config, { reason })
              )
              if (applied) deprecated += 1
              continue
            }
          }

          // Graduation loop: high-usage durable records are strong candidates to promote into CLAUDE.md / skills.
          if (
            (record.usageCount ?? 0) >= GRADUATION_MIN_USAGE_COUNT
            && record.volatility !== 'ephemeral'
            && (record.type === 'discovery' || record.type === 'procedure' || record.type === 'warning')
          ) {
            const usageCount = record.usageCount ?? 0
            const reason = `graduate-to-tier0:used ${usageCount}x`
            graduationCandidates.push(buildCandidateRecord(record, reason, { usageCount }))
            actions.push(buildActionFromRecord({
              type: 'suggestion',
              record,
              reason,
              details: { usageCount, targetDoc: projectPath ? `${projectPath}/CLAUDE.md` : '~/.claude/CLAUDE.md' }
            }))
            graduationSuggestions += 1
          }
        } catch {
          errors += 1
        }
      }
    }

    if (coveredCandidates.length > 0) {
      candidateGroups.push({
        id: 'static-doc-duplicates',
        label: 'Already covered by CLAUDE.md / AGENTS.md',
        records: coveredCandidates
      })
    }
    if (graduationCandidates.length > 0) {
      candidateGroups.push({
        id: 'static-doc-graduation',
        label: 'Graduation candidates for CLAUDE.md / skills',
        records: graduationCandidates
      })
    }
  } catch (error) {
    return buildErrorResult(actions, { checked, deprecated, graduationSuggestions, errors }, candidateGroups, error)
  }

  return buildResult(actions, { checked, deprecated, graduationSuggestions, errors }, candidateGroups)
}

export interface CatchAllScopeMigrationResult {
  scanned: number
  migrated: number
  reattributedToProject: number
  promotedToEnvironment: number
  skippedUnclassified: number
  failed: number
}

const ABS_PATH_CANDIDATE_REGEX = /\/(?:mnt|home|srv|opt|Users|tmp)\/[A-Za-z0-9._/-]+/g
const WORKSTATION_ENVIRONMENT_SIGNAL_REGEX = /\b(?:systemd|systemctl|journalctl|wireguard|wg-quick|wg0|tailscale|grub|kernel|iommu|edid|vfio|passthrough|pipewire|wireplumber|pulseaudio|alsa|bluez|bluetooth|udev|sway|hyprland|wayland|xorg|pacman|paru|yay|fstab|zfs|btrfs|nvme|mdadm|iptables|nftables|ufw|caddy|nginx|haproxy|dovecot|postfix|esxi|proxmox|sunshine|moonlight|ai-proxy|claude-memory|cc-conversation-search|localhost|127\.0\.0\.1|sshpass|sshd)\b|(?:^|[\s"'`(\[])(?:\/etc\/|\/usr\/|\/var\/|~\/\.config\/|\/home\/[^/\s]+\/\.config\/|(?:~\/|\/home\/[^/\s]+\/)?\.claude\/(?!projects\/))/i

function inferRealGitRepoForRecord(record: MemoryRecord): string | null {
  const haystacks: string[] = [buildSearchText(record)]
  if (record.sourceExcerpt) haystacks.push(record.sourceExcerpt)
  if ('where' in record && record.where) haystacks.push(record.where)
  if ('context' in record && record.context && 'file' in record.context && record.context.file) {
    haystacks.push(record.context.file)
  }

  const seen = new Set<string>()
  for (const text of haystacks) {
    const matches = text.match(ABS_PATH_CANDIDATE_REGEX) ?? []
    for (const rawPath of matches) {
      const candidate = rawPath.replace(/[.,;:)'"]+$/, '')
      if (!candidate || seen.has(candidate) || isStrictCatchAllRoot(candidate)) continue
      seen.add(candidate)
      try {
        if (!fs.existsSync(candidate)) continue
        const stat = fs.statSync(candidate)
        const dir = stat.isDirectory() ? candidate : path.dirname(candidate)
        const gitRoot = findGitRoot(dir)
        if (gitRoot && !isStrictCatchAllRoot(gitRoot)) {
          return gitRoot
        }
      } catch {
        // ignore unreadable paths
      }
    }
  }
  return null
}

function looksLikeWorkstationEnvironmentRecord(record: MemoryRecord): boolean {
  const text = `${buildSearchText(record)} ${record.sourceExcerpt ?? ''}`
  return WORKSTATION_ENVIRONMENT_SIGNAL_REGEX.test(text)
}

/**
 * Safely migrate legacy project-scoped records attributed to catch-all directories
 * (/home/<user>, /tmp, /tmp/*, ~/Downloads) without re-embedding:
 * 1. If a record references an existing git repository on disk, re-attribute it
 *    to that real project (keeping project isolation intact).
 * 2. Otherwise promote to scope='environment' only when the record matches
 *    workstation/host/infrastructure signals (or when includeAllHomeRecords=true),
 *    so ad-hoc personal/Downloads notes never flood unrelated git repos.
 */
export async function migrateCatchAllScopeRecords(
  config: Config = DEFAULT_CONFIG,
  options: { dryRun?: boolean; includeAllHomeRecords?: boolean } = {}
): Promise<CatchAllScopeMigrationResult> {
  const active = await fetchRecords('deprecated = false', config, true)
  const candidates = active.filter(record => {
    if (record.scope !== 'project' || !isCatchAllDirectory(record.project)) return false
    if (!Array.isArray(record.embedding) || record.embedding.length === 0) return false
    // A real git repo checked out under /tmp/* is a legitimate project scope (matches resolveAttributionScope).
    if (
      record.project
      && !isStrictCatchAllRoot(record.project)
      && fs.existsSync(record.project)
      && findGitRoot(record.project) === record.project
    ) {
      return false
    }
    return true
  })

  const updatedRecords: MemoryRecord[] = []
  let reattributedToProject = 0
  let promotedToEnvironment = 0
  let skippedUnclassified = 0

  for (const record of candidates) {
    const inferredRepo = inferRealGitRepoForRecord(record)
    if (inferredRepo) {
      const hasContextProject = 'context' in record && Boolean(record.context) && 'project' in record.context
      const contextMatches = !hasContextProject || (record.context as { project?: string }).project === inferredRepo
      if (record.project === inferredRepo && contextMatches) {
        continue
      }
      const next = { ...record, scope: 'project' as const, project: inferredRepo }
      if ('context' in next && next.context && 'project' in next.context) {
        next.context = { ...next.context, project: inferredRepo }
      }
      updatedRecords.push(next)
      reattributedToProject += 1
      continue
    }

    if (options.includeAllHomeRecords || looksLikeWorkstationEnvironmentRecord(record)) {
      const next = { ...record, scope: 'environment' as const, project: '' }
      if ('context' in next && next.context && 'project' in next.context) {
        next.context = { ...next.context, project: '' }
      }
      updatedRecords.push(next)
      promotedToEnvironment += 1
      continue
    }

    skippedUnclassified += 1
  }

  if (options.dryRun || updatedRecords.length === 0) {
    return {
      scanned: active.length,
      migrated: updatedRecords.length,
      reattributedToProject,
      promotedToEnvironment,
      skippedUnclassified,
      failed: 0
    }
  }

  const res = await batchUpdateRecords(updatedRecords, {}, config, { continueOnBatchError: true })
  return {
    scanned: active.length,
    migrated: res.updated,
    reattributedToProject,
    promotedToEnvironment,
    skippedUnclassified,
    failed: res.failed
  }
}
