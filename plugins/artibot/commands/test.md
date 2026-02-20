---
description: Test execution, analysis, and coverage reporting
argument-hint: '[type] e.g. "단위 테스트 실행"'
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, Task, TaskCreate]
---

# /test

Run tests, analyze results, and report coverage. Supports all test types and delegates E2E testing to the e2e-runner agent.

## Arguments

Parse $ARGUMENTS:
- `target`: File, directory, or test pattern to run. Default: all tests
- `--type [kind]`: `unit` | `integration` | `e2e` | `all` (default: `all`)
- `--coverage`: Generate coverage report with threshold check (>=80%)
- `--watch`: Run in watch mode
- `--update-snapshots`: Update snapshot tests
- `--bail`: Stop on first failure

## Execution Flow

1. **Parse**: Resolve target, detect test runner from project config
2. **Detect Runner**: Identify test framework:
   - `jest.config.*` or `package.json[jest]` -> Jest
   - `vitest.config.*` -> Vitest
   - `playwright.config.*` -> Playwright
   - `pytest.ini` or `pyproject.toml[tool.pytest]` -> pytest
   - `*.test.ts` / `*.spec.ts` patterns -> framework from config
3. **Execute**: Run tests with appropriate command:
   - Unit/Integration: Run via detected framework
   - E2E: Delegate to Task(e2e-runner) for Playwright-based testing
4. **Analyze Results**: Parse test output for:
   - Pass/fail counts and failure details
   - Slow tests (>1s unit, >5s integration)
   - Flaky test detection (if re-run data available)
5. **Coverage** (if `--coverage`): Generate and validate:
   - Line coverage >= 80%
   - Branch coverage >= 70%
   - Identify uncovered critical paths
6. **Report**: Output structured test results

## Output Format

```
TEST RESULTS
============
Runner:     [jest|vitest|playwright|pytest]
Type:       [unit|integration|e2e]
Status:     [PASS|FAIL]

SUMMARY
-------
Total:    [n]
Passed:   [n]
Failed:   [n]
Skipped:  [n]
Duration: [time]

FAILURES (if any)
-----------------
[test name] ([file:line])
  Expected: [value]
  Received: [value]

COVERAGE (if --coverage)
------------------------
Lines:    [n]% (threshold: 80%)  [PASS|FAIL]
Branches: [n]% (threshold: 70%)  [PASS|FAIL]
Uncovered: [file:lines], ...
```
