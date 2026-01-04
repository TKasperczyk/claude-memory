# Claude Memory - Technical Knowledge Persistence for Claude Code

## Problem Statement

Claude Code sessions are ephemeral. Technical knowledge discovered during sessions is lost unless manually preserved via:
- CLAUDE.md files (requires remembering to update)
- Skills (requires explicit creation)
- Mental notes (unreliable)

This creates friction when:
- Re-inspecting codebases repeatedly
- Solving the same errors multiple times
- Forgetting commands that worked before
- Losing context about system administration tasks

## Solution

An automatic technical memory system that:
1. **Extracts** structured knowledge from session transcripts (commands, errors, discoveries, procedures)
2. **Stores** with hybrid search capability (exact match + semantic)
3. **Injects** relevant prior knowledge into new sessions via hooks
4. **Maintains** validity over time (not recency-based decay)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          Claude Code Session                             │
│                                                                          │
│  UserPromptSubmit ─────────────────────────────────────────────────────┐│
│       │                                                                 ││
│       ▼                                                                 ││
│  ┌──────────────────┐      ┌─────────────────────────────────────────┐ ││
│  │ pre-prompt.ts    │      │            Claude Response              │ ││
│  │ Query memories   │      │                                         │ ││
│  │ Inject context   │      │  (uses injected context implicitly)     │ ││
│  └────────┬─────────┘      └─────────────────────────────────────────┘ ││
│           │                                                             ││
│           ▼ stdout → system context                                     ││
│  ┌──────────────────────────────────────────────────────────────────┐  ││
│  │ Injected prior knowledge about current project/error/task        │  ││
│  └──────────────────────────────────────────────────────────────────┘  ││
│                                                                         ││
│  SessionEnd ◄───────────────────────────────────────────────────────────┘│
│       │                                                                  │
│       ▼                                                                  │
│  ┌──────────────────┐                                                    │
│  │ post-session.ts  │                                                    │
│  │ Parse transcript │                                                    │
│  │ Extract records  │                                                    │
│  │ Store to Milvus  │                                                    │
│  └────────┬─────────┘                                                    │
└───────────┼──────────────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         Memory Store (Milvus)                            │
│                                                                          │
│  Collection: cc_memories                                                 │
│  - Hybrid search: vector (semantic) + scalar (keyword/exact)            │
│  - Project/domain scoping                                               │
│  - Success/failure tracking                                             │
└─────────────────────────────────────────────────────────────────────────┘
            │
            │ Periodic (cron/systemd timer)
            ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      Maintenance Process                                 │
│                                                                          │
│  - Consolidate similar records                                          │
│  - Validity-based decay (not recency)                                   │
│  - Suggest CLAUDE.md updates for high-value patterns                    │
│  - Suggest Skill creation for repeated procedures                       │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Record Types

### CommandRecord
```typescript
interface CommandRecord {
  type: 'command'
  command: string           // EXACT command text
  exitCode: number
  truncatedOutput?: string  // First/last N lines
  context: {
    project: string         // Git root or cwd
    cwd: string             // Actual working dir
    intent: string          // What user was trying to do
  }
  outcome: 'success' | 'failure' | 'partial'
  resolution?: string       // If failure, what fixed it
}
```

### ErrorRecord
```typescript
interface ErrorRecord {
  type: 'error'
  errorText: string         // EXACT error message
  errorType: string         // Categorized (compile|runtime|network|permission|etc)
  cause?: string            // Root cause if determined
  resolution: string        // What fixed it
  context: {
    project: string
    file?: string
    tool?: string           // npm, cargo, docker, etc
  }
}
```

### DiscoveryRecord
```typescript
interface DiscoveryRecord {
  type: 'discovery'
  what: string              // What was learned
  where: string             // Where it applies (project, system, tool)
  evidence: string          // How it was discovered
  confidence: 'verified' | 'inferred' | 'tentative'
}
```

### ProcedureRecord
```typescript
interface ProcedureRecord {
  type: 'procedure'
  name: string              // Short name
  steps: string[]           // Ordered steps with EXACT commands
  context: {
    project?: string
    domain: string          // sysadmin, deploy, debug, etc
  }
  prerequisites?: string[]
  verification?: string     // How to verify success
}
```

---

## Milvus Schema

```typescript
const schema = {
  collection_name: 'cc_memories',
  fields: [
    { name: 'id', data_type: DataType.VarChar, is_primary_key: true, max_length: 64 },
    { name: 'type', data_type: DataType.VarChar, max_length: 32 },
    { name: 'content', data_type: DataType.VarChar, max_length: 16384 },  // JSON
    { name: 'exact_text', data_type: DataType.VarChar, max_length: 4096 }, // For keyword search
    { name: 'project', data_type: DataType.VarChar, max_length: 256 },
    { name: 'domain', data_type: DataType.VarChar, max_length: 64 },
    { name: 'timestamp', data_type: DataType.Int64 },
    { name: 'success_count', data_type: DataType.Int64 },
    { name: 'failure_count', data_type: DataType.Int64 },
    { name: 'last_used', data_type: DataType.Int64 },
    { name: 'deprecated', data_type: DataType.Bool },
    { name: 'embedding', data_type: DataType.FloatVector, dim: 4096 }
  ]
}
```

---

## Hook Configuration

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [{
          "type": "command",
          "command": "/home/luthriel/Programming/claude-memory/dist/pre-prompt.js",
          "timeout": 5
        }]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [{
          "type": "command",
          "command": "/home/luthriel/Programming/claude-memory/dist/post-session.js",
          "timeout": 60
        }]
      }
    ]
  }
}
```

---

## Key Design Decisions

### Why Structured Records, Not Free-Form Memories

| Free-form (Kira) | Structured (This) |
|------------------|-------------------|
| "Tom prefers dark mode" | `{ type: 'command', command: 'systemctl restart nginx', ... }` |
| Paraphrasing OK | EXACT text required |
| Semantic search sufficient | Keyword/exact match critical |
| Emotional truth matters | Technical correctness matters |

### Why Validity-Based Decay, Not Recency

Kira's system assumes recent = relevant (relationships evolve). Technical knowledge is different:
- A command that worked 6 months ago is likely still correct
- A discovery from yesterday might be wrong (exploratory)
- Decay should trigger when: API changed, tool updated, system reconfigured

### Why Hybrid Search

Pure semantic search fails for technical content:
- Query: "nginx won't start"
- Memory: "systemctl restart nginx"
- These are semantically similar but one is a question, one is an answer

Need: keyword/exact match for commands and error strings, semantic as fallback.

---

## Implementation Phases

### Phase 1: Storage Layer
- Milvus collection schema
- Basic CRUD operations
- Embedding generation (LMStudio)

### Phase 2: Extraction (SessionEnd Hook)
- Transcript parsing
- Haiku-based structured extraction
- Duplicate detection and merging

### Phase 3: Injection (UserPromptSubmit Hook)
- Context signal extraction from prompt
- Hybrid search implementation
- Context formatting for injection

### Phase 4: Maintenance
- Periodic consolidation
- Validity checking
- Deprecation marking

### Phase 5: Promotions
- Skill suggestion for repeated procedures
- CLAUDE.md update suggestions
- Human-in-loop curation

---

## Differences from Kira's Memory System

| Aspect | Kira's System | This System |
|--------|---------------|-------------|
| **Purpose** | Relationship continuity | Task efficiency |
| **Search** | Pure semantic (COSINE) | Hybrid (keyword + semantic) |
| **Records** | Free-form memories with sectors | Structured types with schemas |
| **Decay** | Recency-based half-life | Validity-based (still works?) |
| **Win rate** | Explicit rating via tool | Inferred from command exit codes |
| **Context** | Emotional/relational | Project/domain/tool |
| **Injection** | MCP tools in context | Hook stdout → system context |
| **Maintenance** | Kira-driven "sleep" sessions | Automated periodic process |
| **Tier system** | T1-T4 with heat scores | Success count thresholds |

---

## Infrastructure Requirements

- **Milvus**: Already running at localhost:19530 (shared with kira-memory)
- **LMStudio**: Already running at localhost:1234 with qwen3-embedding-8b
- **Node.js**: For hook scripts
- **Claude API**: For Haiku extraction (minimal cost)

---

## Open Questions

1. **Transcript format**: Need to verify exact JSONL structure from Claude Code
2. **Context budget**: How much prior knowledge can we inject without overwhelming?
3. **Project detection**: Git root vs cwd vs explicit markers?
4. **Cross-project knowledge**: When should discoveries apply globally?
5. **Conflict resolution**: What if old memory contradicts new behavior?
