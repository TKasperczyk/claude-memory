import fs from 'fs'
import path from 'path'
import {
  BUILD_STAMP_FILE,
  DIST_DIRECTORY,
  HOOKS_DIRECTORY,
  MCP_SERVER_SCRIPT,
  REQUIRED_DIST_ARTIFACTS
} from './runtime-artifact-manifest.js'

export * from './runtime-artifact-manifest.js'

export function getDistPath(projectRoot: string, outputDirectory: string = DIST_DIRECTORY): string {
  return path.resolve(projectRoot, outputDirectory)
}

export function getHooksPath(projectRoot: string): string {
  return path.join(getDistPath(projectRoot), HOOKS_DIRECTORY)
}

export function getHookScriptPath(projectRoot: string, script: string): string {
  return path.join(getHooksPath(projectRoot), script)
}

export function getMcpServerPath(projectRoot: string): string {
  return path.join(getDistPath(projectRoot), MCP_SERVER_SCRIPT)
}

export function getDistArtifactPath(
  projectRoot: string,
  relativePath: string,
  outputDirectory: string = DIST_DIRECTORY
): string {
  return path.join(getDistPath(projectRoot, outputDirectory), relativePath)
}

export function getBuildStampPath(
  projectRoot: string,
  outputDirectory: string = DIST_DIRECTORY
): string {
  return path.join(getDistPath(projectRoot, outputDirectory), BUILD_STAMP_FILE)
}

export function getMissingDistArtifacts(
  projectRoot: string,
  outputDirectory: string = DIST_DIRECTORY
): string[] {
  return REQUIRED_DIST_ARTIFACTS.filter(relativePath => {
    try {
      return !fs.statSync(
        getDistArtifactPath(projectRoot, relativePath, outputDirectory)
      ).isFile()
    } catch {
      return true
    }
  })
}
