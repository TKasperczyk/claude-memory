import fs from 'fs'
import path from 'path'
import { homedir, tmpdir } from 'os'
import type { RecordScope } from '../../shared/types.js'

function safeCanonicalizePath(targetPath: string): string {
  const resolvedPath = path.resolve(targetPath)
  try {
    return fs.realpathSync(resolvedPath)
  } catch {
    const suffixParts: string[] = []
    let current = resolvedPath
    while (true) {
      const parent = path.dirname(current)
      if (parent === current) return resolvedPath
      suffixParts.unshift(path.basename(current))
      current = parent
      try {
        return path.join(fs.realpathSync(current), ...suffixParts)
      } catch {
        // Continue walking up to deepest existing ancestor.
      }
    }
  }
}

export function isStrictCatchAllRoot(dirPath: string | undefined): boolean {
  if (!dirPath || !dirPath.trim()) return true
  const canonical = safeCanonicalizePath(dirPath)
  const home = safeCanonicalizePath(homedir())
  const sysTmp = safeCanonicalizePath(tmpdir())

  if (canonical === '/' || canonical === home) return true
  if (canonical === '/tmp' || canonical === '/var/tmp' || canonical === sysTmp) return true
  if (canonical === path.join(home, 'Downloads') || canonical === path.join(home, 'Desktop')) return true
  return false
}

/**
 * Detect catch-all directories (/home/<user>, /tmp, /tmp/*, /var/tmp*, /,
 * ~/Downloads, ~/Desktop) that should NOT be treated as a real project bucket
 * when no git root exists.
 */
export function isCatchAllDirectory(dirPath: string | undefined): boolean {
  if (isStrictCatchAllRoot(dirPath)) return true
  const canonical = safeCanonicalizePath(dirPath!)
  const sysTmp = safeCanonicalizePath(tmpdir())

  if (canonical.startsWith('/tmp/')) return true
  if (canonical.startsWith('/var/tmp/')) return true
  if (canonical.startsWith(`${sysTmp}${path.sep}`)) return true
  return false
}

export interface ScopeAttribution {
  scope: RecordScope
  project: string
  isCatchAll: boolean
}

/**
 * Resolve clean 3-tier scope attribution for writes and retrieval.
 * - Real git root (not `/` or `/home/<user>`): scope='project', project=gitRoot (even if checked out under /tmp)
 * - Non-catch-all cwd: scope='project', project=canonical(cwd)
 * - Catch-all (/home/<user>, /tmp/*, etc.) without git root: scope='environment', project=''
 */
export function resolveAttributionScope(
  cwd: string | undefined,
  gitRoot?: string | null
): ScopeAttribution {
  if (gitRoot && !isStrictCatchAllRoot(gitRoot)) {
    return { scope: 'project', project: safeCanonicalizePath(gitRoot), isCatchAll: false }
  }
  if (cwd && cwd.trim() && !isCatchAllDirectory(cwd)) {
    return { scope: 'project', project: safeCanonicalizePath(cwd), isCatchAll: false }
  }
  return { scope: 'environment', project: '', isCatchAll: true }
}

/**
 * Resolve retrieval scope: keeps exact project isolation for real repos and explicit
 * directories (including non-git project dirs under /tmp), while preventing
 * catch-all roots (/, /home/<user>, /tmp) from pulling or leaking arbitrary project buckets.
 */
export function resolveRetrievalScope(
  cwd: string | undefined,
  gitRoot?: string | null
): ScopeAttribution {
  if (gitRoot && !isStrictCatchAllRoot(gitRoot)) {
    return { scope: 'project', project: safeCanonicalizePath(gitRoot), isCatchAll: false }
  }
  if (cwd && cwd.trim() && !isStrictCatchAllRoot(cwd)) {
    return { scope: 'project', project: safeCanonicalizePath(cwd), isCatchAll: false }
  }
  return { scope: 'environment', project: '', isCatchAll: true }
}
