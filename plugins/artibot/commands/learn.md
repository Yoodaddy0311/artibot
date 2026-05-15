---
description: (Artibot) Extract and persist reusable patterns from the current codebase
argument-hint: '[topic] e.g. "에러 처리 패턴 학습"'
allowed-tools: [Read, Write, Edit, Glob, Grep, TaskCreate]
toolset: analysis
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
5. **Diff Preview**: For every pattern that would touch an existing memory file, render the proposed change before writing:
   - File path + `Why:` one-liner (which criterion / signal triggered the change)
   - Use a ```diff fenced block — `-` for removed lines, `+` for added
   - Group diffs by file. No `Write`/`Edit` calls in this step.
   - Prompt: *"Apply the N diffs above? (yes / no / select N1,N2,...)"*
6. **Persist**: Only after user approval (`yes` or explicit `select`):
   - Update MEMORY.md with concise summary and link
   - Create/update topic-specific file (e.g., `patterns.md`, `conventions.md`)
   - Use structured format for machine and human readability
   - On `no` (or missing input) → skip all writes and record the count
7. **Report**: Output what was learned and where it was saved
   - Skipped (not approved): N — these patterns are surfaced again next time

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
APPROVED:  [n]
SKIPPED:   [n]

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

## Next Steps

작업 완료 후 추천 후속 액션:

| # | 액션 | 커맨드 | 설명 |
|---|------|--------|------|
| 1 | 학습 저장 | `/checkpoint` | 학습 패턴 체크포인트 저장 |
| 2 | 패턴 적용 | `/improve` | 학습된 패턴 코드에 적용 |
| 3 | 패턴 분석 | `/analyze` | 추출된 패턴 품질 분석 |
