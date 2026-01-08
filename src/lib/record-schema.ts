/**
 * Single source of truth for record type schemas.
 * Used by both extraction (JSON schema) and review (human-readable description).
 */

import type Anthropic from '@anthropic-ai/sdk'

type JsonSchema = Anthropic.Tool['input_schema']

interface RecordTypeDefinition {
  /** JSON Schema for this record type (used in extraction tool) */
  schema: JsonSchema
  /** Human-readable field summary (used in review prompt) */
  description: string
}

/**
 * Common fields added to all record type schemas.
 * sourceExcerpt is REQUIRED - extraction must cite transcript evidence.
 */
const COMMON_OPTIONAL_PROPERTIES = {
  project: { type: 'string' },
  scope: { type: 'string', enum: ['global', 'project'] },
  domain: { type: 'string' }
} as const

const SOURCE_EXCERPT_PROPERTY = {
  sourceExcerpt: {
    type: 'string',
    description: 'Verbatim quote from transcript that supports this extraction (required for verification)'
  }
} as const

/**
 * Record type definitions.
 * Add new record types here - both extraction and review will automatically pick them up.
 */
export const RECORD_TYPE_DEFINITIONS: Record<string, RecordTypeDefinition> = {
  command: {
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'command', 'exitCode', 'context', 'outcome', 'sourceExcerpt'],
      properties: {
        type: { const: 'command' },
        command: { type: 'string' },
        exitCode: { type: 'number' },
        truncatedOutput: { type: 'string' },
        outcome: { type: 'string', enum: ['success', 'failure', 'partial'] },
        resolution: { type: 'string' },
        ...COMMON_OPTIONAL_PROPERTIES,
        ...SOURCE_EXCERPT_PROPERTY,
        context: {
          type: 'object',
          additionalProperties: false,
          required: ['project', 'cwd', 'intent'],
          properties: {
            project: { type: 'string' },
            cwd: { type: 'string' },
            intent: { type: 'string' }
          }
        }
      }
    },
    description: '{ command, exitCode, outcome, sourceExcerpt, truncatedOutput?, resolution?, context }'
  },

  error: {
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'errorText', 'errorType', 'resolution', 'context', 'sourceExcerpt'],
      properties: {
        type: { const: 'error' },
        errorText: { type: 'string' },
        errorType: { type: 'string' },
        cause: { type: 'string' },
        resolution: { type: 'string' },
        ...COMMON_OPTIONAL_PROPERTIES,
        ...SOURCE_EXCERPT_PROPERTY,
        context: {
          type: 'object',
          additionalProperties: false,
          required: ['project'],
          properties: {
            project: { type: 'string' },
            file: { type: 'string' },
            tool: { type: 'string' }
          }
        }
      }
    },
    description: '{ errorText, errorType, resolution, sourceExcerpt, cause?, context }'
  },

  discovery: {
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'what', 'where', 'evidence', 'confidence', 'sourceExcerpt'],
      properties: {
        type: { const: 'discovery' },
        what: { type: 'string' },
        where: { type: 'string' },
        evidence: { type: 'string' },
        confidence: { type: 'string', enum: ['verified', 'inferred', 'tentative'] },
        ...COMMON_OPTIONAL_PROPERTIES,
        ...SOURCE_EXCERPT_PROPERTY
      }
    },
    description: '{ what, where, evidence, confidence, sourceExcerpt }'
  },

  procedure: {
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'name', 'steps', 'context', 'sourceExcerpt'],
      properties: {
        type: { const: 'procedure' },
        name: { type: 'string' },
        steps: { type: 'array', items: { type: 'string' } },
        prerequisites: { type: 'array', items: { type: 'string' } },
        verification: { type: 'string' },
        ...COMMON_OPTIONAL_PROPERTIES,
        ...SOURCE_EXCERPT_PROPERTY,
        context: {
          type: 'object',
          additionalProperties: false,
          required: ['domain'],
          properties: {
            project: { type: 'string' },
            domain: { type: 'string' }
          }
        }
      }
    },
    description: '{ name, steps[], sourceExcerpt, prerequisites?, verification?, context }'
  },

  warning: {
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'avoid', 'useInstead', 'reason', 'severity', 'sourceExcerpt'],
      properties: {
        type: { const: 'warning' },
        avoid: { type: 'string', description: 'The anti-pattern or approach to avoid' },
        useInstead: { type: 'string', description: 'The recommended alternative' },
        reason: { type: 'string', description: 'Why the avoided approach fails' },
        severity: { type: 'string', enum: ['caution', 'warning', 'critical'] },
        ...COMMON_OPTIONAL_PROPERTIES,
        ...SOURCE_EXCERPT_PROPERTY
      }
    },
    description: '{ avoid, useInstead, reason, severity, sourceExcerpt }'
  }
}

/**
 * Get the list of valid record type names.
 */
export function getRecordTypes(): string[] {
  return Object.keys(RECORD_TYPE_DEFINITIONS)
}

/**
 * Generate the JSON schema oneOf array for the extraction tool.
 */
export function getRecordSchemaOneOf(): JsonSchema[] {
  return Object.values(RECORD_TYPE_DEFINITIONS).map(def => def.schema)
}

/**
 * Generate human-readable schema description for review prompts.
 */
export function getSchemaDescription(): string {
  return Object.entries(RECORD_TYPE_DEFINITIONS)
    .map(([type, def]) => `- ${type}: ${def.description}`)
    .join('\n')
}
