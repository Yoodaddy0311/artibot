---
context: fork
user-invocable: false
name: systematic-debugging
description: |
  Systematic debugging methodology enforcing root cause investigation before any fix.
  Iron Law: NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST.
  Auto-activates when: debugging errors, investigating failures, fixing bugs, troubleshooting issues.
  Triggers: debug, bug, error, fix, investigate, troubleshoot, root cause, regression, crash, 디버그, 버그, 에러, 수정
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 2
triggers:
  - "debug"
  - "bug"
  - "error"
  - "fix"
  - "investigate"
  - "troubleshoot"
  - "root cause"
  - "regression"
  - "crash"
agents:
  - "tdd-guide"
  - "backend-developer"
argument-hint: "[error-description] e.g., TypeError in auth.js, login 500 error"
tokens: "~3K"
category: "debugging"
---

# Systematic Debugging

Use `$ARGUMENTS` to describe the error or symptom to investigate.

## Contents
- [When This Skill Applies](#when-this-skill-applies)
- [Iron Law](#iron-law)
- [Core Guidance](#core-guidance)
- [Quick Reference](#quick-reference)
- [Workflow Checklist](#workflow-checklist)
- [Human Checkpoints](#human-checkpoints)
- [Freedom Levels](#freedom-levels)

## When This Skill Applies
- Investigating runtime errors, exceptions, or crashes
- Debugging failing tests or unexpected behavior
- Fixing reported bugs (user-reported or CI-detected)
- Diagnosing regressions after code changes
- Troubleshooting configuration or environment issues

## Iron Law

> **NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST.**

Do NOT apply any code change, patch, workaround, or configuration tweak until you have:
1. Reproduced the problem (or confirmed reproduction steps)
2. Identified the root cause with evidence (stack trace, log, code path)
3. Formed a hypothesis and validated it

Applying fixes without understanding the root cause leads to:
- Masking deeper issues that resurface later
- Introducing new bugs from incorrect assumptions
- Accumulating technical debt through band-aid patches

## Core Guidance

### Phase 1: Root Cause Investigation

**Reproduce** the issue in a controlled environment:
- Capture the exact error message, stack trace, or unexpected output
- Identify minimal reproduction steps (smallest input that triggers the bug)
- Note environment details: OS, Node version, config state

**Trace** the execution path:
- Read the code path from entry point to failure point
- Identify the exact line where behavior diverges from expectation
- Check recent changes (`git log`, `git diff`) that may have introduced the issue
- See `${CLAUDE_SKILL_DIR}/references/root-cause-tracing.md` for tracing techniques

**Classify** the root cause:
| Category | Examples | Typical Fix |
|----------|----------|-------------|
| Logic error | Wrong condition, off-by-one, missing case | Correct the logic |
| State corruption | Mutation, stale cache, race condition | Enforce immutability or synchronization |
| Contract violation | Wrong types, missing validation, API mismatch | Add validation at boundary |
| Environment | Missing dep, wrong config, path issue | Fix config or add guard |
| Regression | Recent change broke existing behavior | Revert or fix the change |

### Phase 2: Hypothesis Validation

Before writing any fix:
1. **State your hypothesis** explicitly: "The bug occurs because X causes Y when Z"
2. **Predict** what a fix would change: "If I change A, then B should stop happening"
3. **Validate** the hypothesis with evidence:
   - Add a temporary log/assertion at the suspected failure point
   - Write a failing test that reproduces the exact bug
   - Confirm the test fails for the predicted reason, not a different one

If the hypothesis is wrong, return to Phase 1. Do NOT guess-and-check with random fixes.

### Phase 3: Fix Application

Apply the **minimal correct fix**:
- Change only what is necessary to resolve the root cause
- Prefer targeted fixes over broad refactors (fix the bug, not the neighborhood)
- Follow existing code patterns and conventions
- See `${CLAUDE_SKILL_DIR}/references/defense-in-depth.md` for layered protection strategies

**Fix quality rules**:
- The fix must address the root cause, not just suppress the symptom
- No `try/catch` that silently swallows errors unless explicitly justified
- No `// TODO: fix later` — if it needs more work, create a tracked issue
- Immutable patterns: create new objects rather than mutating existing state

### Phase 4: Fix Verification

**Confirm** the fix resolves the issue:
1. Run the reproduction test — it must now pass
2. Run the full test suite — no regressions introduced
3. Verify edge cases related to the fix
4. Check that error handling is correct (errors propagate, not silently ignored)

**Document** the resolution:
- What was the root cause?
- What was changed and why?
- What test covers this case going forward?

## Output Template

```
DEBUG INVESTIGATION REPORT
===========================
Issue:      [error/bug description]
Severity:   [CRITICAL/HIGH/MEDIUM/LOW]
Date:       [date]

ROOT CAUSE
----------
Category:   [logic/state/contract/environment/regression]
Location:   [file:line]
Cause:      [1-2 sentence root cause description]
Evidence:   [stack trace, log output, or code snippet]

HYPOTHESIS
----------
Statement:  "The bug occurs because [X] causes [Y] when [Z]"
Validated:  [YES/NO — with evidence]

FIX APPLIED
-----------
File        | Line  | Change
------------|-------|---------------------------
[file]      | [n]   | [description of change]

VERIFICATION
------------
Check               | Status | Details
---------------------|--------|---------------------------
Reproduction test    | PASS   | [test name]
Full test suite      | PASS   | [n] tests, [n] passing
Edge cases           | PASS   | [cases checked]
Regression check     | PASS   | No new failures
```

## Output Template

```
DEBUG INVESTIGATION REPORT
===========================
Issue:       [1-line description]
Severity:    [CRITICAL | HIGH | MEDIUM | LOW]
Reported By: [source - user, CI, monitoring]
Status:      [INVESTIGATING | HYPOTHESIS | FIXING | VERIFIED | CLOSED]

PHASE 1: REPRODUCTION
─────────────────────
Error Message: [exact error or symptom]
Minimal Repro:
  1. [step to reproduce]
  2. [step]
  3. [step] -> [failure observed]
Environment:   [OS, Node version, config state]

PHASE 2: ROOT CAUSE ANALYSIS
────────────────────────────
Execution Trace:
  [entry point] -> [module] -> [function:line] -> [failure point]

Classification: [Logic Error | State Corruption | Contract Violation | Environment | Regression]
Root Cause:     [explicit statement: "X causes Y when Z"]

PRE-MORTEM (what could go wrong with the fix?)
───────────────────────────────────────────────
TIGER: [real risk of the fix introducing new issues]
  Mitigation: [how to prevent]
PAPER TIGER: [appears risky but actually safe because...]
ELEPHANT: [broader issue this bug reveals but not fixing now]

PHASE 3: FIX
─────────────
Hypothesis:  [if I change A, then B should stop happening]
Fix Applied: [file:line - what was changed]
Scope:       [MINIMAL | MODERATE | BROAD]

PHASE 4: VERIFICATION
─────────────────────
Regression Test: [test name] - [PASS | FAIL]
Full Suite:      [n] passed, [n] failed - [GREEN | REGRESSION]
Edge Cases:      [tested? Y/N - list if applicable]

RESOLUTION SUMMARY
──────────────────
Root Cause:  [1 sentence]
Fix:         [1 sentence]
Test:        [test file:name that prevents recurrence]
Lesson:      [what to watch for in future - optional]
```


## Quick Reference
- Iron Law: investigate root cause BEFORE any fix
- 4 phases: Investigate -> Validate hypothesis -> Fix -> Verify
- Root cause tracing: `${CLAUDE_SKILL_DIR}/references/root-cause-tracing.md`
- Defense in depth: `${CLAUDE_SKILL_DIR}/references/defense-in-depth.md`

## Workflow Checklist

Copy this checklist and track progress:

```
Progress:
- [ ] Step 1: Reproduce the issue — capture error, minimal repro steps
- [ ] Step 2: Trace execution path — read code from entry to failure point
- [ ] Step 3: Classify root cause — logic/state/contract/environment/regression
- [ ] Step 4: Form hypothesis — state explicitly what causes the bug
- [ ] Step 5: Write failing test — reproduces the exact bug
- [ ] Step 6: Validate hypothesis — test fails for the predicted reason
- [ ] Step 7: Apply minimal fix — address root cause, not symptoms
- [ ] Step 8: Verify fix — repro test passes, full suite green, no regressions
- [ ] Step 9: Document resolution — root cause, fix rationale, test coverage
```

## Human Checkpoints

### Checkpoint 1: 조사 전략 선택 (After Step 2)
**Context**: 실행 경로 추적 완료. 다음 조사 방향 결정 필요.
**Ask**: "실행 경로를 추적했습니다. **어떤 조사 전략으로 진행할까요?**"
**Options**:
1. 로깅 추가 — 의심 지점에 임시 로그 삽입
2. 재현 테스트 — 실패 재현 테스트 작성
3. git bisect — 문제 도입 커밋 이진 탐색
4. 코드 리뷰 — 관련 코드 수동 분석
5. 전체 — 모든 전략 병행
**Default**: 2 (재현 테스트가 가장 확실)
**Skippable**: Yes — 기본값으로 진행
**Freedom**: MEDIUM

### Checkpoint 2: 근본 원인 확인 (After Step 3)
**Context**: 근본 원인 분류 완료. 진단 결과 검증 필요.
**Ask**: "근본 원인: [카테고리] — '[설명]'. 신뢰도 [H/M/L]. **이 진단에 동의하시나요?**"
**Options**:
1. 동의 — 가설 검증 단계로 진행
2. 부분 동의 — 방향은 맞지만 세부 조정 필요
3. 반대 — 다른 원인 의심, 재조사 필요
4. 추가 조사 — 더 많은 증거 수집 후 판단
**Default**: 1 (진단 결과 신뢰)
**Skippable**: No — 근본 원인 확인은 Iron Law의 핵심
**Freedom**: LOW

### Checkpoint 3: 수정 전략 선택 (After Step 6)
**Context**: 가설 검증 완료. 수정 방식 결정 필요.
**Ask**: "가설이 검증되었습니다. **어떤 수정 전략을 적용할까요?**"
**Options**:
1. 최소 수정 — 근본 원인만 정확히 수정
2. 구조적 수정 — 근본 원인 + 관련 구조 개선
3. 방어적 수정 — 수정 + 유사 문제 방지 가드 추가
4. 대안 제안 — 여러 수정안 비교 후 선택
**Default**: 1 (최소 수정이 리스크 최소)
**Skippable**: Yes — 기본값으로 진행
**Freedom**: MEDIUM

### Checkpoint 4: 추가 검증 범위 (After Step 8)
**Context**: 수정 검증 완료. 추가 검증 필요 여부 결정.
**Ask**: "수정이 검증되었습니다. **추가 검증 범위는?**"
**Options**:
1. 충분 — 현재 검증으로 충분, 완료 처리
2. 엣지 케이스 추가 — 관련 엣지 케이스 테스트 추가
3. 확장 회귀 — 영향 받는 모듈 전체 회귀 테스트
4. 수동 테스트 — 자동화 외 수동 검증 추가
**Default**: 1 (충분한 검증 완료)
**Skippable**: Yes — 기본값으로 진행
**Freedom**: MEDIUM

## Freedom Levels

| Step | Freedom | Guidance |
|------|:-------:|----------|
| Reproduce issue | LOW | Must capture exact error and minimal repro steps |
| Trace execution | MEDIUM | Multiple valid approaches (logs, debugger, code reading) |
| Classify root cause | MEDIUM | Categories defined, but judgment needed for edge cases |
| Form hypothesis | HIGH | Creative thinking required, multiple valid hypotheses |
| Write failing test | LOW | Must reproduce the exact bug, not a similar one |
| Validate hypothesis | LOW | Evidence-based, no guessing |
| Apply fix | MEDIUM | Minimal change required, but approach is flexible |
| Verify fix | LOW | Full test suite must pass, no exceptions |
| Document resolution | MEDIUM | Format flexible, content must include root cause and fix rationale |
