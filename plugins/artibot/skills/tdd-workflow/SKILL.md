---
context: forked
name: tdd-workflow
description: |
  Test-driven development workflow enforcing RED-GREEN-REFACTOR cycle.
  Auto-activates when: writing new features, fixing bugs, refactoring code with tests needed.
  Triggers: test, TDD, test-driven, coverage, unit test, RED GREEN REFACTOR, 테스트, TDD, 커버리지
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 2
triggers:
  - "test"
  - "TDD"
  - "test-driven"
  - "coverage"
  - "unit test"
  - "RED GREEN REFACTOR"
agents:
  - "tdd-guide"
  - "backend-developer"
tokens: "~3K"
category: "testing"
---
# TDD Workflow

## When This Skill Applies
- Implementing new features (tests first)
- Fixing bugs (reproduction test first)
- Refactoring code (ensure coverage before changing)
- Coverage analysis and improvement

## Core Guidance

**Cycle**: RED (failing test) -> GREEN (minimal code to pass) -> REFACTOR (improve while green) -> repeat

**Coverage Requirements**:
| Type | Minimum | Focus |
|------|---------|-------|
| Unit | 80% | Functions, pure logic, utilities |
| Integration | 70% | API endpoints, database ops |
| E2E | Critical paths | User workflows, conversions |

**For New Features**:
1. Write interface/type definition
2. Write failing test for first behavior
3. Implement minimum code to pass
4. Write next failing test, implement, repeat
5. Refactor once all behaviors pass
6. Verify >= 80% coverage

**For Bug Fixes**:
1. Write failing test that reproduces the bug
2. Verify it fails for the right reason
3. Fix with minimum change
4. Verify test passes, no regressions

**Test Quality Rules**:
- Test behavior, not implementation
- Single clear assertion focus per test
- Tests independent, runnable in any order
- Mocks minimal, at system boundaries only

**Anti-Patterns**: Tests after code, testing implementation details, production data in fixtures, over-mocking, skipping edge cases, `.skip` instead of fixing

## Workflow Checklist

Copy this checklist and track progress:

```
Progress:
- [ ] Step 1: Write interface/type definition for the behavior
- [ ] Step 2: Write failing test (RED) — confirm it fails for the right reason
- [ ] Step 3: Implement minimum code to pass (GREEN)
- [ ] Step 4: Run test suite — confirm green, no regressions
- [ ] Step 5: Refactor while keeping tests green (REFACTOR)
- [ ] Step 6: Verify coverage >= 80% unit, >= 70% integration
- [ ] Step 7: Commit with descriptive test-first evidence
```

## Human Checkpoints

| After Step | Checkpoint | Type | Options |
|-----------|-----------|------|---------|
| Step 1 | Interface/type design review | Approval | Approve design / Revise contract |
| Step 2 | Failing test captures correct behavior? | Go-No-Go | Proceed / Rewrite test |
| Step 5 | Refactored code quality acceptable? | Approval | Ship / Further refactor |
| Step 6 | Coverage gaps in critical paths? | Selection | Add tests / Accept gaps / Defer |

## Freedom Levels

| Step | Freedom | Guidance |
|------|:-------:|----------|
| Interface/type definition | HIGH | Design decisions, multiple valid shapes |
| Write failing test | MEDIUM | Behavior focus required, but assertion style flexible |
| Implement to pass | LOW | Minimum code only, no extras |
| Run tests | LOW | Must pass, no skipping |
| Refactor | HIGH | Creative improvement while green |
| Verify coverage | LOW | Thresholds are non-negotiable |
| Commit | MEDIUM | Message style follows convention, scope flexible |

## Quick Reference
- Always RED before GREEN
- Every bug fix gets a regression test
- Test names describe expected behavior
- 80%+ unit, 70%+ integration coverage
