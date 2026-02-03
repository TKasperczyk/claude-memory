# Future Improvements

Prioritized list of features to enhance continuous learning capabilities.

## High Impact, Moderate Effort

### 1. Contradiction Detection ❌ REMOVED

**Problem**: "Project uses React" stays valid even after "Migrated to Vue" is added. Stale facts are worse than no facts.

**Original Solution**: During maintenance, find semantically similar records (>0.75 similarity) of same type/project with different content. The newer record supersedes the older.

**Why Removed**: Testing revealed that 0.75 similarity captures complementary knowledge (e.g., page structure vs component details), not contradictions. The LLM arbitration consistently returned "keep_both" because the pairs were additive, not conflicting. The operation was conceptually flawed - similar knowledge isn't contradictory knowledge.

**Underlying code kept**: `findContradictionPairs()`, `checkContradiction()` etc. remain in `lib/maintenance.ts` for potential future use in an "alternative detection" feature that links related approaches rather than deprecating them.

---

### 2. Retrieval Diversity (MMR) ✅ IMPLEMENTED

**Problem**: If prompt matches 3 similar error memories, you inject redundant context wasting tokens.

**Solution**: Use Maximal Marginal Relevance - after picking top result, penalize subsequent results that are similar to already-selected ones.

**Implementation**: `applyMMR()` and `cosineSimilarity()` in `pre-prompt.ts`, applied after `searchMemories()`.

**Key details**:
- Lambda = 0.7 (70% relevance, 30% diversity penalty)
- `hybridSearch` supports `includeEmbeddings: true` to return vectors
- Records without embeddings gracefully degrade (appended at end)

---

### 3. Explicit User Feedback Channel

**Problem**: Usefulness rating is passive (inferred from transcript). User knows when a memory misled them.

**Solution**:
- Command: `#memory wrong <id>` or `#memory helpful <id>`
- Dashboard: Buttons to mark memory as incorrect/outdated/helpful
- API endpoint: `POST /api/memories/:id/feedback`

**Implementation**:
- Add `userFeedback?: 'helpful' | 'wrong' | 'outdated'` field to MemoryRecord
- Wrong/outdated triggers deprecation
- Helpful boosts usageCount significantly

---

## Medium Impact, Lower Effort

### 4. Time Decay in Scoring

**Current**: `usageRatio * usageWeight` boosts ranking.

**Add**:
```typescript
const daysSinceUsed = (Date.now() - record.lastUsed) / (1000 * 60 * 60 * 24)
const recencyBoost = 1 / (1 + daysSinceUsed / 30)  // Half-life of 30 days
const finalScore = baseScore + (recencyBoost * recencyWeight)
```

---

### 5. Global vs Project-Scoped Memories ✅ IMPLEMENTED

**Problem**: "pnpm peer deps require --shamefully-hoist" is useful everywhere, but scoped to one project.

**Solution**:
- Add `scope: 'global' | 'project'` field
- At extraction, let Haiku mark universal knowledge as global
- Retrieval: Always include global matches alongside project-scoped

**Implementation**:
- `scope` field added to `BaseRecord` in `types.ts`
- Milvus schema updated with migration (`ensureSchemaFields`)
- Extraction prompt includes scope guidance for all record types
- `hybridSearch` filter: `(project == X OR scope == "global")` when project is set
- Defaults to `'project'` for backwards compatibility

---

### 6. Exploration Sampling

**Problem**: Low-scored memories never get retrieved → never prove useful → permanently low score.

**Solution**: With small probability (5%), inject one random unrated memory alongside normal results.

```typescript
if (Math.random() < 0.05) {
  const unrated = await queryRecords({
    filter: 'retrieval_count == 0',
    limit: 1,
    randomSample: true
  })
  if (unrated.length > 0) results.push(unrated[0])
}
```

---

## Lower Priority

### 7. Memory Summarization

Periodically cluster similar memories and create a summary memory. E.g., 5 separate "auth error" memories → 1 consolidated "Auth troubleshooting" procedure.

### 8. Confidence Tracking

Track extraction confidence from Haiku. Weight low-confidence memories lower in retrieval. Flag for human review in dashboard.

---

## Implementation Priority

1. ~~**Contradiction detection**~~ - Removed (see above)
2. **MMR diversity** ✅ - Quick win, improves context quality
3. **User feedback command** - Low effort, high signal
4. **Time decay** - Simple scoring adjustment
5. **Global scope** ✅ - Requires schema + extraction changes
6. **Exploration** - Easy but lower priority
