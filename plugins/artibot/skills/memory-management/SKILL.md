---
name: memory-management
description: |
  BlenderBot-inspired long-term memory and RAG search system for persisting
  user preferences, project contexts, command patterns, and error resolutions
  across sessions.
  Triggers: memory, remember, recall, context, preferences, history, patterns,
  메모리, 기억, 컨텍스트, 선호, 패턴, 히스토리
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 2
triggers:
  - "memory"
  - "context"
  - "session"
  - "remember"
  - "persist"
  - "store"
  - "recall"
agents:
  - "orchestrator"
tokens: "~2K"
category: "learning"
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
