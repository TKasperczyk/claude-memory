# Claude Memory: Improvement Plan

Analysis of concerns and implementation status.

---

## Status Summary

| Concern | Status | Notes |
|---------|--------|-------|
| Generalization Operation | **Addressed** | LLM-based evaluation |
| Contradiction Resolution | **Addressed** | LLM-based with `keep_both` verdict |
| Global Promotion | **Addressed** | Hybrid: heuristic filter + LLM decision |
| Retrieval Domain Filter | **Addressed** | Soft filter with fallback |
| Low Usage Deprecation | **Addressed** | `findLowUsageRecords()` implemented |
| Dashboard Maintenance | **Addressed** | Full UI with dry-run/execute |
| Negative Memory | **Not implemented** | No supersession links |
| Extraction Quality Monitoring | **Not implemented** | No review queue |

---

## 1. Generalization Operation

### Original Concern
The generalization maintenance operation removes instance-specific details (session IDs, temp paths, timestamps) from records after extraction. This feels like a band-aid for imperfect extraction.

### Current Implementation: **LLM-Based**
- `checkGeneralization()` in `maintenance.ts` uses LLM to evaluate records
- Prompt asks: "Is this memory too specific? Does it contain ephemeral details?"
- LLM returns `{ shouldGeneralize, reason, generalized }`
- Only updates if LLM identifies specific issues

### Assessment
This is a reasonable safety net. The LLM evaluation ensures only genuinely problematic records are modified. The original concern about "band-aid for extraction" is mitigated because:
1. Extraction should catch most issues
2. Generalization is a second-pass safety net
3. LLM-based, not pattern-based, so it's intelligent about what to change

**Recommendation**: Keep as-is. Monitor trigger frequency via dashboard.

---

## 2. Contradiction Resolution

### Original Concern
Using 0.75 similarity to detect "contradictions" was conceptually wrong - similar solutions aren't contradictions, they're alternatives.

### Current Implementation: **LLM-Based with Nuanced Verdicts**
```typescript
verdict: 'keep_newer' | 'keep_older' | 'keep_both' | 'merge'
```

The `CONTRADICTION_PROMPT` explicitly handles:
- **Contradicting**: One supersedes or corrects the other
- **Complementary**: Both can be true simultaneously, they add to each other

The `keep_both` verdict preserves alternative solutions.

### Assessment
This directly addresses the concern. The LLM can distinguish between:
- True contradictions (keep newer, deprecate older)
- Alternative approaches (keep both)
- Near-duplicates that should merge

**Recommendation**: Well implemented. No changes needed.

---

## 3. Global Promotion

### Original Concern
Keyword matching against `COMMON_TOOLS` was fragile and could promote context-dependent commands.

### Current Implementation: **Hybrid Approach**
1. `isGlobalCandidate()` - Heuristic pre-filter using keyword lists
2. `checkGlobalPromotion()` - LLM decision with `GLOBAL_PROMOTION_PROMPT`

The prompt asks:
- "Is this universally applicable across different projects?"
- Criteria for global: standard tools, generic commands, universal patterns
- Criteria for project: specific paths, custom setup, project-specific domain

LLM returns `{ shouldPromote, confidence, reason }`.

### Assessment
The hybrid approach is sensible:
- Heuristics reduce LLM calls (only candidates go to LLM)
- LLM makes the actual decision with full context
- Confidence levels allow filtering (`GLOBAL_PROMOTION_MIN_CONFIDENCE = 'medium'`)

**Recommendation**: Well implemented. Monitor promoted records via dashboard.

---

## 4. Retrieval-Time Domain Filter

### Original Concern
File-marker based domain inference might deprioritize cross-domain memories.

### Current Implementation: **Soft Filter with Fallback**
```typescript
// pre-prompt.ts
let results = await searchWithScope(cleanPrompt, signals, config, scope, embedding, signal)
if (results.length === 0 && scope.project) {
  // Fallback: remove project filter but preserve domain
  results = await searchWithScope(cleanPrompt, signals, config, { domain: scope.domain }, embedding, signal)
}
```

Domain is passed to `hybridSearch` as a filter parameter, not a hard blocker. If no results, it falls back to domain-only (removing project filter).

### Assessment
This is a reasonable trade-off:
- Domain filtering reduces noise in most cases
- Fallback ensures cross-domain queries still work
- Semantic search can still surface relevant results regardless of domain

**Recommendation**: Monitor in practice. If cross-domain queries frequently miss relevant memories, consider Option B (query intent detection) from original plan.

---

## 5. Low Usage Deprecation

### Status: **Implemented**
- `findLowUsageRecords()` - Records retrieved N+ times with <10% usage ratio
- `findLowUsageHighRetrieval()` - Records retrieved 10+ times with 0 usage

This implements implicit negative signal: memories that are injected but never help get deprioritized.

---

## 6. Dashboard Maintenance

### Status: **Implemented**
Full maintenance UI at `/maintenance`:
- List of all maintenance operations with descriptions
- **Preview** (dry-run) button for each operation
- **Run** (execute) button with confirmation modal
- **Batch operations** - Preview all / Run all with SSE streaming progress
- Real-time progress indicators during batch runs
- Results panel showing actions taken, duration, summary stats

---

## 7. Negative Memory (NOT IMPLEMENTED)

### The Concern
The system learns what works but not what to avoid. Failed commands increment `failureCount`, but there's no explicit "don't do X" or "Y supersedes X" mechanism.

### Current State
- `failureCount` field exists and is incremented
- Low usage deprecation helps suppress unhelpful records
- No `superseded_by` field or alternative linking

### Remaining Options
**Option A: Supersession links**
- Add `superseded_by: string | null` field to records
- During extraction, if detecting a fix for a previous failure, link them
- During injection, if superseded record would be surfaced, show superseding record instead

**Option B: Implicit via usage ratio**
- Current system may already handle this
- Failed commands get low usage (not helpful)
- Low usage → deprioritized in ranking → eventually deprecated
- No explicit linking needed

### Recommendation
**Test Option B first.** Check if the usage ratio mechanism effectively suppresses bad memories:
1. Find records with high `failureCount` and low `usageCount`
2. Check their ranking in search results
3. If they're being surfaced despite poor metrics, implement supersession links

---

## 8. Extraction Quality Monitoring (NOT IMPLEMENTED)

### The Concern
Everything depends on Haiku producing clean records. No visibility into extraction quality.

### Current State
- No review queue in dashboard
- No quality metrics
- No spot-check mechanism

### Remaining Options
**Option A: Dashboard quality review**
- Add "Recent Extractions" view showing last N records with source snippets
- Allow marking as "good", "needs edit", "delete"
- Track quality metrics over time

**Option B: Extraction validation pass**
- Command fields contain valid shell syntax (parse test)
- Error fields contain actual error patterns (regex check)
- Discovery fields have evidence (non-empty check)
- Reject malformed at ingestion

**Option C: Periodic spot-check alerts**
- Flag random extractions for manual review
- Low overhead continuous monitoring

### Recommendation
Start with **Option A** - dashboard visibility is the foundation. Once you can see extraction quality, you can decide if validation or spot-checks are needed.

---

## Remaining Priority

| Concern | Priority | Reason |
|---------|----------|--------|
| Extraction Quality Dashboard | **Medium** | Visibility into critical dependency |
| Negative Memory | **Low** | Test if usage ratio handles it first |

---

## Data Collection Tasks (Updated)

1. ~~Audit generalization and contradiction~~ - Now LLM-based, working correctly
2. ~~Global promotion quality~~ - Now LLM-based with confidence threshold
3. **Test negative memory scenario**: Find high-failure records, check if they're suppressed
4. **Sample extraction quality**: Compare 20 recent records against source transcripts
5. **Cross-domain test**: In a Node project, query for Docker - verify relevant memories surface
