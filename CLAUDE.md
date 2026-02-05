## Development guidelines

Use claude-context semantic search for exploring the codebase and avoiding code duplication when implementing features and making changes

## Project Overview

claude-memory is a technical knowledge persistence system for Claude Code. It automatically extracts durable knowledge from conversations (commands, errors, discoveries, procedures, warnings) and injects relevant memories into future sessions via Claude Code hooks.

## Development Commands

```bash
# Core commands
pnpm build              # TypeScript compilation
pnpm test               # Run vitest tests
pnpm test:watch         # Watch mode
pnpm maintenance        # Run memory maintenance operations
pnpm maintenance --dry-run  # Preview maintenance without changes

# Dashboard (separate package in ./dashboard)
cd dashboard
pnpm start              # Run API server (port 3001) + Vite dev server (port 5173)
pnpm server             # API server only
pnpm dev                # Vite frontend only
```

## Architecture

### Hook System (src/hooks/)
Claude Code hooks that run automatically during sessions:
- **pre-prompt.ts**: Injects relevant memories before each user prompt. Runs hybrid search (keyword + semantic), applies MMR for diversity, and formats context for injection.
- **post-session.ts**: Launcher that spawns detached worker process for fast exit.
- **post-session-worker.ts**: Extracts records from session transcripts using Claude (Sonnet by default), deduplicates against existing memories, stores in Milvus.

### Core Library (src/lib/)
- **types.ts / shared/types.d.ts**: Record types (command, error, discovery, procedure, warning), hook inputs, config interfaces. Types are defined in shared/types.d.ts and re-exported.
- **milvus*.ts**: Vector database operations split across files - milvus-client.ts (connection), milvus-crud.ts (insert/update/delete), milvus-search.ts (hybrid search), milvus-records.ts (row building).
- **extract.ts**: LLM-based transcript extraction. System prompt instructs Claude to extract durable knowledge while avoiding duplicates.
- **retrieval.ts**: Core search logic with MMR reranking, timeout handling, and diagnostic modes.
- **maintenance.ts**: Memory lifecycle operations - stale checks, consolidation, global promotion, conflict resolution, warning synthesis.
- **settings.ts / settings-schema.ts**: User settings with Zod validation, loaded from ~/.claude-memory/settings.json.
- **config.ts**: Config hierarchy - defaults → global config (~/.claude-memory/config.json) → project config.

### Dashboard (dashboard/)
React 19 + TanStack Query + Tailwind + shadcn/ui. Express API server with routes in dashboard/server/routes/. Provides UI for browsing memories, reviewing extractions, running maintenance, and testing retrieval.

### Maintenance (src/maintenance.ts)
CLI tool and library for memory quality operations:
- Stale record deprecation
- Low usage detection
- Semantic consolidation (merge similar memories)
- Global promotion (project → global scope)
- Conflict resolution
- Warning synthesis from failed patterns

## Environment & Dependencies

**Required Services:**
- Milvus vector database (default: localhost:19530)
- LMStudio or compatible embedding API (default: http://127.0.0.1:1234/v1)
- Anthropic API access for extraction (ANTHROPIC_API_KEY or OAuth credentials)

**Key Environment Variables:**
- `CC_MEMORIES_ADDRESS`: Milvus address
- `CC_MEMORIES_COLLECTION`: Collection name
- `CC_EMBEDDINGS_URL`: Embedding API endpoint
- `CC_EMBEDDINGS_MODEL`: Embedding model name
- `CC_EXTRACTION_MODEL`: Model for extraction (default: claude-sonnet-4-5-20250929)

## Testing

Tests require Milvus and optionally embeddings/Anthropic:
```bash
pnpm test                    # Runs all tests (some skip if services unavailable)
pnpm test test/extraction    # Run specific test file
```

E2E tests check embedding availability and Anthropic auth at runtime, skipping gracefully if missing.

## Record Types

Each extracted memory has a type determining its structure:
- **command**: Shell commands with exit codes and outcomes
- **error**: Error messages with resolutions
- **discovery**: Factual knowledge about codebases
- **procedure**: Step-by-step instructions
- **warning**: Anti-patterns with alternatives

Records have scope (project/global), domain categorization, and usage counters for relevance scoring.

## Key Patterns

- Hooks write to stderr for logging, stdout for injected context
- Post-session uses detached subprocess pattern for fast exit
- Config merges: env vars → global config → project config
- Settings are user-editable with Zod schema validation
- Hybrid search combines keyword matching and vector similarity
- MMR (Maximal Marginal Relevance) ensures diverse results
