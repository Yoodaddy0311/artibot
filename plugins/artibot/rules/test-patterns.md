---
paths:
  - "**/*.test.*"
  - "**/*.spec.*"
  - "**/tests/**"
  - "**/__tests__/**"
  - "**/test/**"
---

# Artibot Test Rules

## TDD Workflow (Mandatory)
1. Write test first (RED) — test should FAIL
2. Write minimal implementation (GREEN) — test should PASS
3. Refactor (IMPROVE) — clean up while tests stay green

## Coverage Targets
- Statements: >= 90%
- Branches: >= 85%
- Functions: >= 88%
- Lines: >= 90%

## Test Structure
- One `describe` per function/component
- Test names describe behavior: "should return error when input is empty"
- Arrange-Act-Assert pattern for each test
- No test interdependencies (each test runs independently)

## Mocking Rules
- Mock external APIs and databases, NOT internal logic
- Use dependency injection for testability
- Reset all mocks in `beforeEach` or `afterEach`
- Prefer spies over full mocks when possible

## Anti-Patterns (Avoid)
- Testing implementation details instead of behavior
- Snapshot tests for complex objects (fragile)
- `sleep()` or fixed timeouts (use `waitFor` or fake timers)
- Skipping tests without a tracked issue
