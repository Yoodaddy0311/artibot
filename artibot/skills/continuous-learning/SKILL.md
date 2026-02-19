---
name: continuous-learning
description: |
  Pattern extraction and learning from development sessions.
  Identifies reusable patterns, common mistakes, and successful
  strategies for future sessions.

  Use proactively at session end (Stop hook), after completing
  complex tasks, or when patterns worth preserving are identified.

  Triggers: learn, pattern, remember, session end, extract,
  improvement, recurring, lesson learned,
  학습, 패턴, 기억, 세션종료, 추출,
  学習, パターン, セッション終了

  Do NOT use for: real-time task execution, code implementation,
  or testing.
---

# Continuous Learning

> Extract patterns from work. Apply them in future sessions.

## When This Skill Applies

- Session ending (Stop hook trigger)
- Complex task completed successfully
- Recurring pattern identified across sessions
- Mistake or anti-pattern discovered
- New project convention established

## Learning Pipeline

### 1. Session Evaluation (Stop Hook)
At session end, evaluate:
- What techniques worked well?
- What mistakes were made?
- What patterns emerged?
- What would be done differently?

### 2. Pattern Extraction
Identify patterns worth preserving:

| Pattern Type | Example | Storage |
|-------------|---------|---------|
| Code Pattern | Consistent error handling approach | Memory file |
| Workflow Pattern | Effective debugging sequence | Memory file |
| Anti-Pattern | Common mistake to avoid | Memory file |
| Convention | Project-specific naming rule | CLAUDE.md |
| Decision | Architectural choice rationale | ADR |

### 3. Storage and Retrieval

Patterns stored in auto-memory directory:
```
~/.claude/projects/<project>/memory/
  MEMORY.md          # Index (loaded into system prompt)
  patterns.md        # Reusable patterns
  debugging.md       # Debugging insights
  conventions.md     # Project conventions
```

### 4. Application
At session start, consult memory files to:
- Apply previously successful patterns
- Avoid previously identified anti-patterns
- Follow established conventions
- Build on prior decisions

## Pattern Quality Criteria

Only persist patterns that are:
- **Confirmed**: Validated across 2+ interactions
- **Stable**: Not likely to change soon
- **Actionable**: Can be applied in future work
- **Non-obvious**: Not something Claude would do by default

## Memory Management Rules

- Keep MEMORY.md under 200 lines (system prompt inclusion)
- Use topic files for detailed notes
- Update or remove outdated patterns
- Organize semantically by topic, not chronologically
- Never store session-specific temporary state

## Hook Integration

### Stop Hook Pattern
```javascript
// At session end, evaluate patterns
{
  "event": "Stop",
  "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/hooks/evaluate-session.js"
}
```

### What the Hook Evaluates
- Files modified in session
- Tools used and their effectiveness
- Errors encountered and how they were resolved
- Patterns that could be generalized

## Anti-Patterns

- Do NOT store unverified assumptions
- Do NOT duplicate CLAUDE.md instructions
- Do NOT save session-specific context
- Do NOT store sensitive information (secrets, credentials)
- Do NOT let memory files grow unbounded
