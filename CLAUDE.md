# Claude Memory

Technical knowledge persistence for Claude Code. Extracts memories from session transcripts and injects relevant context into new sessions.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     Claude Code Session                         │
├─────────────────────────────────────────────────────────────────┤
│  UserPromptSubmit ──► pre-prompt.ts ──► Milvus search ──► inject│
│                                                                 │
│  SessionEnd/PreCompact ──► post-session.ts (launcher, 2ms)      │
│                               └──► post-session-worker.ts       │
│                                     (detached, does extraction) │
└─────────────────────────────────────────────────────────────────┘
```

## Memory Types

| Type | Description | Key Fields |
|------|-------------|------------|
| `command` | Shell commands with outcomes | `command`, `exitCode`, `outcome`, `resolution` |
| `error` | Error patterns and fixes | `errorText`, `errorType`, `cause`, `resolution` |
| `discovery` | Codebase/system discoveries | `what`, `where`, `evidence`, `confidence` |
| `procedure` | Multi-step workflows | `name`, `steps`, `prerequisites`, `verification` |

## Hooks

### pre-prompt.ts
- **Event**: `UserPromptSubmit`
- **Purpose**: Search Milvus for relevant memories, inject into context
- **Latency-critical**: Has 4s timeout, emits context before tracking updates
- **Tracking**: Records injected memory IDs for usefulness rating

### post-session.ts (launcher)
- **Events**: `SessionEnd`, `PreCompact`
- **Purpose**: Spawn detached worker and exit immediately
- **Critical timing**: Must exit in <10ms or Claude Code cancels it
- **Implementation**:
  - Reads stdin synchronously (small ~300 byte payload)
  - Writes to temp file `~/.claude-memory/hook-input-{pid}.json`
  - Spawns worker with `stdio: ['ignore', 'ignore', 'ignore']`
  - Worker inherits NO file descriptors (critical - any inherited fd blocks Claude Code)

### post-session-worker.ts
- **Runs detached** in background after launcher exits
- **Extraction**: Parse transcript → LLM extraction → dedupe against Milvus → store
- **Usefulness rating**: Rate injected memories against transcript, increment `usageCount`

## Usage Metrics

| Field | Meaning | Updated By |
|-------|---------|------------|
| `retrievalCount` | Times memory was injected | pre-prompt.ts |
| `usageCount` | Times rated as helpful | post-session-worker.ts |
| `successCount` | Command successes / error resolutions | Extraction |
| `failureCount` | Command failures / new errors | Extraction |

**Usage ratio**: `min(usageCount / max(retrievalCount, 1), 1.0)` adds 0.2 boost to search ranking.

## Session Tracking

Injected memories are tracked in `~/.claude-memory/sessions/{session_id}.json`:
```json
{
  "sessionId": "abc123",
  "createdAt": 1704067200000,
  "memories": [
    { "id": "mem_xyz", "snippet": "...", "injectedAt": 1704067200000 }
  ]
}
```

Post-session worker reads this file to know which memories to rate for usefulness.

## Configuration

Environment variables:
- `CC_MEMORIES_ADDRESS` - Milvus address (default: `localhost:19530`)
- `CC_MEMORIES_COLLECTION` - Collection name (default: `cc_memories`)
- `CC_EMBEDDINGS_URL` - Embedding API URL (default: `http://127.0.0.1:1234/v1`)
- `CC_EMBEDDINGS_MODEL` - Embedding model (default: `text-embedding-qwen3-embedding-8b`)
- `CC_EXTRACTION_MODEL` - Extraction model (default: `claude-haiku-4-5-20251001`)
- `CLAUDE_MEMORY_DEBUG` - Set to `1` for debug logging to `~/.claude-memory/debug.log`

## Development

```bash
pnpm install
pnpm build          # Compile TypeScript
pnpm test           # Run tests
pnpm test:watch     # Watch mode
```

### Debug Logging

Set `CLAUDE_MEMORY_DEBUG=1` in your hook configuration. Logs go to:
- stderr (captured by Claude Code)
- `~/.claude-memory/debug.log` (persistent file)

Log format: `[launcher|worker] {timestamp} +{elapsed}ms {message}`

## Key Implementation Details

### Hook Exit Timing
The SessionEnd hook launcher MUST exit immediately. Claude Code waits for the hook process, and slow hooks get cancelled. Solution:
1. Read stdin synchronously (avoid async event loop)
2. Write payload to temp file
3. Spawn worker with ALL stdio ignored
4. Exit immediately (~2ms)

### Embedding Dimension
Milvus collection uses 4096-dimensional embeddings (Qwen3 compatible). Embedding dimension is enforced at insert/update time.

### Deduplication
Before inserting, `findSimilar()` checks for existing records with >0.9 cosine similarity. Duplicates update counters instead of creating new records.

## Dashboard

Web-based dashboard for viewing memories, stats, and testing context injection.

```bash
cd dashboard
pnpm install
pnpm start          # Runs server (port 3001) + Vite dev (port 5173)
```

### Views
- **Overview**: Aggregate stats, memory counts by type/project/domain, usage metrics
- **Memory Pool**: Filterable/searchable list of all memories with detail view
- **Context Preview**: Input a prompt, see what would be injected

### API Endpoints
- `GET /api/stats` - Aggregate statistics
- `GET /api/memories` - List memories with filtering (type, project, deprecated)
- `GET /api/memories/:id` - Get single memory
- `GET /api/search?q=...` - Hybrid search
- `POST /api/preview` - Preview context injection for a prompt

## File Structure

```
src/
├── hooks/
│   ├── pre-prompt.ts          # Memory injection hook
│   ├── post-session.ts        # Launcher (fast exit)
│   └── post-session-worker.ts # Background extraction
├── lib/
│   ├── types.ts               # Record schemas, config types
│   ├── milvus.ts              # Vector DB operations
│   ├── embed.ts               # Embedding API client
│   ├── extract.ts             # LLM extraction + usefulness rating
│   ├── context.ts             # Signal extraction, context building
│   ├── transcript.ts          # Transcript parsing
│   ├── session-tracking.ts    # Injected memory tracking
│   ├── promotions.ts          # Discovery → Procedure promotion
│   └── maintenance.ts         # Maintenance operations
├── maintenance.ts             # CLI maintenance entry point
dashboard/
├── server/
│   └── index.ts               # Express API server
├── src/
│   ├── components/            # React components
│   ├── hooks/                 # React hooks
│   ├── lib/                   # Utilities
│   ├── pages/                 # Page components
│   ├── App.tsx                # Main app
│   └── main.tsx               # Entry point
└── package.json
```
