# Coverage Requirements

> Detailed test coverage matrix, exemptions, and measurement guidelines.

## Coverage Targets

| Test Type | Target | Minimum | Measurement Tool |
|-----------|--------|---------|-----------------|
| Unit tests | 85% | 80% | Vitest/Jest coverage |
| Integration tests | 75% | 70% | Vitest/Jest coverage |
| E2E tests | Critical paths | All core journeys | Playwright |
| Combined | 85% | 80% | Aggregate report |

## Coverage by Code Category

| Category | Required Coverage | Priority | Notes |
|----------|------------------|----------|-------|
| Business logic | 90%+ | Critical | Core value, highest risk |
| API routes/handlers | 85%+ | High | Input validation, error paths |
| Data access layer | 80%+ | High | CRUD operations, queries |
| Utility functions | 90%+ | High | Pure functions, easy to test |
| React components | 75%+ | Medium | Render, interaction, props |
| Custom hooks | 85%+ | High | State management logic |
| Configuration | 50%+ | Low | Mostly declarative |
| Type definitions | N/A | N/A | Types are self-documenting |

## What Must Be Tested

### Critical Paths (100% coverage required)
- Authentication flow (login, logout, session)
- Authorization checks (access control)
- Payment/financial transactions
- Data creation and deletion
- User input processing

### Happy Paths (90%+ coverage)
- Standard CRUD operations
- Normal user workflows
- API endpoint responses
- Component rendering with valid props

### Error Paths (80%+ coverage)
- Invalid input handling
- Network failure scenarios
- Timeout behaviors
- Empty/null state handling
- Permission denied scenarios

### Edge Cases (70%+ coverage)
- Boundary values (0, max, empty)
- Concurrent operations
- Unicode/special characters
- Large data sets
- Pagination boundaries

## Coverage Exemptions

The following may be excluded from coverage targets with documented justification:

| Exemption | Reason | Alternative Validation |
|-----------|--------|----------------------|
| Generated code | Auto-generated, not hand-written | Generator tests |
| Type definitions | No runtime behavior | TypeScript compiler |
| Configuration files | Declarative, no logic | Schema validation |
| Third-party wrappers | Thin wrappers around tested libs | Integration tests |
| Development-only code | Debug utilities, dev tools | Manual verification |

## Measurement Commands

```bash
# Run tests with coverage
npx vitest run --coverage

# Generate HTML report
npx vitest run --coverage --reporter=html

# Check against thresholds
npx vitest run --coverage --coverage.thresholds.lines=80 --coverage.thresholds.functions=80 --coverage.thresholds.branches=80
```

## Coverage Configuration (vitest.config.ts)

```typescript
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      exclude: [
        'node_modules/',
        'dist/',
        '**/*.d.ts',
        '**/*.config.*',
        '**/types/**',
        '**/__mocks__/**'
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80
      }
    }
  }
})
```

## Test Quality Metrics (Beyond Coverage)

| Metric | Target | Measurement |
|--------|--------|-------------|
| Test execution time | <30s unit, <5min integration | CI pipeline timing |
| Flaky test rate | 0% | Track re-runs in CI |
| Test-to-code ratio | 1:1 to 2:1 | Line count comparison |
| Assertion density | >=1 per test | Linting rule |
| Mock complexity | <5 mocks per test | Code review |

## When Coverage Drops

If coverage falls below targets:

1. **Block PR** until coverage is restored
2. **Identify gaps** using coverage report
3. **Prioritize** by risk: critical paths first
4. **Write missing tests** before new features
5. **Track trend** to prevent gradual degradation
