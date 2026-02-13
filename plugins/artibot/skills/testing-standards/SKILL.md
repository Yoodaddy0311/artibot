---
name: testing-standards
description: |
  Testing standards enforcing 80% coverage, Testing Pyramid, and TDD workflow.
  Auto-activates when: writing tests, implementing features, fixing bugs, refactoring code.
  Triggers: test, coverage, TDD, unit test, integration, e2e, jest, vitest, playwright
---

# Testing Standards

## When This Skill Applies
- Writing new features (TDD: tests first)
- Fixing bugs (reproduce with test, then fix)
- Refactoring existing code (safety net tests)
- Reviewing test quality and coverage
- Setting up test infrastructure

## Core Guidance

### Coverage Requirements
- **Minimum**: 80% overall coverage
- **Unit tests**: >=80% line coverage
- **Integration tests**: >=70% critical path coverage
- **E2E tests**: All critical user journeys

### Testing Pyramid
```
        /  E2E  \        <- Few, slow, expensive
       / Integr. \       <- Some, moderate cost
      /   Unit    \      <- Many, fast, cheap
```

### TDD Workflow (Mandatory)
1. **RED**: Write a failing test that defines expected behavior
2. **RUN**: Execute test -- it MUST fail
3. **GREEN**: Write minimal code to make the test pass
4. **RUN**: Execute test -- it MUST pass
5. **REFACTOR**: Clean up code while keeping tests green
6. **VERIFY**: Check coverage meets 80% threshold

### Test Quality Rules
- Tests must be independent and isolated
- No shared mutable state between tests
- Mock external dependencies, not internal logic
- Test behavior, not implementation details
- Each test has one clear assertion focus
- Descriptive test names: `should [action] when [condition]`

### Troubleshooting Test Failures
1. Check test isolation (shared state?)
2. Verify mocks match actual interfaces
3. Fix implementation, not tests (unless tests are wrong)
4. Use `--persona-qa` for complex test debugging

See `references/coverage-requirements.md` for detailed metrics.

## Quick Reference

| Test Type | Count | Speed | Scope | Coverage Target |
|-----------|-------|-------|-------|-----------------|
| Unit | Many | <10ms | Function/class | >=80% |
| Integration | Some | <1s | Module/API | >=70% |
| E2E | Few | <30s | User journey | Critical paths |
