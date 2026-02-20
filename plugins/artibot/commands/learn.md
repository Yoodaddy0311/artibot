---
description: Extract and persist reusable patterns from the current codebase
argument-hint: '[topic] e.g. "에러 처리 패턴 학습"'
allowed-tools: [Read, Write, Edit, Glob, Grep, TodoWrite]
---

# /learn

Extract reusable patterns, conventions, and insights from the codebase or current session. Saves learned patterns to memory for future reference across sessions.

## Arguments

Parse $ARGUMENTS:
- `pattern-or-topic`: What to learn about or extract (e.g., "error handling pattern", "API conventions")
- `--from [source]`: Source to learn from - `file` (specific file) | `session` (current session) | `project` (whole project)
- `--save [location]`: Where to persist the learned pattern (default: auto memory)
- `--category [type]`: Pattern category - `convention` | `architecture` | `workflow` | `debugging` | `config`

## What Gets Learned

| Category | Examples |
|----------|----------|
| convention | Naming patterns, file organization, import styles, error handling approaches |
| architecture | Module structure, dependency patterns, data flow, API design |
| workflow | Build commands, test patterns, deployment steps, review process |
| debugging | Common error causes, fix patterns, troubleshooting sequences |
| config | Environment setup, tool configuration, framework settings |

## Execution Flow

1. **Parse**: Extract topic and source scope
2. **Discover**: Scan source for relevant patterns:
   - File-level: Read target file, extract conventions and patterns
   - Session-level: Review current session context for decisions and solutions
   - Project-level: Scan project structure, configs, and representative files
3. **Extract**: Identify concrete, reusable patterns:
   - Code patterns (function signatures, error handling, data structures)
   - Naming conventions (files, variables, functions, classes)
   - Architectural decisions (module boundaries, dependency direction)
   - Configuration patterns (env vars, build config, tool settings)
4. **Validate**: Verify patterns are consistent across multiple occurrences
   - Single occurrence = observation, not a pattern
   - 3+ occurrences = confirmed pattern worth persisting
5. **Persist**: Save to memory files:
   - Update MEMORY.md with concise summary and link
   - Create/update topic-specific file (e.g., `patterns.md`, `conventions.md`)
   - Use structured format for machine and human readability
6. **Report**: Output what was learned and where it was saved

## Pattern Format

Learned patterns are saved in this structure:
```
## [Pattern Name]
- **Context**: When this pattern applies
- **Pattern**: The concrete implementation approach
- **Example**: `file:line` reference in codebase
- **Rationale**: Why this pattern is used
```

## Output Format

```
PATTERNS LEARNED
================
Source:    [file|session|project]
Topic:    [description]
Patterns: [count extracted]

EXTRACTED
---------
1. [pattern name]
   Context: [when it applies]
   Confidence: [HIGH|MEDIUM] (based on occurrence count)
   Saved to: [memory file path]

2. [pattern name]
   ...

SAVED TO
--------
- [memory file path] ([created|updated])
```

## Rules

- Only persist patterns confirmed across 3+ occurrences (or explicitly requested by user)
- Do not duplicate patterns already in MEMORY.md or CLAUDE.md
- Update existing patterns if new evidence refines them
- Delete patterns proven wrong by new evidence
