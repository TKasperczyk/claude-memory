# claude-memory

Technical knowledge persistence for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Extracts durable knowledge from conversations — commands, errors, discoveries, procedures, warnings — and injects relevant memories into future sessions.

## How it works

1. **After each session**, a hook extracts reusable knowledge from the transcript using Claude
2. **Before each prompt**, a hook searches stored memories and injects relevant ones as context
3. Knowledge is embedded as 4096-dim vectors and stored in LanceDB (embedded, in-process) for hybrid (semantic + keyword) retrieval
4. A maintenance system handles deduplication, consolidation, conflict resolution, and stale record deprecation

## Prerequisites

- **Node.js** >= 20
- **pnpm** (package manager)
- **LanceDB** (vector database) — embedded (no server/service required)
- **Embedding API** — any OpenAI-compatible endpoint serving a 4096-dim model (e.g., LM Studio with `qwen3-embedding-8b`)
- **Anthropic API key** or Claude Code OAuth credentials

## Installation

```bash
git clone <repo-url>
cd claude-memory
pnpm install
pnpm build
```

### Register Claude Code hooks

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [{
      "hooks": [{
        "type": "command",
        "command": "node \"/path/to/claude-memory/dist/hooks/pre-prompt.js\"",
        "timeout": 15
      }]
    }],
    "SessionEnd": [{
      "hooks": [{
        "type": "command",
        "command": "node \"/path/to/claude-memory/dist/hooks/post-session.js\"",
        "timeout": 15
      }]
    }],
    "PreCompact": [{
      "hooks": [{
        "type": "command",
        "command": "node \"/path/to/claude-memory/dist/hooks/post-session.js\"",
        "timeout": 15
      }]
    }]
  }
}
```

### MCP server (optional)

claude-memory also exposes a read-only MCP server for searching memories:

```json
{
  "mcpServers": {
    "claude-memory": {
      "command": "node",
      "args": ["/path/to/claude-memory/dist/mcp-server.js"]
    }
  }
}
```

## LanceDB

LanceDB is embedded (no server/service required). Data is stored on disk in the configured LanceDB directory (default: `~/.claude-memory/lancedb`) under the configured table name (default: `cc_memories`).

## Configuration

Configuration is loaded in this order (later overrides earlier):

1. **Defaults** (with env var fallbacks)
2. **Global config** — `~/.claude-memory/config.json`
3. **Project config** — `<project-root>/config.json`

### Config file (`~/.claude-memory/config.json`)

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
| `CC_EMBEDDINGS_API_KEY` | — | Bearer token for authenticated endpoints |
| `CC_EMBEDDINGS_INSECURE` | `false` | Set `true` to skip TLS certificate verification |
| `CC_EXTRACTION_MODEL` | `claude-sonnet-4-5-20250929` | Claude model for extraction |
| `ANTHROPIC_API_KEY` | — | Anthropic API key |
| `ANTHROPIC_AUTH_TOKEN` | — | OAuth token (alternative to API key) |
| `CC_MEMORIES_SETTING_*` | — | Override any setting (e.g., `CC_MEMORIES_SETTING_MIN_SEMANTIC_SIMILARITY=0.4`) |
| `CLAUDE_MEMORY_DEBUG` | — | Set `1` for debug logging |

### Using an external embedding endpoint

To use a remote OpenAI-compatible endpoint instead of a local LM Studio instance, configure the URL, model, API key, and optionally TLS bypass:

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

If the server uses a custom CA certificate, you can either set `"insecure": true` in config, or set the `NODE_EXTRA_CA_CERTS` environment variable to the CA cert path before starting.

### Settings (`~/.claude-memory/settings.json`)

Tuning knobs for retrieval, maintenance, and models. Editable via the dashboard Settings page or directly. Key settings:

| Setting | Default | Description |
|---|---|---|
| `minSemanticSimilarity` | `0.70` | Minimum cosine similarity for vector results |
| `minScore` | `0.45` | Minimum hybrid score to include a result |
| `maxRecords` | `8` | Max memories injected per prompt |
| `maxTokens` | `4000` | Token budget for injected context |
| `mmrLambda` | `0.7` | MMR diversity parameter (1.0 = pure relevance) |
| `extractionDedupThreshold` | `0.85` | Similarity threshold for update-vs-insert |
| `consolidationThreshold` | `0.80` | Similarity threshold for merging records |
| `enableHaikuRetrieval` | `false` | Use Haiku for query planning |
| `extractionModel` | `claude-sonnet-4-5-20250929` | Model for knowledge extraction |

All settings can be overridden via env vars using the pattern `CC_MEMORIES_SETTING_<SCREAMING_SNAKE_CASE>`.

## Commands

```bash
pnpm build                  # TypeScript compilation
pnpm test                   # Run tests
pnpm dev                    # Source watch mode (tsx watch)
pnpm maintenance            # Run memory maintenance
pnpm maintenance --dry-run  # Preview maintenance without changes
```

### Dashboard

A web UI for browsing memories, reviewing extractions, running maintenance, tuning settings, and debugging retrieval.

```bash
cd dashboard
pnpm install
pnpm start                  # API server (port 3001) + Vite frontend (port 5000)
```

## Architecture

### Hooks

- **UserPromptSubmit** → `pre-prompt.ts`: Searches memories via hybrid search (semantic + keyword + MMR diversity), injects relevant ones as context
- **SessionEnd / PreCompact** → `post-session.ts`: Spawns a detached worker that extracts knowledge from the transcript via Claude, deduplicates against existing records, and stores new memories

### Core (`src/lib/`)

- **LanceDB layer** (`lancedb-*.ts`): Connection management, CRUD, hybrid search, schema with inline migrations (`milvus.ts` remains as a compatibility barrel)
- **Embedding** (`embed.ts`): OpenAI-compatible embedding generation with optional API key auth
- **Extraction** (`extract.ts`): LLM-based transcript extraction + usefulness rating of injected memories
- **Retrieval** (`retrieval.ts`, `context.ts`): Multi-query search, MMR reranking, signal extraction. Optional Haiku query planning.
- **Maintenance** (`maintenance/`): Six phases — stale deprecation, low-usage deprecation, consolidation, conflict resolution, global promotion, warning synthesis
- **Settings** (`settings.ts`): Three sections (retrieval, maintenance, models) with validation and env var overrides
- **Config** (`config.ts`): Merge chain: defaults → global config → project config → settings overrides

### Record types

| Type | Description | Key fields |
|---|---|---|
| `command` | Shell command with outcome | `command`, `exitCode`, `outcome`, `resolution` |
| `error` | Error message + resolution | `errorText`, `errorType`, `cause`, `resolution` |
| `discovery` | Factual finding about code/architecture | `what`, `where`, `evidence`, `confidence` |
| `procedure` | Step-by-step instructions | `name`, `steps`, `prerequisites`, `verification` |
| `warning` | "Don't do X, do Y instead" | `avoid`, `useInstead`, `reason`, `severity` |

Each record has a scope (`project` or `global`) and usage counters (`retrievalCount`, `usageCount`) for relevance scoring.

### Search

Hybrid search combining:
1. **Semantic** — cosine similarity on 4096-dim embeddings
2. **Keyword** — SQL/DataFusion `LIKE` substring matching on `exact_text`
3. **MMR reranking** — Maximal Marginal Relevance to diversify results
4. **Usage boost** — records that were previously helpful get scored higher

## Data storage

- **LanceDB** (directory + table; default: `~/.claude-memory/lancedb` + `cc_memories`) — vectors + record metadata
- **`~/.claude-memory/`** — sessions, extraction logs, token usage events, stats snapshots, settings, config
