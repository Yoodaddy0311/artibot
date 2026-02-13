# Coverage Requirements

## Minimum Thresholds

| Metric | Minimum | Target | Enforcement |
|--------|---------|--------|-------------|
| Line coverage | 80% | 90% | CI gate blocks merge |
| Branch coverage | 70% | 85% | CI warning at <75% |
| Function coverage | 80% | 90% | CI gate blocks merge |
| Critical path coverage | 100% | 100% | Manual review required |

## Coverage by Layer

### Unit Tests (>=80%)
- All pure functions and utilities
- Business logic and domain rules
- State management (reducers, stores)
- Input validation and schema logic
- Error handling paths

### Integration Tests (>=70%)
- API endpoint request/response cycles
- Database CRUD operations
- Authentication and authorization flows
- Third-party service interactions (mocked)
- Middleware chains

### E2E Tests (Critical Paths)
- User registration and login
- Core business workflow (happy path)
- Payment/checkout flows
- Data export/import operations
- Permission-based access scenarios

## Exclusions (Do NOT Count Against Coverage)
- Generated code (protobuf, GraphQL codegen)
- Type definitions (`.d.ts` files)
- Configuration files
- Migration scripts
- Test utilities and fixtures

## Coverage Decay Rules
- New code must meet or exceed current coverage
- Coverage drop >2% blocks PR merge
- Untested critical paths flagged as tech debt
- Monthly coverage trend review

## Test Quality Metrics (Beyond Coverage)
| Metric | Target | Indicator |
|--------|--------|-----------|
| Test/code ratio | 1:1 to 3:1 | Lines of test per lines of code |
| Assertion density | >=2 per test | Meaningful assertions per test case |
| Mutation score | >=70% | Tests catch injected mutations |
| Flaky test rate | <1% | Inconsistent test results |
