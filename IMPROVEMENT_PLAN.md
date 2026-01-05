# Claude Memory: Improvement Plan

Analysis of remaining concerns and proposed solutions.

---

## 1. Generalization Operation

### The Concern
The generalization maintenance operation removes instance-specific details (session IDs, temp paths, timestamps) from records after extraction. This feels like a band-aid for imperfect extraction rather than fixing extraction at the source.

If extraction is doing its job, these artifacts shouldn't exist in records. Running a second pass adds complexity and maintenance cost without addressing the root cause.

### Needs Confirmation?
**Yes.** Before removing or modifying:
- Query Milvus for records where `generalized = true`
- Examine what was actually generalized (compare original vs current content if logged)
- Count frequency: How often does generalization actually trigger?
- Categorize: What types of artifacts are being cleaned up?

If generalization rarely triggers or only catches edge cases, it may be worth keeping as a safety net. If it triggers frequently, extraction prompts need tightening.

### Suggestions
**Option A: Tighten extraction, remove generalization**
- Audit extraction prompt for gaps that allow artifacts through
- Add explicit negative examples: "Do NOT include session IDs, temp paths like /tmp/xxx, timestamps"
- Remove generalization operation entirely
- Monitor for regression

**Option B: Keep as safety net, reduce frequency**
- Keep generalization but run it less frequently (monthly instead of weekly)
- Log what it catches to inform extraction improvements
- Treat it as a feedback mechanism, not a primary cleanup

**Option C: Move to ingestion time**
- Run generalization check immediately after extraction, before insertion
- Reject or fix records at ingestion rather than periodic cleanup
- Faster feedback loop, cleaner storage

---

## 2. Contradiction Resolution

### The Concern
The contradiction detection uses 0.75 cosine similarity to find "conflicting" records, then uses LLM to decide which to keep. The fundamental problem: **similar solutions aren't contradictions, they're alternatives**.

Example:
```
systemctl restart nginx
nginx -s reload
```

These are 2 valid ways to restart nginx. High similarity, but not contradictory. The current logic might deprecate one, losing useful knowledge.

### Needs Confirmation?
**Yes.** Before changing:
- Review the contradiction detection logs or run a dry-run
- Examine cases where contradictions were detected
- Categorize: True contradictions vs alternative solutions vs duplicates
- Check if the LLM arbitration is making good decisions

### Suggestions
**Option A: Rename and reframe as "alternative detection"**
- Keep the similarity detection but change the outcome
- Instead of deprecating, create explicit links: `alternatives: [id1, id2, id3]`
- During injection, present alternatives together: "Two approaches found..."

**Option B: Raise similarity threshold**
- Current 0.75 catches too much
- Raise to 0.85 or 0.90 to only catch near-duplicates
- True contradictions (same problem, incompatible solutions) are rare

**Option C: Add contradiction type classification**
- LLM classifies: "duplicate", "alternative", "supersedes", "contradicts"
- Different handling per type:
  - Duplicate → merge
  - Alternative → link
  - Supersedes → deprecate old, link as superseded_by
  - Contradicts → flag for manual review

**Option D: Remove entirely**
- If contradiction detection rarely produces value, cut it
- Simplify maintenance operations
- Rely on usage metrics to naturally deprioritize bad records

---

## 3. Global Promotion Heuristics

### The Concern
Global promotion currently uses keyword matching against `COMMON_TOOLS` (npm, docker, git, etc.) to decide if a record should be promoted from project scope to global scope. This is fragile:

- A Docker command that works on your setup might use specific network configs
- A git command with specific remote URLs isn't universal
- The keyword list is static and incomplete

### Needs Confirmation?
**Partially.** Review what has been promoted:
- Query records where `scope = 'global'` and check if they're truly universal
- Look for false positives: project-specific knowledge marked global
- Check if promotions are actually useful across projects

### Suggestions
**Option A: LLM-based promotion decision**
- Replace keyword heuristics with LLM evaluation
- Question: "Is this knowledge universally applicable regardless of project/environment?"
- Consider: Does it reference specific paths, configs, project names?
- Higher accuracy, acceptable latency for maintenance operation

**Option B: Evidence-based promotion**
- Track cross-project retrieval: If a record is retrieved in 3+ different projects, promote
- Requires: Cross-project tracking during pre-prompt
- Organic promotion based on actual utility

**Option C: Manual promotion only**
- Remove automatic promotion entirely
- Surface candidates in dashboard for manual review
- User decides what's truly global
- Slower but safer

**Option D: Hybrid - LLM with evidence boost**
- LLM makes initial judgment
- Evidence (cross-project retrieval) confirms or overrides
- Best accuracy, most complex

---

## 4. Retrieval-Time Domain Filter

### The Concern
At retrieval time, `inferDomain()` uses file markers (package.json → node) to determine domain context. This is used to filter or prioritize memories. The issue: cross-domain queries get deprioritized.

Example: You're in a Node project (`package.json` present) but asking about Docker. The inferred domain is "node", potentially deprioritizing Docker memories even though they're relevant to the query.

### Needs Confirmation?
**Yes.** Check current behavior:
- Is domain actually used as a hard filter, or just a ranking boost?
- Test cross-domain queries: In a Node project, ask about Docker commands
- Measure: Are relevant cross-domain memories surfaced?

If semantic search is strong enough to overcome domain bias, this might be a non-issue.

### Suggestions
**Option A: Remove domain filter entirely**
- Let semantic matching handle relevance
- Domain stored for metadata, not used for filtering
- Simplest solution

**Option B: Query intent detection**
- Extract domain signals from the query, not just the cwd
- "how do I restart nginx" → domain = "sysadmin" regardless of project type
- Query domain overrides project domain

**Option C: Soft boost instead of filter**
- Domain match adds small ranking boost (+0.05)
- But doesn't filter out non-matching domains
- Preserves relevance while respecting context

**Option D: Multi-domain search**
- Detect multiple domains (project domain + query domain)
- Search both, merge results
- Covers cross-domain cases explicitly

---

## 5. No Negative Memory

### The Concern
The system learns what works but not what to avoid. Failed commands increment `failureCount`, but there's no explicit mechanism for "don't do X, it breaks Y" or "X was superseded by Y".

Scenario: You try command A, it fails. You find command B works. Command A still exists with `failureCount: 1`. Future sessions might still retrieve A. There's no link saying "B supersedes A".

### Needs Confirmation?
**Partially.** Check current behavior:
- How are high-failure records ranked?
- Does `failureCount` effectively suppress bad memories?
- Are there cases where known-bad approaches keep getting suggested?

If usage ratio already handles this (low usage + high retrieval = deprioritized), explicit negative memory might be unnecessary.

### Suggestions
**Option A: Supersession links**
- Add `superseded_by: string | null` field to records
- During extraction, if detecting a fix for a previous failure, link them
- During injection, if superseded record would be surfaced, show superseding record instead

**Option B: Explicit "avoid" records**
- New record type: `AvoidRecord`
- Fields: `what`, `why`, `alternative_id`
- Extracted when Claude says "don't do X because Y, do Z instead"
- Surfaced as warnings during injection

**Option C: Failure threshold deprecation**
- If `failureCount > N` and `successCount < M`, auto-deprecate
- Simple heuristic, no new fields needed
- Might be too aggressive for commands that fail in some contexts but work in others

**Option D: Context-aware failure tracking**
- Track failure contexts (which project, which conditions)
- "Command X fails in project A but works in project B"
- Complex but accurate

---

## 6. Extraction Quality Monitoring

### The Concern
Everything downstream depends on Haiku producing clean, accurate records. If extraction is sloppy (wrong commands, bad paraphrasing, missing context), the entire system degrades. Currently, there's no visibility into extraction quality.

### Needs Confirmation?
**Yes.** Assess current quality:
- Sample 20-30 recent extractions
- Compare extracted records against source transcripts
- Categorize issues: exact text mangled, wrong classification, missing records, hallucinated records
- Calculate rough accuracy rate

### Suggestions
**Option A: Dashboard quality review**
- Add "review queue" to dashboard
- Show recent extractions with source transcript snippets
- Allow marking records as "good", "needs edit", "delete"
- Track quality metrics over time

**Option B: Extraction validation pass**
- After Haiku extracts, run quick validation:
  - Command fields contain valid shell syntax?
  - Error fields contain actual error patterns?
  - Discovery fields have evidence?
- Reject malformed records at ingestion

**Option C: Dual extraction with comparison**
- Extract twice with different prompts or temperatures
- Compare outputs, flag discrepancies for review
- Expensive but catches hallucinations

**Option D: Periodic spot-check alerts**
- Random sampling: Every N extractions, flag one for manual review
- Alert if quality drops below threshold
- Low overhead continuous monitoring

---

## Priority Ranking

| Concern | Impact | Effort | Priority |
|---------|--------|--------|----------|
| Contradiction Resolution | Medium | Low | **High** - conceptually broken, quick fix |
| Global Promotion | Medium | Medium | **High** - affects scope accuracy |
| Extraction Quality Monitoring | High | Medium | **Medium** - important but not urgent |
| Negative Memory | Medium | Medium | **Medium** - nice to have |
| Retrieval Domain Filter | Low | Low | **Low** - might be non-issue |
| Generalization Operation | Low | Low | **Low** - needs data first |

---

## Recommended Order

1. **Confirm retrieval domain behavior** - Quick test to see if this is even a problem
2. **Audit generalization and contradiction logs** - Get data before changing
3. **Fix contradiction resolution** - Reframe as alternatives, not conflicts
4. **Implement LLM-based global promotion** - Replace heuristics
5. **Add extraction quality dashboard** - Visibility into the critical dependency
6. **Design negative memory approach** - Based on whether failure tracking is sufficient

---

## Data Collection Tasks

Before implementing changes, gather:

1. `SELECT COUNT(*) FROM cc_memories WHERE generalized = true` - How often does generalization trigger?
2. Review maintenance logs for contradiction resolution decisions
3. `SELECT * FROM cc_memories WHERE scope = 'global' LIMIT 20` - Quality check promoted records
4. Test cross-domain retrieval manually (Node project, Docker query)
5. Sample 20 recent extractions, compare to source transcripts
