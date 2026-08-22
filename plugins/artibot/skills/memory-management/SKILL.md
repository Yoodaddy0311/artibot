---
context: fork
user-invocable: false
name: memory-management
description: |
  BlenderBot-inspired long-term memory and RAG search system for persisting
  user preferences, project contexts, command patterns, and error resolutions
  across sessions.
  Auto-activates when: session start/end, error resolution, user preferences stated, context retrieval needed.
  Triggers: memory, recall, context, persist, store, preferences, history, patterns,
  메모리, 기억, 컨텍스트, 선호, 패턴, 히스토리
lang: [en, ko]
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 2
triggers:
  - "memory"
  - "context"
  - "persist"
  - "store"
  - "recall"
agents:
  - "orchestrator"
tokens: "~2K"
category: "learning"
source_hash: 0dba3114
whenNotToUse: "Do not persist memory for single-session tasks that have no reuse value across sessions. Do not store sensitive data (API keys, passwords, personal user data) in any memory store. Skip memory operations when running in ephemeral CI environments where the memory directory is discarded after the run."
---
# Memory Management

## When This Skill Applies
- Session start: load previous memories and relevant context
- Session end: summarize and persist session learnings
- Error resolution: save error pattern + solution pairs
- User states preferences: persist across sessions
- Command patterns: track frequently used workflows
- Context retrieval: search past memories for current task relevance

## Architecture

**BlenderBot Memory Model**:
```
Session Memory (in-process)
  |-- Current task, environment, active agents
  |-- Volatile, lives only during session
  |
Long-Term Memory (~/.claude/artibot/memory/)
  |-- user-preferences.json   (permanent TTL)
  |-- project-contexts.json   (90-day TTL)
  |-- command-history.json    (7-day TTL)
  |-- error-patterns.json    (90-day TTL)
  |
RAG Search Layer
  |-- Keyword tokenization + relevance scoring
  |-- Recency weighting + access frequency bonus
  |-- Cross-store search with type filtering
```

## Memory Types

| Type | Store | TTL | Purpose |
|------|-------|-----|---------|
| preference | user-preferences.json | permanent | User preferences, tool settings, communication style |
| context | project-contexts.json | 90 days | Project-specific context, architecture decisions |
| command | command-history.json | 7 days | Command usage patterns, frequent workflows |
| error | error-patterns.json | 90 days | Error + resolution pairs for faster debugging |

## Core Operations

**Save Memory**: `saveMemory(type, data, options?)` - Persist a typed entry with auto-tagging and TTL
**Search Memory**: `searchMemory(query, options?)` - Keyword-based RAG search across stores
**Get Context**: `getRelevantContext(context)` - Aggregate relevant memories for current state
**Summarize Session**: `summarizeSession(sessionData)` - Compress session history into storable summary
**Prune Memories**: `pruneOldMemories()` - Remove expired entries across all stores

## RAG Search Scoring

Relevance score (0-1) combines:
- **Keyword overlap** (60%): query tokens matched against entry tags
- **Recency** (25%): newer entries score higher, decays over 90 days
- **Access frequency** (15%): frequently accessed entries get bonus

## Hook Integration

| Hook Event | Memory Action |
|------------|---------------|
| SessionStart | Load previous memories, inject relevant context |
| SessionEnd | Summarize session, persist learnings |
| Error | Save error pattern + resolution to error-patterns.json |
| Command | Track command usage in command-history.json |

## Workflow Checklist

Copy this checklist and track progress:

```
Progress:
- [ ] Step 1: SessionStart — load previous memories and inject relevant context
- [ ] Step 2: During session — save memories as they arise (type + data + tags)
- [ ] Step 3: Search memories via RAG when context needed (keyword + recency + frequency)
- [ ] Step 4: SessionEnd — summarize session and persist learnings
- [ ] Step 5: Save error patterns when errors are resolved
- [ ] Step 6: Prune expired entries across all stores
```

## Human Checkpoints

### Checkpoint 1: 메모리 저장 가치 판단 (After Step 2)
**Context**: 세션 중 메모리 저장 요청이 발생한 시점. 세션 한정 임시 정보를 장기 메모리로 오저장하면 스토어가 오염되고 RAG 정확도가 낮아진다.
**Ask**: "이 정보를 장기 메모리로 저장하려 합니다. **이 내용이 다음 세션에도 유용한 정보인가요, 아니면 현재 세션에만 해당하는 내용인가요?**"
**Options**:
1. Save — 장기 메모리로 저장 (적절한 타입 + TTL 설정)
2. Skip — 세션 한정 정보로 저장하지 않음
**Default**: 1 (불확실할 경우 저장 후 TTL 만료로 자연 정리)
**Skippable**: No — 잘못된 저장은 메모리 품질을 영구 저하시킬 수 있음
**Freedom**: MEDIUM

### Checkpoint 2: 세션 요약 정확도 승인 (After Step 4)
**Context**: 세션 종료 시 자동 생성된 요약이 퍼시스턴스 직전에 있는 시점. 부정확한 요약은 향후 RAG 검색 품질과 컨텍스트 복원에 직접 영향을 미친다.
**Ask**: "세션 요약이 생성되었습니다. **요약 내용이 이번 세션의 핵심을 정확하게 담고 있나요?**"
**Options**:
1. Persist — 요약을 그대로 저장
2. Edit summary — 요약 내용 수정 후 저장
3. Skip — 이번 세션은 요약을 저장하지 않음
**Default**: 1 (자동 생성 요약은 대부분 충분히 정확)
**Skippable**: No — 세션 학습의 영구 손실이 발생할 수 있음
**Freedom**: HIGH

### Checkpoint 3: 프루닝 안전성 확인 (After Step 6)
**Context**: TTL 만료 항목 삭제 직전 시점. 규칙 기반 삭제라도 중요한 컨텍스트가 포함된 항목이 있을 수 있어 확인이 필요하다.
**Ask**: "만료 항목 삭제 목록이 준비되었습니다. **삭제될 항목 중 TTL을 연장해야 할 중요한 메모리가 있나요?**"
**Options**:
1. Prune — 목록대로 삭제 진행
2. Extend TTL on specific entries — 특정 항목의 TTL 연장 후 나머지만 삭제
**Default**: 1 (TTL 규칙은 정의된 대로 따르는 것이 원칙)
**Skippable**: No — 복구 불가능한 삭제이므로 확인 필수
**Freedom**: LOW

## Freedom Levels

| Step | Freedom | Guidance |
|------|:-------:|----------|
| Load previous memories | LOW | Automatic at session start |
| Save memories | MEDIUM | Type classification requires judgment, format is defined |
| RAG search | MEDIUM | Query formulation flexible, scoring formula is fixed |
| Summarize session | HIGH | Summary content and depth are judgment calls |
| Save error patterns | MEDIUM | Error + resolution pair format defined, selection flexible |
| Prune expired | LOW | TTL rules are defined, follow exactly |

## Anti-Patterns
- Do NOT store sensitive data (API keys, passwords, tokens) in memory
- Do NOT save session-specific temporary state as long-term memory
- Do NOT skip TTL - every non-preference memory must expire
- Do NOT store unverified patterns - require 2+ occurrences before persisting as preference
- Do NOT let memory stores grow unbounded - enforce size limits and prune regularly

## Quick Reference
- Memory dir: `~/.claude/artibot/memory/`
- Preferences: permanent, deduplicated by key
- Contexts: 90-day TTL, project-scoped
- Commands: 7-day TTL, max 500 entries
- Errors: 90-day TTL, max 200 entries
- Search: keyword-based RAG with recency weighting

## Rationalizations

The following table captures common excuses agents make to skip the discipline of this skill, paired with factual rebuttals.

| Excuse | Rebuttal |
|--------|----------|
| "the context window is my memory" | context is working memory, not long-term — it evicts on every session boundary and every compaction |
| "RAG is too complex for a side project" | a flat file with embeddings is 30 lines of code; "too complex" is the excuse, not the reality |
| "I'll persist memory when I have time" | persistence deferred = information lost — every session without it is irrecoverable |
| "storing user preferences is a privacy risk" | storing locally with scoped access is the opposite of a privacy risk; it's how you avoid re-asking |
| "memory search returns irrelevant results" | irrelevance is a retrieval tuning problem, not a memory problem — fix the scorer, don't abandon the store |

## Common Rationalizations

| Rationalization | Why it's wrong | What to do instead |
|---|---|---|
| "Session summaries are redundant because I can re-read the conversation" | Conversation history is unavailable after session end; summaries are the only cross-session continuity mechanism — without them every session starts from zero | Call `summarizeSession()` at session end unconditionally, even if the summary is brief |
| "RAG scoring is complex so I'll just store everything and search later" | Storing everything without type classification pollutes the store and degrades retrieval precision; irrelevant memories score above relevant ones in noisy stores | Classify each memory entry with the correct type before saving — preference, context, command, or error |
| "Error patterns don't need memory because I can look at the logs" | Logs are unindexed and unavailable across sessions; error-pattern memory enables RAG retrieval of the exact solution that worked last time for the same error | Save every error-resolution pair with the error message, root cause, and fix as tags |
| "TTL management is a background task I'll schedule eventually" | Expired memories that are never pruned accumulate until the store is too noisy to be useful; pruning is a correctness requirement, not housekeeping | Call `pruneOldMemories()` at session start, before loading context — it takes milliseconds |
| "Storing user preferences locally is unnecessary since I ask every session" | Re-asking known preferences degrades user experience and wastes context budget; permanent-TTL preference memory eliminates re-asking entirely | Store every stated preference with `type: "preference"` and `ttl: null` immediately when the user states it |

## Red Flags

- `summarizeSession()` never called at session end
- Memory store growing beyond 200 error entries without a prune call
- User preference asked in consecutive sessions for the same user
- Memory entry saved without a type field (type is required for RAG scoring)
- Sensitive data (tokens, passwords, PII) present in any memory JSON file
- RAG query returning zero results when recent relevant sessions exist (scorer misconfiguration signal)
