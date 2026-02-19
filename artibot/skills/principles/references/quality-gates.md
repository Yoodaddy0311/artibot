# Quality Gates

> 8-step validation cycle for every deliverable.

## Validation Cycle

Every code change passes through these gates before completion:

### Gate 1: Syntax Check
- **Tool**: Language parser, IDE diagnostics
- **Pass criteria**: Zero syntax errors
- **Action on fail**: Fix immediately, cannot proceed

### Gate 2: Type Safety
- **Tool**: TypeScript compiler (`tsc --noEmit`)
- **Pass criteria**: Zero type errors
- **Action on fail**: Fix type issues, add missing types
- **Note**: `any` type is a type error in strict mode

### Gate 3: Lint Rules
- **Tool**: ESLint, Biome, project linter
- **Pass criteria**: Zero errors (warnings acceptable with justification)
- **Action on fail**: Fix lint violations, document intentional exceptions

### Gate 4: Security Scan
- **Tool**: Security review, dependency audit
- **Pass criteria**: Zero Critical/High vulnerabilities
- **Checks**:
  - No hardcoded secrets
  - Input validation at boundaries
  - SQL injection prevention
  - XSS prevention
  - CSRF protection

### Gate 5: Test Execution
- **Tool**: Test runner (Vitest, Jest, Playwright)
- **Pass criteria**: All tests pass, coverage >= 80%
- **Checks**:
  - Unit tests: >= 80% coverage
  - Integration tests: >= 70% coverage
  - E2E tests: Critical paths covered
  - No flaky tests

### Gate 6: Performance Check
- **Tool**: Profiling, benchmarks, Lighthouse
- **Pass criteria**: No regression from baseline
- **Checks**:
  - API response time < 200ms
  - Page load < 3s on 3G
  - Bundle size within budget
  - No memory leaks introduced

### Gate 7: Documentation
- **Tool**: Manual review
- **Pass criteria**: Changed behavior is documented
- **Checks**:
  - Public API changes documented
  - Breaking changes noted
  - README updated if needed
  - Inline comments for non-obvious logic

### Gate 8: Integration Verification
- **Tool**: E2E tests, manual verification
- **Pass criteria**: Feature works end-to-end
- **Checks**:
  - Feature works in target environment
  - No regressions in related features
  - Data flows correctly across boundaries
  - Error paths handled gracefully

## Gate Application by Task Type

| Task Type | Required Gates | Optional Gates |
|-----------|---------------|----------------|
| Bug fix | 1, 2, 3, 4, 5 | 6, 7, 8 |
| New feature | All 8 | - |
| Refactoring | 1, 2, 3, 5, 6 | 4, 7, 8 |
| Performance fix | 1, 2, 3, 5, 6 | 4, 7, 8 |
| Security fix | 1, 2, 3, 4, 5 | 6, 7, 8 |
| Documentation | 7 | - |
| Configuration | 1, 3, 8 | 4, 5 |

## Completion Criteria

A task is complete when:
- All required gates pass
- Evidence is collected (test results, metrics)
- Changes are reviewable (clear diff, commit message)
- No Critical or High issues remain open
