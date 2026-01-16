# Claude Memory

Technical knowledge persistence for Claude Code. Extracts memories from session transcripts and injects relevant context into new sessions.

## Purpose

Claude Code sessions are stateless - each conversation starts fresh. This project adds persistent memory by:
1. **Extracting** learnings from completed sessions (commands, errors, discoveries, procedures, warnings)
2. **Storing** them in a vector database (Milvus) with embeddings for semantic search
3. **Injecting** relevant memories into new sessions via Claude Code hooks

The goal is to help Claude avoid repeating mistakes, remember project-specific knowledge, and build on past successes.

## Architecture

**Hooks** (in `src/hooks/`):
- `UserPromptSubmit` → Search Milvus, inject relevant memories as `<prior-knowledge>`
- `SessionEnd`/`PreCompact` → Extract memories from transcript, dedupe, store

The SessionEnd hook uses a launcher+worker pattern because Claude Code cancels slow hooks. The launcher spawns a detached worker and exits immediately (<10ms), while the worker does the actual extraction in the background.

**Core tech:**
- Milvus for vector storage + hybrid search (semantic + keyword)
- Local embedding model (Qwen3) via OpenAI-compatible API
- Anthropic API for extraction (Haiku) and reviews (Opus)
- React + Vite dashboard for visualization and maintenance

**Key patterns:**
- MMR (Maximal Marginal Relevance) for diverse result selection
- Usage tracking to boost memories that prove helpful
- Configurable thresholds in `~/.claude-memory/settings.json`
- OAuth support with auto-refresh for Anthropic API access

## Memory Types

| Type | Purpose |
|------|---------|
| `command` | Shell commands with outcomes and resolutions |
| `error` | Error patterns with causes and fixes |
| `discovery` | Codebase/system facts learned during sessions |
| `procedure` | Multi-step workflows that worked |
| `warning` | Anti-patterns synthesized from repeated failures |

Each memory has scope (global/project), usage metrics, and a `sourceExcerpt` citing the transcript.

## Dashboard

Web UI for inspecting and maintaining the memory pool:
- **Simulator**: Test what memories would inject for a prompt
- **Extractions/Sessions**: Review extraction quality with Opus
- **Maintenance**: Run deprecation, consolidation, and promotion operations
- **Settings**: Tune retrieval and maintenance thresholds

## Development Notes

- Hooks must be fast - avoid blocking I/O in the launcher path
- Embeddings are 4096-dimensional (Qwen3); dimension is enforced at insert time
- Record schemas are centralized in `src/lib/record-schema.ts` for consistency between extraction and review
- Auth falls back through: env vars → Claude Code credentials → kira credentials

## Claude-Context Indexing

When using claude-context MCP to index this codebase:

```
mcp__claude-context__index_codebase({
  path: "/home/luthriel/Programming/claude-memory",
  force: true,
  customExtensions: [".svelte"],
  ignorePatterns: ["**/.pnpm-store/**", "**/pnpm-lock.yaml", "**/*.lock"]
})
```

**Important:**
- Don't add `.json` as a custom extension - it picks up pnpm's content-addressable store (hundreds of package metadata files in `dashboard/.pnpm-store/`)
- The AST splitter handles `.ts`, `.tsx` by default - only add `.svelte` for this project
- Always ignore `.pnpm-store/**` and lock files
- Expected result: ~85 files, ~1600 chunks (not 400+ files)
