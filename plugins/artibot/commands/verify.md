---
description: Sequential verification pipeline - lint, typecheck, test, build
argument-hint: '[target] e.g. "린트+타입+테스트 전체 검증"'
allowed-tools: [Read, Bash, Glob, Grep, TodoWrite]
---

# /verify

Run the full verification pipeline sequentially: lint -> typecheck -> test -> build. Stops on first failure unless `--continue` is set.

## Arguments

Parse $ARGUMENTS:
- `target`: Project directory or specific file/module. Default: project root
- `--quick`: Skip build step, run only lint + typecheck + unit tests
- `--fix`: Auto-fix lint and format issues
- `--continue`: Continue pipeline on failure (report all issues)
- `--step [name]`: Run only specific step: `lint` | `typecheck` | `test` | `build`

## Execution Flow

1. **Parse**: Resolve target, detect project type and available tools
2. **Detect Tools**: Identify available verification tools:
   - Lint: ESLint, Biome, Ruff, Pylint
   - Types: TypeScript (`tsc --noEmit`), mypy, Pyright
   - Test: Jest, Vitest, pytest (unit tests only for speed)
   - Build: Framework-specific build command
3. **Execute Pipeline** (sequential, order matters):

   **Step 1 - Lint**:
   - Run linter on target files
   - If `--fix`: auto-fix and re-run to confirm clean
   - Gate: Zero errors (warnings allowed)

   **Step 2 - Typecheck**:
   - Run type checker on target
   - Gate: Zero type errors

   **Step 3 - Test**:
   - Run unit tests (integration if `--quick` not set)
   - Gate: All tests pass, coverage >= 80%

   **Step 4 - Build** (skip if `--quick`):
   - Run production build
   - Gate: Build succeeds with zero errors

4. **Report**: Output pipeline results with pass/fail per step

## Pipeline Behavior

- Default: Stop on first failure, report which step failed
- `--continue`: Run all steps, aggregate all failures
- `--fix`: Attempt auto-fix for lint/format issues only

## Output Format

```
VERIFICATION PIPELINE
=====================
Target:  [path]
Mode:    [full|quick]

RESULTS
-------
Lint .............. [PASS|FAIL] ([n] errors, [n] warnings)
Typecheck ......... [PASS|FAIL] ([n] errors)
Test .............. [PASS|FAIL] ([passed/total], coverage: [n]%)
Build ............. [PASS|FAIL|SKIPPED]

VERDICT: [ALL PASS|BLOCKED]

FAILURES (if any)
-----------------
[step] [file:line] [error description]
```
