# Comparison: claude-memory vs kira-runtime + kira-memory

## Architecture

| Aspect | claude-memory | kira-runtime + kira-memory |
|--------|---------------|----------------------------|
| **Integration** | Hook-based (Claude Code hooks) | Full autonomous runtime + MCP server |
| **Entry Points** | `pre-prompt.js`, `post-session.js` | Runtime with Ink CLI, autonomous tick mode |
| **Persistence** | LanceDB (embedded) | Vector DB + JSONL stream + SQLite (commitments) + JSON files |

## Memory Model

| Aspect | claude-memory | kira-memory |
|--------|---------------|-------------|
| **Record Types** | 4: command, error, discovery, procedure | 5 sectors: facts, moments, promises, observations, banter |
| **Embedding Dim** | 1536 (Jina code) | 4096 (Qwen3 8b) |
| **Tier System** | None | T1-T4 evolutionary tiers |
| **Decay** | None (stale check only) | Half-life decay per sector, retrieval-aware modifiers |
| **Heat Score** | None | Composite: retrievals + win rate + recency |
| **Lineage** | None | Parent/child tracking for merged memories |

## Extraction Flow

| Aspect | claude-memory | kira-memory |
|--------|---------------|-------------|
| **When** | SessionEnd + PreCompact hooks | After each exchange (background) |
| **Model** | Haiku 4.5 | Haiku |
| **Async** | Yes (detached worker) | Yes (background task) |
| **Domain Guidance** | Injects existing domains | N/A (uses sectors) |

## Injection Flow

| Aspect | claude-memory | kira-memory |
|--------|---------------|-------------|
| **When** | UserPromptSubmit hook | During turn context compilation |
| **Strategy** | Keyword-first, then semantic | RecallManager with sticky pool |
| **Caching** | None | 20-memory sticky pool, reused across turns |
| **Refresh Logic** | Every prompt | On entity detection, explicit cues, or 6+ turns |
| **Feedback** | None | Rate memories helpful/not-helpful, affects decay |

## Deduplication

| Aspect | claude-memory | kira-memory |
|--------|---------------|-------------|
| **On Save** | Auto-update if ≥90% similar | Warn only (≥75%), user decides |
| **Consolidation** | Maintenance script (same type/domain/project) | Manual via `kira_consolidate` tool |

## Key Gaps in claude-memory

1. **No sticky pool** - Searches the vector DB on every prompt (more latency)
2. **No feedback loop** - Doesn't track if injected memories were useful
3. **No decay system** - Memories don't fade based on age/usefulness
4. **No tier system** - All memories treated equally
5. **No heat scoring** - No unified ranking metric
6. **No lineage** - Can't track memory merges/derivations
7. **Session-scoped** - Extracts at session end, not incrementally

## What claude-memory Does Well

1. **Simpler** - Hook-based, no runtime to manage
2. **Technical focus** - Commands, errors, procedures fit Claude Code use case
3. **Domain-aware extraction** - Guides Haiku to use consistent domains
4. **Hybrid search** - Keyword + semantic for better precision
5. **Async exit** - Doesn't block CLI shutdown
6. **PreCompact support** - Captures memories before context compaction

## Potential Enhancements from kira-memory

1. **Sticky pool** - Cache recent memories, avoid repeated searches
2. **Usefulness feedback** - Track if injected memories helped, adjust ranking
3. **Heat-based ranking** - Factor in retrieval count + usefulness + recency
4. **Incremental extraction** - Extract after each turn, not just session end
5. **Decay** - Age out unused memories over time
