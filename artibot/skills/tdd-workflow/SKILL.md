---
name: tdd-workflow
description: |
  Test-Driven Development workflow. Red-Green-Refactor cycle
  with coverage requirements and test-first methodology.

  Use proactively when implementing new features, fixing bugs,
  or when test coverage is required before code changes.

  Triggers: TDD, test first, test driven, red green refactor,
  write test, coverage, test before code,
  TDD, 테스트주도, 테스트먼저, 레드그린,
  TDD, テスト駆動, テストファースト

  Do NOT use for: prototype/spike code, configuration changes,
  or documentation-only tasks.
---

# TDD Workflow

> Write the test. Watch it fail. Make it pass. Clean it up.

## When This Skill Applies

- New feature implementation
- Bug fix (reproduce bug as test first)
- Refactoring with safety net
- Adding coverage to untested code
- Any code change where correctness matters

## The Cycle

```
  ┌─────────────┐
  │   1. RED     │  Write a failing test
  │  (test fails)│
  └──────┬──────┘
         │
  ┌──────▼──────┐
  │  2. GREEN   │  Write minimal code to pass
  │ (test passes)│
  └──────┬──────┘
         │
  ┌──────▼──────┐
  │ 3. REFACTOR │  Improve code, keep tests passing
  │  (clean up) │
  └──────┬──────┘
         │
         └──────── Repeat
```

## Step-by-Step

### 1. RED: Write the Test First
```typescript
// Write what the code SHOULD do
it('should calculate total with tax', () => {
  const result = calculateTotal(100, 0.1)
  expect(result).toBe(110)
})
```
- Run the test - it MUST fail
- If it passes, the test is not testing new behavior

### 2. GREEN: Minimal Implementation
```typescript
// Write the SIMPLEST code that passes
function calculateTotal(amount: number, taxRate: number): number {
  return amount + (amount * taxRate)
}
```
- Only enough code to pass the test
- Do NOT add extra logic or edge cases yet
- Run the test - it MUST pass

### 3. REFACTOR: Clean Up
- Remove duplication
- Improve naming
- Extract helpers if needed
- Run tests after each change - they MUST still pass

## Coverage Targets

| Test Type | Target | Priority |
|-----------|--------|----------|
| Unit | >= 80% | Functions, utilities, business logic |
| Integration | >= 70% | API endpoints, DB operations |
| E2E | Critical paths | Auth flows, core user journeys |

## Bug Fix TDD

1. Write a test that reproduces the bug
2. Run test - it MUST fail (confirms the bug)
3. Fix the bug
4. Run test - it MUST pass (confirms the fix)
5. Verify no other tests broke

## Test Quality Rules

- Test behavior, not implementation
- One assertion per concept (multiple assertions OK if same concept)
- Tests must be independent (no shared mutable state)
- Tests must be deterministic (same result every run)
- Test names describe the expected behavior

## Anti-Patterns

- Do NOT write implementation before tests
- Do NOT write tests that always pass
- Do NOT test private methods directly
- Do NOT create elaborate test fixtures (keep simple)
- Do NOT skip the refactor step
