---
description: Refactoring and dead code cleanup using refactor-cleaner agent
argument-hint: '[target] e.g. "중복 코드 제거 및 정리"'
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, Task, TodoWrite]
---

# /refactor-clean

Systematic refactoring and dead code removal. Delegates to refactor-cleaner agent for safe, test-preserving code improvements.

## Arguments

Parse $ARGUMENTS:
- `target`: File path, directory, or module to refactor
- `--type [kind]`: Refactoring focus:
  - `dead-code`: Remove unused exports, functions, variables, imports
  - `duplication`: Extract shared logic, DRY violations
  - `complexity`: Reduce cyclomatic complexity, flatten nesting
  - `all`: Apply all refactoring types (default)
- `--dry-run`: Show proposed changes without applying
- `--safe`: Only apply changes with zero test impact

## Execution Flow

1. **Parse**: Resolve target, determine refactoring scope
2. **Baseline**: Run existing tests to establish green state. Abort if tests fail
3. **Analyze**: Delegate to Task(refactor-cleaner) for:
   - Dead code detection (unused exports, unreachable branches, orphan files)
   - Duplication analysis (copy-paste detection, extractable patterns)
   - Complexity measurement (functions >20 cyclomatic, nesting >4 levels)
4. **Plan**: Generate ordered refactoring steps (safest first):
   - Remove dead imports and variables
   - Extract duplicated logic into shared utilities
   - Simplify complex conditionals and flatten nesting
   - Rename for clarity where appropriate
5. **Execute** (unless `--dry-run`): Apply changes incrementally
6. **Verify**: Re-run tests after each change group. Rollback if any test breaks
7. **Report**: Output refactoring summary with before/after metrics

## Safety Rules

- ALWAYS run tests before starting (establish green baseline)
- NEVER remove code that is referenced by tests
- Apply ONE refactoring type at a time, verify tests between each
- Preserve all public API contracts
- Use immutable patterns in refactored code

## Output Format

```
REFACTORING REPORT
==================
Target:     [path]
Type:       [dead-code|duplication|complexity|all]
Mode:       [applied|dry-run]

CHANGES
-------
Removed:    [n] dead code items ([lines] lines saved)
Extracted:  [n] shared utilities
Simplified: [n] complex functions

DETAILS
-------
[action] [file:line] [description]

METRICS
-------
             Before    After    Delta
Complexity:  [n]       [n]      [-n]
Duplication: [n]%      [n]%     [-n]%
Dead Code:   [n]       [n]      [-n]
Test Status: [PASS]    [PASS]
```
