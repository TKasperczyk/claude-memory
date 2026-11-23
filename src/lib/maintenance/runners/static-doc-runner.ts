import fs from 'fs'
import path from 'path'
import { DEFAULT_CONFIG, type Config, type MemoryRecord } from '../../types.js'
import { findGitRoot } from '../../context.js'
import { batchUpdateRecords, fetchRecordsByIds } from '../../lancedb.js'
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

const CATCHALL_MIGRATION_BATCH_SIZE = 200

type CatchAllMigrationPlan =
  | { id: string; action: 'reattribute'; project: string }
  | { id: string; action: 'environment' }

function resolveGitRootForProjectPath(projectPath: string | undefined): string | null {
  if (!projectPath || isStrictCatchAllRoot(projectPath)) return null
  try {
    if (!fs.existsSync(projectPath)) return null
    const stat = fs.statSync(projectPath)
    const dir = stat.isDirectory() ? projectPath : path.dirname(projectPath)
    const gitRoot = findGitRoot(dir)
    if (gitRoot && !isStrictCatchAllRoot(gitRoot)) {
      return gitRoot
    }
  } catch {
    // ignore unreadable paths
  }
  return null
}

function recordAlreadyMatchesProject(record: MemoryRecord, project: string): boolean {
  const hasContextProject = 'context' in record && Boolean(record.context) && 'project' in record.context
  const contextMatches = !hasContextProject || (record.context as { project?: string }).project === project
  return record.project === project && contextMatches
}

/**
 * Safely migrate legacy project-scoped records attributed to catch-all directories
 * (/home/<user>, /tmp, /tmp/*, ~/Downloads) without re-embedding:
 * 1. If the record's own project path (e.g. a real git repo or subdirectory under /tmp/*)
 *    or referenced filesystem paths resolve to an existing git repository on disk,
 *    keep scope='project' and re-attribute it to that canonical git root.
 * 2. Otherwise promote to scope='environment' only when the record matches
 *    workstation/host/infrastructure signals (or when includeAllHomeRecords=true),
 *    so ad-hoc personal/Downloads notes never flood unrelated git repos.
 *
 * Uses a two-pass scan (metadata without embeddings, then bounded chunk hydration)
 * so large tables do not buffer all active vectors in memory.
 */
export async function migrateCatchAllScopeRecords(
  config: Config = DEFAULT_CONFIG,
  options: { dryRun?: boolean; includeAllHomeRecords?: boolean } = {}
): Promise<CatchAllScopeMigrationResult> {
  const active = await fetchRecords('deprecated = false', config, false)
  const plans: CatchAllMigrationPlan[] = []
  let skippedUnclassified = 0

  for (const record of active) {
    if (record.scope !== 'project' || !isCatchAllDirectory(record.project)) continue

    // A real git repo (or subdirectory / symlink inside one) checked out under /tmp/*
    // is a legitimate project scope (matches resolveAttributionScope) and must never be
    // promoted to 'environment'.
    const projectGitRoot = resolveGitRootForProjectPath(record.project)
    if (projectGitRoot) {
      if (!recordAlreadyMatchesProject(record, projectGitRoot)) {
        plans.push({ id: record.id, action: 'reattribute', project: projectGitRoot })
      }
      continue
    }

    const inferredRepo = inferRealGitRepoForRecord(record)
    if (inferredRepo) {
      if (!recordAlreadyMatchesProject(record, inferredRepo)) {
        plans.push({ id: record.id, action: 'reattribute', project: inferredRepo })
      }
      continue
    }

    if (options.includeAllHomeRecords || looksLikeWorkstationEnvironmentRecord(record)) {
      plans.push({ id: record.id, action: 'environment' })
      continue
    }

    skippedUnclassified += 1
  }

  if (options.dryRun || plans.length === 0) {
    return {
      scanned: active.length,
      migrated: plans.length,
      reattributedToProject: plans.filter(plan => plan.action === 'reattribute').length,
      promotedToEnvironment: plans.filter(plan => plan.action === 'environment').length,
      skippedUnclassified,
      failed: 0
    }
  }

  const planById = new Map(plans.map(plan => [plan.id, plan]))
  let migrated = 0
  let reattributedToProject = 0
  let promotedToEnvironment = 0
  let failed = 0

  for (let i = 0; i < plans.length; i += CATCHALL_MIGRATION_BATCH_SIZE) {
    const chunkPlans = plans.slice(i, i + CATCHALL_MIGRATION_BATCH_SIZE)
    const hydrated = await fetchRecordsByIds(
      chunkPlans.map(plan => plan.id),
      config,
      { includeEmbeddings: true }
    )
    const toPersist: MemoryRecord[] = []
    let chunkReattributed = 0
    let chunkPromoted = 0

    for (const record of hydrated) {
      const plan = planById.get(record.id)
      if (!plan) continue
      if (!Array.isArray(record.embedding) || record.embedding.length === 0) continue

      if (plan.action === 'reattribute') {
        const next: MemoryRecord = { ...record, scope: 'project' as const, project: plan.project }
        if ('context' in next && next.context && 'project' in next.context) {
          next.context = { ...next.context, project: plan.project }
        }
        toPersist.push(next)
        chunkReattributed += 1
      } else {
        const next: MemoryRecord = { ...record, scope: 'environment' as const, project: '' }
        if ('context' in next && next.context && 'project' in next.context) {
          next.context = { ...next.context, project: '' }
        }
        toPersist.push(next)
        chunkPromoted += 1
      }
    }

    if (toPersist.length === 0) continue
    const res = await batchUpdateRecords(toPersist, {}, config, { continueOnBatchError: true })
    migrated += res.updated
    failed += res.failed
    if (res.failed === 0) {
      reattributedToProject += chunkReattributed
      promotedToEnvironment += chunkPromoted
    } else {
      const failedIds = new Set((res.failures ?? []).flatMap(failure => failure.recordIds))
      for (const record of toPersist) {
        if (failedIds.has(record.id)) continue
        const plan = planById.get(record.id)
        if (plan?.action === 'reattribute') reattributedToProject += 1
        else if (plan?.action === 'environment') promotedToEnvironment += 1
      }
    }
  }

  return {
    scanned: active.length,
    migrated,
    reattributedToProject,
    promotedToEnvironment,
    skippedUnclassified,
    failed
  }
}
