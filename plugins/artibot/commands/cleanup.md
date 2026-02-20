---
description: Project cleanup and technical debt reduction with systematic dead code elimination
argument-hint: '[target] e.g. "사용하지 않는 코드 정리"'
allowed-tools: [Read, Write, Edit, Glob, Grep, Bash, Task, TaskCreate]
---

# /cleanup

Systematic project cleanup targeting technical debt, dead code, unused imports, stale dependencies, and type inconsistencies. Uses refactorer persona for safe, incremental changes.

## Arguments

Parse $ARGUMENTS:
- `target`: File path, directory, or `@<path>` reference. Default: project root
- `--focus [area]`: `dead-code` | `imports` | `types` | `deps` | `all` (default: `all`)
- `--scope [level]`: `file` | `module` | `project`
- `--dry-run`: Report findings without making changes
- `--aggressive`: Include low-confidence dead code candidates
- `--delegate`: Enable sub-agent delegation for project-wide cleanup

## Focus Areas

| Focus | Detects | Action |
|-------|---------|--------|
| dead-code | Unreachable functions, unused exports, commented code | Remove safely |
| imports | Unused imports, duplicate imports, missing imports | Clean up |
| types | Any types, redundant type assertions, missing types | Fix |
| deps | Unused package.json deps, outdated versions | Remove/update |

## Execution Flow

1. **Parse**: Resolve target scope. Set focus areas
2. **Discovery**: Scan target for cleanup candidates:
   - Dead code: Find exports with zero import references across project
   - Imports: Identify unused and duplicate imports per file
   - Types: Find `any` usage and missing type annotations
   - Deps: Cross-reference package.json with actual import usage
3. **Classify**: Score each candidate by confidence and risk:
   - **HIGH confidence**: Zero references, clearly dead -> auto-remove
   - **MEDIUM confidence**: Low references, possibly dead -> flag for review
   - **LOW confidence**: Dynamic usage possible -> skip unless `--aggressive`
4. **Plan**: Generate ordered cleanup plan (remove deps before code that imports them)
5. **Execute** (unless `--dry-run`): Apply changes incrementally:
   - Remove dead code and unused imports
   - Fix type issues
   - Update package.json
6. **Verify**: Run lint, typecheck, and tests after each batch of changes
7. **Report**: Output cleanup summary with before/after metrics

## Output Format

```
CLEANUP REPORT
==============
Target:    [path]
Focus:     [areas]
Scope:     [file|module|project]

FINDINGS
--------
Dead code:     [n items] ([lines] lines removable)
Unused imports: [n items]
Type issues:    [n items]
Unused deps:    [n packages]

CHANGES APPLIED
---------------
- [file:line] Removed [description]
- [file:line] Fixed [description]

VERIFICATION
------------
Lint:      [PASS|FAIL]
TypeCheck: [PASS|FAIL]
Tests:     [PASS|FAIL]
Lines removed: [n]
```
