import { type MemoryRecord } from './types.js'

export const KNOWN_COMMANDS = new Set([
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'npx',
  'node',
  'deno',
  'python',
  'python3',
  'pip',
  'pip3',
  'uv',
  'poetry',
  'cargo',
  'rustc',
  'go',
  'dotnet',
  'mvn',
  'gradle',
  'javac',
  'java',
  'git',
  'docker',
  'kubectl',
  'helm',
  'terraform',
  'ansible',
  'make',
  'cmake',
  'ninja',
  'rg',
  'grep',
  'sed',
  'awk',
  'curl',
  'wget',
  'sudo',
  'env',
  'ssh',
  'scp',
  'systemctl',
  'journalctl',
  'ps',
  'kill',
  'chmod',
  'chown',
  'ls',
  'cat',
  'cp',
  'mv',
  'rm',
  'find'
])

export function normalizeStep(step: string): string {
  return step
    .replace(/^\s*[-*]\s+/, '')
    .replace(/^\s*\d+\.\s+/, '')
    .replace(/^\s*\d+\)\s+/, '')
    .replace(/^\s*[$>#]\s+/, '')
    .trim()
}

export function buildExactText(record: MemoryRecord): string {
  switch (record.type) {
    case 'command':
      return record.command
    case 'error':
      return record.errorText
    case 'discovery':
      return [record.what, record.where].filter(Boolean).join('\n')
    case 'procedure':
      return [record.name, ...record.steps].filter(Boolean).join('\n')
  }
}

export function normalizeExactText(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
}

export function escapeFilterValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}
