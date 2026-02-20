---
description: Test-driven development workflow (RED -> GREEN -> REFACTOR)
argument-hint: '[feature] e.g. "TDD로 유틸 함수 개발"'
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, Task, TodoWrite]
---

# /tdd

Guided TDD workflow following RED -> GREEN -> REFACTOR cycle. Delegates to tdd-guide agent for test-first development.

## Arguments

Parse $ARGUMENTS:
- `feature-or-function`: What to implement using TDD
- `--framework [name]`: Test framework override (jest, vitest, pytest, playwright)
- `--coverage [n]`: Target coverage percentage (default: 80%)
- `--strict`: Enforce that tests are written before any implementation code

## Execution Flow

1. **Parse**: Extract feature requirements, detect test framework from project config
2. **Plan**: Delegate to Task(tdd-guide) to decompose feature into testable units:
   - List test cases (happy path, edge cases, error cases)
   - Order by dependency (foundational tests first)
   - Identify mocks/fixtures needed
3. **RED Phase**: Write failing tests:
   - Create test file(s) following project naming convention (`*.test.ts`, `*.spec.ts`)
   - Write test cases with clear assertions
   - Run tests - confirm all FAIL (this is expected)
4. **GREEN Phase**: Write minimal implementation:
   - Implement just enough code to pass each test
   - No optimization, no abstraction - minimal passing code
   - Run tests after each implementation - confirm PASS
5. **REFACTOR Phase**: Improve implementation:
   - Apply DRY, extract functions, improve naming
   - Ensure immutability patterns
   - Run tests after each refactor - confirm still PASS
6. **Verify**: Check coverage meets target threshold
7. **Report**: Output TDD cycle summary

## TDD Rules

- NEVER write implementation before tests
- Each test should test ONE behavior
- Tests must be independent and isolated
- Use descriptive test names: `should [behavior] when [condition]`
- Mock external dependencies, test internal logic

## Output Format

```
TDD CYCLE SUMMARY
==================
Feature:    [description]
Framework:  [detected]
Cycles:     [completed]

RED PHASE
---------
Tests Written: [n]
All Failing:   [YES|NO - fix if NO]

GREEN PHASE
-----------
Tests Passing: [n/total]
Implementation Files: [list]

REFACTOR PHASE
--------------
Improvements: [list of refactorings applied]
Tests Still Passing: [YES|NO]

COVERAGE
--------
Target:  [n]%
Actual:  [n]%
Status:  [PASS|FAIL]
```
