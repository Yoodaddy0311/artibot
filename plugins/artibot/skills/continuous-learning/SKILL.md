---
name: continuous-learning
description: |
  Pattern extraction and knowledge persistence across sessions using auto memory.
  Auto-activates when: recurring patterns detected, debugging insights gained, user preferences confirmed.
  Triggers: remember, pattern, learned, save, memory, always do, never do, across sessions
---
# Continuous Learning

## When This Skill Applies
- Recurring patterns confirmed across 2+ interactions
- Debugging insights worth preserving for future sessions
- User explicitly requests remembering preferences or conventions
- Architectural decisions that should persist across sessions

## Core Guidance

**What to Save**:
- Stable patterns and conventions confirmed across interactions
- Key architectural decisions and important file paths
- User preferences for workflow, tools, communication style
- Solutions to recurring problems and debugging insights

**What NOT to Save**:
- Session-specific context (current task, temporary state)
- Incomplete or unverified information
- Anything duplicating existing CLAUDE.md instructions
- Speculative conclusions from reading a single file

**Memory Structure**:
```
~/.claude/projects/{project-hash}/memory/
  MEMORY.md          # Always loaded, keep <200 lines
  patterns.md        # Confirmed patterns
  debugging.md       # Debugging insights
  decisions.md       # Architectural decisions
```

**Persistence Rules**:
1. Verify before saving: confirm pattern across 2+ interactions
2. Keep concise: MEMORY.md under 200 lines (loaded every session)
3. Organize semantically: topic files for detailed notes
4. Remove outdated: delete patterns no longer valid
5. Link from MEMORY.md: reference topic files, don't duplicate

**Anti-Patterns**: Saving session-specific state, speculative single-observation conclusions, duplicating CLAUDE.md content

## Quick Reference
- Confirm pattern 2+ times before saving
- MEMORY.md < 200 lines (always loaded)
- Organize: MEMORY.md links to topic files
- Prune regularly: remove outdated patterns
