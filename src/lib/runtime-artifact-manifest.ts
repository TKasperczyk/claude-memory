import type { HookEvent } from '../../shared/types.js'

export const DIST_DIRECTORY = 'dist'
export const HOOKS_DIRECTORY = 'hooks'
export const BUILD_STAMP_FILE = '.build-stamp.json'
export const MCP_SERVER_SCRIPT = 'mcp-server.js'
export const POST_SESSION_WORKER_SCRIPT = 'post-session-worker.js'

export const HOOK_SCRIPTS = {
  UserPromptSubmit: 'pre-prompt.js',
  SessionEnd: 'post-session.js',
  PreCompact: 'post-session.js'
} as const satisfies Record<HookEvent, string>

export function getHookArtifactRelativePath(script: string): string {
  return `${HOOKS_DIRECTORY}/${script}`
}

export function getDistArtifactRelativePath(relativePath: string): string {
  return `${DIST_DIRECTORY}/${relativePath}`
}

export const REQUIRED_DIST_ARTIFACTS = [
  ...new Set(Object.values(HOOK_SCRIPTS).map(getHookArtifactRelativePath)),
  getHookArtifactRelativePath(POST_SESSION_WORKER_SCRIPT),
  MCP_SERVER_SCRIPT
] as const
