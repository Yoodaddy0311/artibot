---
name: testing-standards
description: |
  Testing standards and test-driven development practices.
  Coverage requirements, test pyramid, TDD workflow,
  and testing patterns for unit, integration, and E2E tests.

  Use proactively when writing tests, implementing features
  with TDD, or evaluating test coverage.

  Triggers: test, testing, coverage, TDD, unit test, integration test,
  e2e, end-to-end, assertion, mock, fixture, spec,
  테스트, 커버리지, 단위테스트, 통합테스트,
  テスト, カバレッジ, 単体テスト

  Do NOT use for: documentation, design discussions without
  implementation, or infrastructure configuration.
---

# Testing Standards

> Prevention over detection. Tests are executable documentation.

## When This Skill Applies

- Implementing new features (TDD workflow)
- Fixing bugs (write regression test first)
- Evaluating test coverage gaps
- Reviewing test quality
- Setting up test infrastructure

## Coverage Requirements

**Minimum: 80% coverage across all test types**

| Test Type | Coverage Target | Focus |
|-----------|----------------|-------|
| Unit | >=80% | Individual functions, utilities, components |
| Integration | >=70% | API endpoints, database operations, service interactions |
| E2E | Critical paths | Core user journeys (login, main workflows) |

## TDD Workflow (MANDATORY for new features)

```
1. RED    - Write test first. Run it. It MUST fail.
2. GREEN  - Write minimal code to pass the test.
3. REFACTOR - Improve code while keeping tests green.
4. VERIFY - Check coverage meets 80%+ threshold.
```

**Key rules**:
- Never write implementation before the test
- Each test should test one behavior
- Fix implementation, not tests (unless test is wrong)
- Keep tests isolated and independent

## Test Structure (AAA Pattern)

```typescript
test('returns empty array when no markets match query', () => {
  // Arrange - set up test data
  const markets: Market[] = []
  const query = 'nonexistent'

  // Act - execute the function under test
  const result = searchMarkets(markets, query)

  // Assert - verify the outcome
  expect(result).toEqual([])
})
```

## Test Naming

```typescript
// GOOD: Descriptive, behavior-focused names
test('returns 401 when authentication token is missing', () => {})
test('retries failed request up to 3 times with exponential backoff', () => {})
test('filters inactive users from search results', () => {})

// BAD: Vague or implementation-focused
test('works', () => {})
test('test search', () => {})
test('calls fetchUsers', () => {})
```

## Testing Pyramid

```
    /  E2E  \        Few, slow, high-confidence
   /  Integ  \       Moderate count, API/DB boundaries
  /   Unit    \      Many, fast, isolated
```

- **Unit tests**: Fast, isolated, mock external dependencies
- **Integration tests**: Real DB/API, test boundaries
- **E2E tests**: Browser-based, critical user flows only

## Mocking Guidelines

```typescript
// GOOD: Mock external dependencies, not internal logic
const mockFetch = vi.fn().mockResolvedValue({
  ok: true,
  json: () => Promise.resolve({ data: mockData })
})

// BAD: Mocking everything including the thing you're testing
vi.mock('./utils')  // Don't mock the module under test
```

**When to mock**:
- External APIs and services
- Database calls in unit tests
- Time-dependent operations
- Third-party libraries

**When NOT to mock**:
- Pure functions
- The module under test
- Simple data transformations

## Test Troubleshooting

When tests fail:
1. Check test isolation (no shared state)
2. Verify mocks match real behavior
3. Check for race conditions in async tests
4. Fix the implementation, not the test

## References

- `references/coverage-requirements.md` - Detailed coverage matrix and exemptions
