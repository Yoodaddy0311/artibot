---
context: fork
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

## Output Template

```
TDD CYCLE REPORT
=================
Feature:    [feature/bug description]
Phase:      [RED | GREEN | REFACTOR]
Cycle:      [n] of [total]

TEST SCENARIO
─────────────
Objective:          [what behavior is being tested]
Starting Conditions:[preconditions, initial state]
Steps:
  1. [action/input]
  2. [action/input]
  3. [action/input]
Expected Outcome:   [precise expected result]
Actual Outcome:     [observed result - RED phase only]

TEST INVENTORY
──────────────
# | Test Description               | Status  | Coverage Impact
--|-------------------------------|---------|----------------
1 | [test name/behavior]          | [R/G]   | [+n% to target area]
2 | [test name/behavior]          | [R/G]   | [+n% to target area]
3 | [test name/behavior]          | [R/G]   | [+n% to target area]

COVERAGE STATUS
───────────────
Type         | Before | After  | Target | Status
─────────────|────────|────────|────────|──────────
Unit         | [%]    | [%]    | 80%    | [PASS|FAIL]
Integration  | [%]    | [%]    | 70%    | [PASS|FAIL]
Branch       | [%]    | [%]    | 85%    | [PASS|FAIL]

REFACTOR NOTES (if REFACTOR phase)
──────────────────────────────────
[1] [what was refactored]: [why, while keeping green]
[2] ...

NEXT CYCLE
──────────
[next behavior to test, or "All behaviors covered - ready to ship"]
```


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

### Checkpoint 1: 테스트 범위 결정 (After Step 1)
**Context**: 인터페이스/타입 정의 완료. 어떤 behaviors에 테스트를 작성할지 결정 필요.
**Ask**: "인터페이스 정의가 완료되었습니다. **어떤 범위로 테스트를 작성할까요?**"
**Options**:
1. 전체 behaviors — 모든 public method/property 테스트
2. 공개 API만 — 외부 노출 인터페이스만 테스트
3. 크리티컬 경로만 — 핵심 비즈니스 로직만 테스트
4. 직접 지정 — 테스트할 behaviors 수동 선택
**Default**: 2 (공개 API 테스트가 비용 대비 효과 최적)
**Skippable**: Yes — 기본값으로 진행
**Freedom**: MEDIUM

### Checkpoint 2: 테스트 실패 검증 (After Step 2)
**Context**: 실패 테스트 작성 완료. 올바른 이유로 실패하는지 확인 필요 (잘못된 이유로 실패하면 테스트 자체가 결함).
**Ask**: "테스트가 실패합니다. **올바른 이유로 실패하고 있나요?** (구현 부재로 인한 실패여야 함)"
**Options**:
1. 예 — 예상대로 실패, GREEN 단계 진행
2. 아니오 — 다른 이유로 실패, 테스트 수정 필요
3. 부분적 — 일부 테스트만 올바르게 실패
**Default**: 1 (대부분 올바른 실패)
**Skippable**: No — RED 단계의 핵심 검증
**Freedom**: LOW

### Checkpoint 3: 리팩토링 범위 결정 (After Step 5)
**Context**: 모든 테스트 통과(GREEN). 리팩토링 기회가 발견됨.
**Ask**: "리팩토링 기회 N개를 발견했습니다. **어떤 범위로 리팩토링할까요?**"
**Options**:
1. 전체 적용 — 발견된 모든 리팩토링 수행
2. 최대 효과만 — 가장 임팩트 큰 항목만 적용
3. 코드 정리만 — 네이밍, 포맷팅 등 경량 정리만
4. 스킵 — 현재 코드 유지, 다음 사이클로
**Default**: 2 (시간 대비 효과 최적)
**Skippable**: Yes — 기본값으로 진행
**Freedom**: HIGH

### Checkpoint 4: 커버리지 갭 대응 (After Step 6)
**Context**: 커버리지 측정 완료. 타겟 미달 시 대응 결정 필요.
**Ask**: "커버리지 [X]%. **갭이 있는 영역: [목록]. 어떻게 대응할까요?**"
**Options**:
1. 전체 보충 — 모든 갭에 테스트 추가
2. 크리티컬만 — 핵심 경로 갭만 보충
3. 현상 유지 — 현재 커버리지 수용
4. 별도 태스크 — 커버리지 개선을 별도 작업으로 등록
**Default**: 2 (크리티컬 경로 우선)
**Skippable**: Yes — 기본값으로 진행
**Freedom**: MEDIUM

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

## Output Template

```
TDD CYCLE REPORT
=================
Feature:    [feature/bug description]
Cycle:      [RED → GREEN → REFACTOR]
Date:       [date]

TEST RESULTS
------------
Phase    | Status | Details
---------|--------|---------------------------
RED      | DONE   | [test name] — fails as expected
GREEN    | DONE   | [implementation] — test passes
REFACTOR | DONE   | [changes made while green]

COVERAGE
--------
Type          | Before | After  | Delta  | Target
--------------|--------|--------|--------|--------
Unit          | [n%]   | [n%]   | [+/-%] | >= 80%
Integration   | [n%]   | [n%]   | [+/-%] | >= 70%

FILES CHANGED
-------------
File                    | Action   | Tests Added
------------------------|----------|------------
[file path]             | created  | [n]
[file path]             | modified | [n]

ANTI-PATTERNS CHECK
--------------------
- [ ] Tests written before code
- [ ] Testing behavior, not implementation
- [ ] No .skip or .only left
- [ ] Mocks at boundaries only
```

## Quick Reference
- Always RED before GREEN
- Every bug fix gets a regression test
- Test names describe expected behavior
- 80%+ unit, 70%+ integration coverage
