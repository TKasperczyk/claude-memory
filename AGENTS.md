# AGENTS.md - Claude Memory

## Project Overview

**Claude Memory** is an experimental technical knowledge persistence system for Claude Code. It automatically extracts, stores, and retrieves technical knowledge across sessions, solving the problem of ephemeral context.

### The Problem

Claude Code sessions are stateless. Every new session starts fresh, losing:
- Commands that worked for specific problems
- Error resolutions discovered during debugging
- System/project-specific discoveries
- Multi-step procedures figured out through trial and error

Currently, preserving knowledge requires manual effort:
- Updating CLAUDE.md files (easy to forget)
- Creating Skills (overhead for one-off discoveries)
- Relying on memory (unreliable)

### The Solution

Automatic knowledge extraction and injection via Claude Code hooks:
1. **SessionEnd hook**: Extract structured knowledge from completed sessions
2. **UserPromptSubmit hook**: Inject relevant prior knowledge into new prompts
3. **Periodic maintenance**: Consolidate, validate, and promote high-value knowledge

---

## Architecture

See [PLAN.md](./PLAN.md) for full architecture diagrams and design decisions.

### Key Components

| Component | Purpose | Location |
|-----------|---------|----------|
| `pre-prompt.ts` | Query memories, inject context | `src/hooks/` |
| `post-session.ts` | Parse transcript, extract knowledge | `src/hooks/` |
| `maintenance.ts` | Consolidation, validation, suggestions | `src/` |
| `lib/milvus.ts` | Milvus client wrapper | `src/lib/` |
| `lib/embed.ts` | LMStudio embedding client | `src/lib/` |
| `lib/extract.ts` | Haiku-based extraction | `src/lib/` |
| `lib/search.ts` | Hybrid search (keyword + semantic) | `src/lib/` |
| `lib/types.ts` | Record type definitions | `src/lib/` |

### Directory Structure

```
claude-memory/
├── AGENTS.md           # This file
├── PLAN.md             # Full architecture and design
├── src/
│   ├── hooks/          # Claude Code hook scripts
│   │   ├── pre-prompt.ts
│   │   └── post-session.ts
│   ├── lib/            # Shared libraries
│   │   ├── milvus.ts
│   │   ├── embed.ts
│   │   ├── extract.ts
│   │   ├── search.ts
│   │   └── types.ts
│   └── maintenance.ts  # Periodic maintenance script
├── suggestions/        # Generated promotion suggestions
│   ├── skills/         # Suggested skill creations
│   └── claude-md/      # Suggested CLAUDE.md updates
├── package.json
├── tsconfig.json
└── config.json         # Runtime configuration
```

---

## Inspiration Sources

This project takes heavy inspiration from **kira-memory** and **kira-runtime**, adapting their concepts for technical (rather than relational) memory.

### From kira-memory

**Repository**: `/home/luthriel/Programming/kira-memory`

| Concept | Kira's Implementation | Our Adaptation |
|---------|----------------------|----------------|
| **Vector storage** | Milvus with 4096-dim embeddings | Same infrastructure, different schema |
| **MCP server pattern** | `src/index.ts` - clean tool interface | Not using MCP (hooks instead), but similar modularity |
| **Embedding generation** | `src/embeddings.ts` - LMStudio client | Reuse same approach and endpoint |
| **Retrieval stats** | `src/retrieval-stats.ts` - usage tracking | Adapt to success_count/failure_count |
| **Decay system** | `src/decay.ts` - half-life based | Replace with validity-based decay |

**Key files to reference**:
- `src/milvus.ts` - Milvus client patterns, collection schema
- `src/embeddings.ts` - Embedding generation via LMStudio
- `src/memory.ts` - CRUD operations, duplicate detection
- `src/types.ts` - Type definitions pattern

### From kira-runtime

**Repository**: `/home/luthriel/Programming/kira-runtime`

| Concept | Kira's Implementation | Our Adaptation |
|---------|----------------------|----------------|
| **Memory extraction** | `src/memory-extraction.ts` - Haiku-based | Adapt extraction prompts for technical content |
| **Transcript parsing** | `src/stream/store.ts` - JSONL format | Apply to Claude Code transcript format |
| **Heat tracking** | `src/stream/heat.ts` - reference detection | Adapt to success-based reinforcement |
| **Recall management** | `src/recall-manager.ts` - sticky pool | Consider for context caching |

**Key files to reference**:
- `src/memory-extraction.ts` - LLM extraction with forced tool calls
- `src/stream/types.ts` - Stream entry structure
- `src/stream/store.ts` - JSONL parsing patterns
- `src/recall-manager.ts` - Context signal extraction

---

## Key Differences from Kira's System

### Why Not Just Fork Kira-Memory?

Kira's memory system is optimized for **relational continuity** - emotional moments, promises, relationship dynamics. Technical memory has fundamentally different requirements:

| Aspect | Kira (Relational) | This (Technical) |
|--------|-------------------|------------------|
| **Content fidelity** | Paraphrasing OK | EXACT text required |
| **Search strategy** | Pure semantic | Hybrid (keyword + semantic) |
| **Decay trigger** | Time-based (recency) | Validity-based (still works?) |
| **Success signal** | Explicit rating | Command exit codes |
| **Context scope** | Relationship history | Project/domain/tool |
| **Record structure** | Free-form with sectors | Typed schemas |

### Specific Adaptations

1. **Hybrid Search**: Kira uses pure COSINE similarity. Technical content needs exact match for commands and error strings, with semantic as fallback.

2. **Structured Records**: Kira stores free-form memories in sectors (facts, moments, promises). We store typed records (CommandRecord, ErrorRecord, DiscoveryRecord, ProcedureRecord) with strict schemas.

3. **Decay Model**: Kira's half-life decay assumes recent = relevant. For technical knowledge, old working solutions are often MORE valuable. Decay triggers on validity (API changed, tool updated).

4. **Injection Method**: Kira uses MCP tools that Claude calls explicitly. We use hooks to inject context automatically, since Claude Code doesn't have MCP-level control.

5. **Extraction Focus**: Kira extracts emotional salience and relationship dynamics. We extract exact commands, error messages, and step sequences.

---

## Implementation Notes

### Phase 1: Storage Layer

Start by implementing:
- Milvus collection with hybrid-capable schema
- Basic insert/update/search operations
- Embedding generation (reuse LMStudio pattern from kira-memory)

Reference: `kira-memory/src/milvus.ts`, `kira-memory/src/embeddings.ts`

### Phase 2: Extraction

Implement SessionEnd hook:
- Parse Claude Code transcript (verify format first)
- Haiku-based extraction with forced tool calls
- Duplicate detection before insert

Reference: `kira-runtime/src/memory-extraction.ts`

### Phase 3: Injection

Implement UserPromptSubmit hook:
- Extract context signals (project, errors, intent)
- Hybrid search with keyword priority
- Format as context block for stdout

### Phase 4: Maintenance

Implement periodic process:
- Validity checking (can we verify commands still work?)
- Consolidation of similar records
- Promotion suggestions

Reference: `kira-memory/src/decay.ts`, `kira-memory/src/retrieval-stats.ts`

---

## Infrastructure

### Shared with Kira

- **Milvus**: localhost:19530 (separate collection: `cc_memories`)
- **LMStudio**: localhost:1234 with `text-embedding-qwen3-embedding-8b`

### Claude Code Integration

Hook configuration in `~/.claude/settings.json`:
```json
{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "..." }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "..." }] }]
  }
}
```

### API Requirements

- **Anthropic API**: For Haiku-based extraction (minimal cost)
- **LMStudio**: For embeddings (local, free)

---

## Open Questions

1. **Transcript format**: Need to verify exact JSONL structure from `transcript_path`
2. **Context budget**: How much prior knowledge can we inject?
3. **Project detection**: Git root vs cwd vs explicit markers?
4. **Cross-project knowledge**: When should discoveries apply globally?
5. **Conflict resolution**: What if old memory contradicts new behavior?

---

## Development Workflow

1. Build: `pnpm build` (compiles TypeScript to `dist/`)
2. Test hooks: Run Claude Code session, check hook execution
3. Debug: Check Milvus collection, review extracted records
4. Iterate: Adjust extraction prompts, search ranking

---

## License

TBD - Currently experimental/personal use.
