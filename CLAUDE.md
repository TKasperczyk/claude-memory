## Development guidelines

Use claude-context semantic search for exploring the codebase and avoiding code duplication when implementing features and making changes.

## Project Overview

claude-memory is a technical knowledge persistence system for Claude Code. It extracts durable knowledge from conversations (commands, errors, discoveries, procedures, warnings) and injects relevant memories into future sessions via Claude Code hooks.

## Commands

```bash
# Core
pnpm build                  # TypeScript compilation
pnpm test                   # Run vitest (some tests skip if services unavailable)
pnpm test:watch             # Watch mode
pnpm dev                    # Source watch mode (tsx watch)
pnpm maintenance            # Run memory maintenance
pnpm maintenance --dry-run  # Preview without changes
pnpm audit                  # Gemini-powered full-corpus audit
pnpm audit:auto             # Auto-mode (no prompts)

# Dashboard (separate package in ./dashboard)
cd dashboard
pnpm start              # API server (port 3001) + Vite (port 5000)
pnpm server             # API server only
pnpm dev                # Vite frontend only
```

## Architecture

### Hooks (src/hooks/)
- **pre-prompt.ts**: Retrieves and injects relevant memories before each prompt (hybrid search + MMR diversity)
- **post-session.ts**: Launcher spawning a detached worker for fast exit
- **post-session-worker.ts**: Extracts knowledge from transcripts via Claude, deduplicates, stores in Milvus

### Core Library (src/lib/)
- **Milvus layer** (milvus-*.ts): Connection, CRUD, hybrid search, schema with inline migrations via `ensureSchemaFields()`
- **Extraction** (extract.ts): LLM-based transcript extraction + usefulness rating of injected memories
- **Retrieval** (retrieval.ts, context.ts): Search, MMR reranking, signal extraction from prompts. Optional Haiku query planning (retrieval-query-generator.ts) enabled by `enableHaikuRetrieval` setting.
- **Maintenance** (maintenance/): Stale deprecation, consolidation, global promotion, conflict resolution, warning synthesis. Has runners/ subdirectory for each operation.
- **Auth** (anthropic.ts): Multi-path: API key → OAuth token → Claude/kira credentials, with auto-refresh
- **File storage** (file-store.ts): `JsonStore`/`JsonLinesStore` under ~/.claude-memory/ — used for sessions, extractions, token-usage-events, stats-snapshots
- **Settings** (settings.ts, settings-schema.ts): Custom validation (not Zod). Three sections: Retrieval, Maintenance, Model (extractionModel, reviewModel, chatModel).
- **Config** (config.ts): Merge order: defaults (env vars as lowest-priority fallbacks) → global config → project config → settings overrides

### Dashboard (dashboard/)
React 19 + TanStack Query + Tailwind + shadcn/ui + recharts. Express API (dashboard/server/).
Pages: Overview (metrics/charts/installation), Memory Pool, Extractions, Sessions (with injection review), Chat (LLM with search/update/delete tools), Simulator (retrieval debugger with diagnostics), Maintenance, Settings.

### Scripts (scripts/)
Gemini audit (gemini-audit.ts), embedding migration/refresh, collection reset, data queries.

## Environment

**Required services:** Milvus (localhost:19530), embedding API (http://127.0.0.1:1234/v1), Anthropic API

**Key env vars:**
- `CC_MEMORIES_ADDRESS`, `CC_MEMORIES_COLLECTION`, `CC_EMBEDDINGS_URL`, `CC_EMBEDDINGS_MODEL`
- `CC_EXTRACTION_MODEL` (default: claude-sonnet-4-5-20250929)
- `CC_MEMORIES_DOMAIN`: Override domain inference (empty string disables filtering)
- `CC_MEMORIES_SETTING_*`: Override any setting (e.g., `CC_MEMORIES_SETTING_MIN_SEMANTIC_SIMILARITY=0.4`)
- `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`
- `CLAUDE_MEMORY_DEBUG=1`, `CLAUDE_MEMORY_LOG_LEVEL` (debug/info/warn/error)

## Record Types

Five types: **command**, **error**, **discovery**, **procedure**, **warning**. Each has scope (project/global), domain categorization, and usage counters for relevance scoring.

## Key Patterns

- Hooks: stderr for logging, stdout for injected context
- Post-session: detached subprocess for fast exit
- Config: defaults (env vars lowest) → global → project → settings
- Search: hybrid keyword + semantic with MMR diversity reranking
- Data: ~/.claude-memory/ stores sessions, extractions, token events, stats snapshots

## Design Decisions

### Extraction Run Deletion Includes Updated Records
Deleting an extraction run removes BOTH newly inserted AND dedup-matched updated records. Updated records get linked to the run via `extractionRunId`; leaving them would create inconsistent state. To preserve pre-existing records, manually review before deletion.

### Token Display: input + output Only
Dashboard totals are `inputTokens + outputTokens`. Cache token fields (`cacheCreationInputTokens`, `cacheReadInputTokens`) are **subsets** of `input_tokens`, not additive — including them would double-count.

### Usefulness Rating Handles Missing Tool Calls
`rateInjectedMemories()` in extract.ts returns `{ helpfulIds: [], tokenUsage }` instead of throwing when the tool block is missing. Preserving token accounting is more valuable than retrying rare malformed responses.
