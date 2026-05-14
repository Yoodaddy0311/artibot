---
context: fork
user-invocable: false
name: testing-standards
description: |
  Testing standards enforcing 80% coverage, Testing Pyramid, and TDD workflow.
  Auto-activates when: writing tests, implementing features, fixing bugs, refactoring code.
  Triggers: test, coverage, TDD, unit test, integration, e2e, jest, vitest, playwright
lang: [en]
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 3
progressive_disclosure:
  enabled: true
  level1_tokens: 100
  level2_tokens: 4000
triggers:
  - "testing"
  - "test coverage"
  - "unit test"
  - "integration test"
  - "E2E"
  - "test quality"
allowed-tools: [Read, Grep, Glob]
agents:
  - "tdd-guide"
  - "backend-developer"
tokens: "~3K"
category: "testing"
source_hash: d81fba95
whenNotToUse: "Do not apply the 80% unit coverage threshold to infrastructure glue code (Docker entrypoints, CI YAML, config loaders with no logic). Do not require E2E tests for backend-only APIs with no user-facing journey — integration tests suffice there."
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

See `${CLAUDE_SKILL_DIR}/references/coverage-requirements.md` for detailed metrics.

## Workflow Checklist

Copy this checklist and track progress:

```
Progress:
- [ ] Step 1: RED — Write a failing test defining expected behavior
- [ ] Step 2: RUN — Execute test, confirm it fails correctly
- [ ] Step 3: GREEN — Write minimal code to make the test pass
- [ ] Step 4: RUN — Execute test, confirm it passes
- [ ] Step 5: REFACTOR — Clean up code while tests remain green
- [ ] Step 6: VERIFY — Check coverage meets 80% threshold
- [ ] Step 7: Review test quality (isolation, naming, single assertion)
```

## Human Checkpoints

### Checkpoint 1: 테스트 행동 검증 (After Step 1)
**Context**: TDD의 RED 단계에서 테스트를 작성한 직후입니다. 이 시점에 테스트가 잘못된 행동을 정의하면 이후 모든 구현이 잘못된 방향으로 진행됩니다.
**Ask**: "작성한 테스트가 **올바른 행동을 정의하고 있나요**? 구현 전에 테스트 내용을 검토해 주세요."
**Options**:
1. Proceed — 테스트가 기대 동작을 정확히 정의함, 구현 단계로 진행
2. Rewrite test — 테스트가 잘못된 행동을 정의하거나 범위가 맞지 않음
**Default**: 1 (명확한 요구사항이 있는 경우 테스트가 올바를 가능성이 높음)
**Skippable**: No — 잘못된 테스트로 시작하면 GREEN 단계에서 잘못된 코드가 작성됨
**Freedom**: MEDIUM

### Checkpoint 2: 리팩토링 결과 승인 (After Step 5)
**Context**: REFACTOR 단계 완료 후, 모든 테스트가 여전히 통과하는 상태에서 코드 품질 개선 결과를 확인하는 시점입니다.
**Ask**: "리팩토링된 코드가 **수용 가능한 수준인가요**? 품질과 가독성을 검토해 주세요."
**Options**:
1. Approve — 리팩토링 결과가 충분히 개선되어 커버리지 검증으로 진행
2. More refactoring needed — 추가 리팩토링이 필요한 부분이 있음
**Default**: 1 (테스트가 통과하고 코드가 개선되었다면 일반적으로 수용 가능)
**Skippable**: No — 품질 검토 없이 완료 처리하면 기술 부채가 누적됨
**Freedom**: HIGH

### Checkpoint 3: 커버리지 미달 시 추가 테스트 결정 (After Step 6)
**Context**: 커버리지가 80% 임계값 미만인 경우에만 활성화됩니다. 어떤 종류의 테스트를 추가할지, 또는 예외를 인정할지 결정하는 시점입니다.
**Ask**: "커버리지가 **80% 임계값 미만입니다**. 어떻게 대응할지 선택해 주세요."
**Options**:
1. Add unit tests — 단위 테스트를 추가하여 함수/클래스 커버리지 향상
2. Add integration tests — 통합 테스트를 추가하여 모듈 간 경로 커버리지 향상
3. Accept with justification — 낮은 커버리지를 문서화된 이유로 수용 (예: 외부 API 레이어)
**Default**: 1 (단위 테스트가 가장 빠르고 저렴하게 커버리지를 올리는 방법)
**Skippable**: Yes (커버리지가 이미 80% 이상이면 이 체크포인트는 건너뜀)
**Freedom**: HIGH

### Checkpoint 4: 테스트 품질 최종 검토 (After Step 7)
**Context**: 모든 TDD 사이클이 완료된 후, 테스트 코드 자체의 품질 — 격리성, 네이밍, 단일 어설션 — 을 최종 점검하는 시점입니다.
**Ask**: "테스트 품질 기준을 **모두 충족하나요**? 격리성, 네이밍, 단일 어설션 포커스를 확인해 주세요."
**Options**:
1. Tests meet quality standards — 모든 품질 기준이 충족됨, 완료 처리
2. Revise — 특정 테스트가 격리 위반, 불명확한 네이밍, 다중 어설션 등의 문제를 가짐
**Default**: 1 (TDD 워크플로우를 따랐다면 품질 기준이 충족될 가능성이 높음)
**Skippable**: No — 품질 미달 테스트는 미래에 false positive/negative를 만들어냄
**Freedom**: MEDIUM

## Freedom Levels

| Step | Freedom | Guidance |
|------|:-------:|----------|
| Write failing test | MEDIUM | Behavior focus mandatory, assertion style flexible |
| Run test (fail) | LOW | Must fail for the right reason |
| Write minimal code | LOW | Minimum implementation only |
| Run test (pass) | LOW | Must pass, no exceptions |
| Refactor | HIGH | Creative cleanup, maintain green |
| Verify coverage | LOW | 80% threshold is non-negotiable |
| Test quality review | MEDIUM | Rules exist, apply with judgment on edge cases |

## Quick Reference

| Test Type | Count | Speed | Scope | Coverage Target |
|-----------|-------|-------|-------|-----------------|
| Unit | Many | <10ms | Function/class | >=80% |
| Integration | Some | <1s | Module/API | >=70% |
| E2E | Few | <30s | User journey | Critical paths |

## Rationalizations

The following table captures common excuses agents make to skip critical steps in this skill, paired with factual rebuttals. Use this to catch and resist shortcuts.

| Excuse | Rebuttal |
|--------|----------|
| "A manual test is enough for this change" | Manual tests are not rerunnable by CI, do not prevent regressions, and exist only in your memory. Every future refactor has to re-discover the same edge cases by hand. Automated tests pay for themselves after the first regression they catch. |
| "100% coverage is overkill, 80% is the target anyway" | 80% is the floor, not the ceiling. The 20% you skip is almost always the error paths and edge cases — exactly where production bugs live. Coverage numbers mean nothing if the uncovered lines are the risky ones. |
| "Mocks are easier to write than fixtures" | Easy-to-write mocks drift from the real interface silently. When the real API changes, the mocked test keeps passing while production breaks. Fixtures — even minimal ones — anchor tests to real contracts. |
| "The integration test will catch it, I don't need a unit test" | Integration tests are slow, expensive, and imprecise — when they fail, you get a module name, not a function name. Unit tests isolate the defect; integration tests only prove something is wrong. You need both, not one. |
| "This test is flaky, I'll add .skip for now" | `.skip` is a permanent invisible hole. Every skipped test is a behavior that used to work and now may not. Either fix the flake (usually shared state or async timing) or delete the test with a postmortem — never skip silently. |
| "I'll test the private methods directly for simplicity" | Private methods are implementation details — tests coupled to them break on every refactor, creating false friction. Test the public API; if a private method is hard to reach through the API, that is a design signal, not a testing problem. |
| "The happy path test is enough" | Happy paths pass on day one regardless of test quality. Bugs live in empty arrays, null inputs, timeouts, and boundary values. A test suite with only happy paths is a marketing document, not a safety net. |

## Common Rationalizations

| Rationalization | Why it's wrong | What to do instead |
|---|---|---|
| "The E2E tests already cover this, unit tests would be redundant" | E2E tests run in minutes; unit tests run in milliseconds; when coverage drops and E2E is the only layer, developers wait 10 minutes to learn a one-line fix broke a helper function | Keep both layers: E2E for journey confidence, unit for fast local feedback |
| "80% is the target so I'll stop once I hit it" | 80% is a floor, not a goal; the 20% you omit is almost always the error branches and edge cases — the exact lines where production bugs live | After reaching 80%, identify which uncovered lines are risk-bearing and add targeted tests for them |
| "Test isolation means no shared state, but our tests run fine with shared DB" | "Run fine" in series is not isolation — shared DB state means test order matters, and any test that modifies shared data will cause intermittent failures in parallel runs | Use a test database per worker, or wrap each test in a transaction that rolls back |
| "Adding `.skip` is temporary until I have time to fix the flaky test" | `.skip` commits are permanent in practice; flaky tests silently removed from coverage calculations make the 80% threshold meaningless | Fix the flake immediately: either isolate the shared state, add retry logic for network tests, or delete the test with a written postmortem |
| "Test names don't matter as long as the assertion is correct" | Unclear test names make failure messages unreadable; `should return undefined` tells you nothing, `should return undefined when user has no email address` tells you exactly what to fix | Use the `should [behavior] when [condition]` naming pattern; enforce it in code review |

## Red Flags

- Any `describe` block with more than one `it.skip` or `test.skip`
- Test file that imports from the same module's implementation file (testing internals)
- `beforeAll` or shared variables used to pass state between `it` blocks
- Coverage threshold set to a value below 80% in `vitest.config.js` without a documented exception
- Test that asserts a function was called but never asserts what the function returned
- PR that adds new exported functions with zero corresponding test file additions
