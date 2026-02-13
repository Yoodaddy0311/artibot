---
description: Code review with severity classification using code-reviewer agent
argument-hint: [target] [--focus security|quality|performance]
allowed-tools: [Read, Glob, Grep, Bash, Task, TodoWrite]
---

# /code-review

Structured code review using the code-reviewer agent. Classifies findings by severity and provides actionable fix recommendations.

## Arguments

Parse $ARGUMENTS:
- `target`: File path, directory, or git diff range (e.g., `HEAD~3..HEAD`)
- `--focus [domain]`: Narrow review focus - `security` | `quality` | `performance` | `all` (default: `all`)
- `--strict`: Treat MEDIUM issues as blocking
- `--diff-only`: Review only changed lines (git diff context)

## Execution Flow

1. **Parse**: Resolve target. If git range provided, extract changed files via `git diff`
2. **Context**: Read target files. Identify language, framework, existing patterns
3. **Delegate**: Route to Task(code-reviewer) with file content and focus area
4. **Classify**: Categorize each finding by severity:
   - **CRITICAL**: Security vulnerabilities, data loss risks, crash-causing bugs
   - **HIGH**: Logic errors, missing error handling, race conditions, type unsafety
   - **MEDIUM**: Code smells, duplication, poor naming, missing tests
   - **LOW**: Style inconsistencies, minor optimization opportunities, documentation gaps
5. **Prioritize**: Order findings by severity, then by file location
6. **Report**: Output review with fix recommendations per finding

## Review Checklist

| Category | Checks |
|----------|--------|
| Security | Injection, secrets, auth, input validation, XSS, CSRF |
| Correctness | Logic errors, edge cases, null checks, error handling |
| Quality | Complexity, duplication, naming, file size (<800 lines) |
| Performance | O(n^2+) algorithms, memory leaks, unnecessary re-renders |
| Patterns | Immutability, SOLID violations, framework conventions |
| Tests | Coverage gaps, missing edge case tests, test isolation |

## Output Format

```
CODE REVIEW
===========
Target:    [path or diff range]
Files:     [count reviewed]
Focus:     [domain]

FINDINGS
--------
CRITICAL [count]
  [file:line] [description]
    Fix: [recommendation]

HIGH [count]
  [file:line] [description]
    Fix: [recommendation]

MEDIUM [count]
  [file:line] [description]

LOW [count]
  [file:line] [description]

VERDICT: [APPROVE|REQUEST_CHANGES|BLOCK]
Blocking Issues: [count]
```
