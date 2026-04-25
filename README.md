# claude-memory

Technical knowledge persistence for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Extracts durable knowledge from conversations -- commands, errors, discoveries, procedures, warnings -- and injects relevant memories into future sessions.

## How it works

1. **After each session** (or before a context compaction), a hook extracts reusable knowledge from the transcript using Claude.
2. **Before each prompt**, a hook searches stored memories with hybrid (semantic + keyword) retrieval and injects the relevant ones as context.
3. Knowledge is embedded as 4096-dim vectors and stored in [LanceDB](https://lancedb.com/) (embedded, in-process -- no server).
4. A maintenance system handles deduplication, consolidation, conflict resolution, low-usage and stale deprecation, global promotion, and warning synthesis.
5. Each injection is rated for usefulness on the next session and the score feeds back into ranking.

## Prerequisites

- **Node.js** >= 20
- **pnpm** (package manager)
- **Embedding API** -- any OpenAI-compatible endpoint serving a 4096-dim model (e.g. LM Studio with `qwen3-embedding-8b`, or a remote inference server)
- **Anthropic credentials** -- one of: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or signed-in Claude Code OAuth credentials

LanceDB itself is embedded -- nothing to install or run.

## Quick start: `pnpm wizard`

The wizard is the recommended way to install. It tests your embedding endpoint, detects Anthropic credentials, writes config, and installs hooks, slash commands, and the MCP server into your Claude Code config in one shot.

```bash
git clone <repo-url>
cd claude-memory
pnpm install
pnpm build           # required -- the wizard installs hooks pointing at dist/
pnpm wizard
```

What it asks (in order):

1. **Embedding server** -- base URL (default `http://127.0.0.1:1234/v1`), model name (default `text-embedding-qwen3-embedding-8b`), whether the server needs an API key, whether to skip TLS verification (HTTPS only). Probes the endpoint and reports the actual embedding dimension.
2. **Anthropic credentials** -- auto-detects `ANTHROPIC_API_KEY` / `OPENCODE_API_KEY` / `ANTHROPIC_AUTH_TOKEN` and Claude Code OAuth tokens. If none are found, prompts for an API key and verifies it with a small Claude call.
3. **Vector storage** -- LanceDB directory (default `~/.claude-memory/lancedb`) and table name (default `cc_memories`).
4. **Extraction model** -- pick from a short list (Sonnet 4.5 by default).
5. **Install** -- writes `~/.claude-memory/config.json` and updates `~/.claude/settings.json` with:
   - **Hooks**: `UserPromptSubmit` -> `pre-prompt.js`, `SessionEnd` and `PreCompact` -> `post-session.js`
   - **Slash commands**: `/prior-knowledge` (show injected memories), `/remember` (mark conversation for extraction), `/skip-extraction` (skip extraction for this session)
   - **MCP server**: `claude-memory` (read-only `search_memories` tool)

After the wizard finishes, start (or restart) Claude Code. Memories will accumulate automatically. Open the dashboard with `pnpm dashboard` to inspect them.

If anything in the wizard goes wrong (e.g. the embedding server is offline), it warns but continues -- you can edit `~/.claude-memory/config.json` and re-run `pnpm wizard` later.

## Manual install

Skip the wizard if you'd rather wire things up yourself. Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [{
      "hooks": [{ "type": "command", "command": "node \"/path/to/claude-memory/dist/hooks/pre-prompt.js\"", "timeout": 15 }]
    }],
    "SessionEnd": [{
      "hooks": [{ "type": "command", "command": "node \"/path/to/claude-memory/dist/hooks/post-session.js\"", "timeout": 15 }]
    }],
    "PreCompact": [{
      "hooks": [{ "type": "command", "command": "node \"/path/to/claude-memory/dist/hooks/post-session.js\"", "timeout": 15 }]
    }]
  },
  "mcpServers": {
    "claude-memory": {
      "command": "node",
      "args": ["/path/to/claude-memory/dist/mcp-server.js"]
    }
  }
}
```

The MCP server is optional -- relevant memories are already auto-injected by the pre-prompt hook. The MCP `search_memories` tool is for explicit "look up that thing I stored" requests.

## Configuration

Configuration is loaded in this order (later overrides earlier):

1. **Defaults** (with env vars as the lowest-priority fallbacks)
2. **Global config** -- `~/.claude-memory/config.json`
3. **Project config** -- `<project-root>/config.json`
4. **Settings overrides** -- `~/.claude-memory/settings.json` (per-key `CC_MEMORIES_SETTING_*` env vars also apply)

### `~/.claude-memory/config.json`

```json
{
  "lancedb": {
    "directory": "~/.claude-memory/lancedb",
    "table": "cc_memories"
  },
  "embeddings": {
    "baseUrl": "http://127.0.0.1:1234/v1",
    "model": "text-embedding-qwen3-embedding-8b",
    "apiKey": "optional-bearer-token",
    "insecure": false
  },
  "extraction": {
    "model": "claude-sonnet-4-5-20250929"
  }
}
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `CC_MEMORIES_LANCEDB_DIR` | `~/.claude-memory/lancedb` | LanceDB directory |
| `CC_MEMORIES_COLLECTION` | `cc_memories` | LanceDB table name |
| `CC_EMBEDDINGS_URL` | `http://127.0.0.1:1234/v1` | Embedding API base URL |
| `CC_EMBEDDINGS_MODEL` | `text-embedding-qwen3-embedding-8b` | Embedding model name |
| `CC_EMBEDDINGS_API_KEY` | -- | Bearer token for authenticated endpoints |
| `CC_EMBEDDINGS_INSECURE` | `false` | Set `true` to skip TLS certificate verification |
| `CC_EXTRACTION_MODEL` | `claude-sonnet-4-5-20250929` | Claude model for extraction |
| `ANTHROPIC_API_KEY` | -- | Anthropic API key |
| `ANTHROPIC_AUTH_TOKEN` | -- | OAuth token (alternative to API key) |
| `ANTHROPIC_BASE_URL` | -- | Custom Anthropic endpoint (e.g. for proxies) |
| `CC_MEMORIES_SETTING_*` | -- | Override any setting (e.g. `CC_MEMORIES_SETTING_MIN_SEMANTIC_SIMILARITY=0.4`) |
| `CLAUDE_MEMORY_DEBUG` | -- | Set `1` for debug logging |
| `CLAUDE_MEMORY_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

### Using a remote embedding endpoint

```json
{
  "embeddings": {
    "baseUrl": "https://your-inference-server/v1",
    "model": "your-model-id",
    "apiKey": "your-api-key",
    "insecure": true
  }
}
```

If the server uses a custom CA, either set `"insecure": true` or point `NODE_EXTRA_CA_CERTS` at the CA bundle before starting Claude Code.

### `~/.claude-memory/settings.json`

Tuning knobs for retrieval, maintenance, and models. Editable through the dashboard's Settings page or directly. Highlights:

| Setting | Default | Description |
|---|---|---|
| `minSemanticSimilarity` | `0.70` | Minimum cosine similarity for vector results |
| `semanticAnchorThreshold` | `0.70` | At least one result must clear this before any memories are injected (gates noisy injections) |
| `minScore` | `0.45` | Minimum hybrid score to include a result |
| `maxRecords` | `8` | Max memories injected per prompt |
| `maxTokens` | `4000` | Token budget for injected context |
| `mmrLambda` | `0.7` | MMR diversity parameter (1.0 = pure relevance) |
| `enableHaikuRetrieval` | `false` | Use Haiku to plan / expand retrieval queries |
| `extractionDedupThreshold` | `0.85` | Similarity threshold for update-vs-insert during extraction |
| `extractionContextOverlapTurns` | `3` | Overlap when re-extracting a resumed session |
| `consolidationThreshold` | `0.80` | Similarity threshold for merging records |
| `autoMaintenanceIntervalHours` | `24` | Run maintenance automatically after extraction if it's been this long (0 disables) |
| `extractionModel` | `claude-sonnet-4-5-20250929` | Model for knowledge extraction |
| `chatModel` | (= extraction model) | Model used by the dashboard chat |
| `reviewModel` | (= extraction model) | Model used by injection / extraction reviews |

Any setting can be overridden via `CC_MEMORIES_SETTING_<SCREAMING_SNAKE_CASE>`.

## Commands

```bash
# Build & develop
pnpm build                    # TypeScript compile (root + dashboard)
pnpm dev                      # tsx watch mode
pnpm test                     # vitest (some tests skip if services are unavailable)
pnpm test:watch               # vitest watch
pnpm test:ui                  # vitest UI

# Setup & ops
pnpm wizard                   # interactive setup (recommended)
pnpm maintenance              # run the full maintenance pipeline
pnpm maintenance --dry-run    # preview without writing

# Dashboard
pnpm dashboard                # API (3001) + Vite (5000)
pnpm dashboard:server         # API only
pnpm dashboard:prod           # production server

# Debug & audit
pnpm debug <cmd>              # debug CLI (see below)
pnpm audit                    # full-corpus Gemini audit (interactive)
pnpm audit:auto               # Gemini audit, no prompts
pnpm apply-audit              # apply audit findings
```

## Dashboard

A web UI for browsing and operating the memory pool. Start with `pnpm dashboard` and open `http://localhost:5000`.

| Page | What it does |
|---|---|
| **Overview** | Pool statistics, record-type breakdown, retrieval scoring chart, install/health status |
| **Memory Pool** | Search, filter, and edit individual records |
| **Extractions** | List extraction runs, drill into per-record details, re-run extraction on a session |
| **Sessions** | Inspect injected memories per session and run an Opus-powered "was this injection useful?" review |
| **Chat** | Interactive chat with tool access -- search the pool, create memories, trigger extractions |
| **Maintenance** | Dry-run or execute every maintenance phase and review the diffs |
| **Simulator** (Context Preview) | Replay retrieval for a custom prompt with full diagnostics |
| **Settings** | Edit retrieval, maintenance, and model settings (writes `~/.claude-memory/settings.json`) |

## Debug CLI

`pnpm debug <command>` is a terminal companion to the dashboard for fast introspection and Opus-powered reviews.

```
Memory pool:   stats, search <query>, similar <id>, consolidation, deprecation,
               promotion, record <id>, export, embedding <text>, compare <id1> <id2>,
               settings
Sessions:      sessions, session <sessionId>
Extractions:   extractions, extraction <runId>
Reviews:       review-session <id>, review-extraction <id>   (stream Opus thinking)
```

All commands accept `--json` for machine-readable output. Run `pnpm debug help` for the full flag list.

## MCP server

The MCP server (`dist/mcp-server.js`) exposes a single read-only tool, `search_memories`:

| Param | Description |
|---|---|
| `query` | Natural-language search query |
| `project` | Project path to scope to (defaults to cwd) |
| `type` | Filter to one of `command`/`error`/`discovery`/`procedure`/`warning` |
| `limit` | 1--50 (default 10) |

It's wired into Claude Code automatically by the wizard. The tool is intentionally read-only -- writes happen via the extraction hook, not at LLM request.

## Architecture

### Hooks (`src/hooks/`)

- **`pre-prompt.ts`** (`UserPromptSubmit`) -- hybrid retrieval + MMR diversity, optional Haiku query planning, semantic-anchor gate, injects context on stdout. Tracks injected IDs per session for downstream usefulness rating.
- **`post-session.ts`** (`SessionEnd`, `PreCompact`) -- thin launcher; spawns a detached worker so the hook returns instantly.
- **`post-session-worker.ts`** -- extracts knowledge from the transcript via Claude, deduplicates against existing records (update-vs-insert via `extractionDedupThreshold`), rates the previously-injected memories' usefulness, and triggers auto-maintenance if it's been more than `autoMaintenanceIntervalHours` since the last run.

### Core library (`src/lib/`)

- **LanceDB layer** (`lancedb-*.ts`) -- connection, CRUD, hybrid search, schema with inline migrations via `ensureSchemaFields()`. (`milvus.ts` remains as a compatibility barrel for the old import path.)
- **Embedding** (`embed.ts`) -- OpenAI-compatible client with optional bearer token and TLS bypass.
- **Extraction** (`extract.ts`) -- LLM-based transcript extraction; rates the previous turn's injected memories.
- **Retrieval** (`retrieval.ts`, `context.ts`, `retrieval-query-generator.ts`) -- multi-query hybrid search, MMR reranking, signal extraction from prompts, optional Haiku query planning.
- **Maintenance** (`maintenance/`) -- see below.
- **Auth** (`anthropic.ts`) -- multi-path: API key -> OAuth token -> Claude Code / Kira credential files, with auto-refresh.
- **File storage** (`file-store.ts`) -- `JsonStore` / `JsonLinesStore` under `~/.claude-memory/`: sessions, extractions, token-usage events, stats snapshots.
- **Settings** (`settings.ts`, `settings-schema.ts`) -- custom validation (no Zod). Three sections: retrieval, maintenance, models.
- **Config** (`config.ts`) -- merge order: defaults (env vars lowest) -> global -> project -> settings overrides.
- **Installer** (`installer.ts`) -- the wizard's hook / command / MCP installer. Used by `pnpm wizard` and the dashboard.

### Record types

| Type | Description | Key fields |
|---|---|---|
| `command` | Shell command with outcome | `command`, `exitCode`, `outcome`, `resolution` |
| `error` | Error message + resolution | `errorText`, `errorType`, `cause`, `resolution` |
| `discovery` | Factual finding about code/architecture | `what`, `where`, `evidence`, `confidence` |
| `procedure` | Step-by-step instructions | `name`, `steps`, `prerequisites`, `verification` |
| `warning` | "Don't do X, do Y instead" | `avoid`, `useInstead`, `reason`, `severity` |

Every record carries a scope (`project` or `global`), `sourceSessionId` / `sourceExcerpt` for traceability, and usage counters (`retrievalCount`, `usageCount`) that feed into ranking.

### Search

Hybrid scoring combines:

1. **Semantic** -- cosine similarity on 4096-dim embeddings.
2. **Keyword** -- DataFusion `LIKE` substring matching on `exact_text`.
3. **MMR reranking** -- maximal marginal relevance for diversity.
4. **Usage boost** -- previously-helpful records score higher; recently-deprecated ones score lower.
5. **Semantic anchor gate** -- nothing is injected unless at least one result clears `semanticAnchorThreshold`, which prevents low-confidence keyword-only injections.

### Maintenance

`pnpm maintenance` runs all phases in order. Each can be dry-run individually from the dashboard or `pnpm debug`.

| Phase | Purpose |
|---|---|
| Stale check | Mark long-untouched records as stale |
| Stale-unused deprecation | Deprecate stale records that were never retrieved |
| Low-usage deprecation | Deprecate records that scored low usefulness across enough injections |
| Consolidation | Merge near-duplicates within the same record type |
| Cross-type consolidation | Merge near-duplicates across record types (e.g. `command` <-> `procedure`) |
| Conflict resolution | Resolve contradictory records via LLM judgement |
| Global promotion | Promote project-scoped records that recur across projects to `global` scope |
| Warning synthesis | Synthesise `warning` records from clusters of related errors |
| Promotion suggestions (dry-run only) | Surface candidates for promotion to review |

## Data storage

- **LanceDB** -- vectors + record metadata. Default location: `~/.claude-memory/lancedb`, table `cc_memories`.
- **`~/.claude-memory/`** -- `config.json`, `settings.json`, sessions, extraction logs, token-usage events, stats snapshots, installer state.
