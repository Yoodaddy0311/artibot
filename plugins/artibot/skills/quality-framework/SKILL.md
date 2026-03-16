---
context: forked
name: quality-framework
description: "ATLAS Quality Framework for Artibot: Automated, Tested, Learned, Adaptive, Secure. Defines 8-step validation cycle, coverage targets, and GRPO-driven continuous quality improvement. Use when performing code review, setting quality gates, running validation cycles, or assessing coverage."
level: 3
triggers:
  - "quality"
  - "quality framework"
  - "ATLAS"
  - "validation cycle"
  - "coverage"
  - "quality gate"
  - "code review"
  - "quality standards"
  - "testing standards"
  - "security validation"
  - "performance standards"
  - "quality metrics"
agents:
  - "tdd-guide"
  - "security-reviewer"
  - "performance-engineer"
  - "refactor-cleaner"
tokens: "~5K"
category: "code-quality"
platforms: [claude-code, gemini-cli, codex-cli, cursor]
---

# ATLAS Quality Framework

## Contents
- [When This Skill Applies](#when-this-skill-applies)
- [ATLAS Dimensions](#atlas-dimensions)
- [8-Step Validation Cycle](#8-step-validation-cycle)
- [Quality Metrics Dashboard](#quality-metrics-dashboard)
- [GRPO Quality Improvement Loop](#grpo-quality-improvement-loop)
- [Knowledge Transfer Protocol](#knowledge-transfer-protocol)
- [Quality Gate Integration](#quality-gate-integration)
- [Quick Reference](#quick-reference)
- [Workflow Checklist](#workflow-checklist)
- [Human Checkpoints](#human-checkpoints)
- [Freedom Levels](#freedom-levels)

**Automated | Tested | Learned | Adaptive | Secure**

Artibot's integrated quality framework combining evidence-based validation, GRPO self-learning, and knowledge transfer for continuous quality improvement.

## When This Skill Applies
- Code review and quality assessment
- Defining acceptance criteria for features
- Setting up CI/CD quality gates
- Post-implementation validation
- Security and performance audits
- Coverage analysis and improvement

## ATLAS Dimensions

### A - Automated
Quality validation runs automatically, not as an afterthought.
- CI/CD gates block merges on quality failures
- Lint and type checking on every save
- Test execution on every commit
- Security scanning on every PR
- Performance regression detection on every deploy

### T - Tested
Evidence-based testing with measurable coverage targets.

| Level | Target | Scope |
|-------|--------|-------|
| Unit | >= 80% | Functions, pure logic, utilities |
| Integration | >= 70% | API endpoints, database operations |
| E2E | Critical paths | User workflows, conversion flows |
| Type coverage | 100% | No `any`, no untyped exports |
| Security | OWASP Top 10 | All input surfaces |

### L - Learned
GRPO self-learning continuously improves quality decisions.
- Tool usage patterns tracked per context type
- Success rates compared across alternative approaches
- Group relative policy optimization ranks strategies
- Knowledge base updated after each session
- Patterns propagated via swarm intelligence (opt-in)

### A - Adaptive
Quality standards evolve with the codebase complexity.
- Thresholds adjust based on project phase (prototype vs production)
- Risk-weighted coverage (critical paths get higher targets)
- Context-aware validation depth (--think for complex changes)
- Wave orchestration for comprehensive quality sweeps

### S - Secure
Security validation integrated into every quality check.
- OWASP Top 10 checklist on every PR
- Secret scanning before every commit
- Dependency vulnerability audit weekly
- Authorization checks on all API endpoints
- Input sanitization validated at system boundaries

## 8-Step Validation Cycle

```
Step 1: SYNTAX
  ├─ Language parser validation
  ├─ Linter checks (ESLint, ruff, golangci-lint, clippy)
  └─ Formatter compliance (Prettier, Black, gofmt, rustfmt)

Step 2: TYPES
  ├─ Type checker (tsc, mypy --strict, go vet, cargo check)
  ├─ No implicit any or untyped exports
  └─ API contract type safety

Step 3: LINT
  ├─ Code style rules
  ├─ Complexity metrics (cyclomatic <= 10, cognitive <= 15)
  └─ Naming conventions enforced

Step 4: SECURITY
  ├─ OWASP Top 10 scan
  ├─ Secret detection (no hardcoded credentials)
  ├─ Dependency vulnerability audit
  └─ Input validation at all boundaries

Step 5: TESTS
  ├─ Unit test execution (target: >= 80%)
  ├─ Integration test execution (target: >= 70%)
  ├─ E2E tests for critical paths
  └─ Regression suite passes

Step 6: PERFORMANCE
  ├─ Response time within budget (<200ms API, <3s page load)
  ├─ Bundle size check (<500KB initial)
  ├─ Memory usage within limits
  └─ No N+1 queries introduced

Step 7: DOCUMENTATION
  ├─ Public API documented
  ├─ README updated if behavior changed
  ├─ CHANGELOG entry for user-facing changes
  └─ Architecture decisions recorded if significant

Step 8: INTEGRATION
  ├─ No breaking changes without versioning
  ├─ Feature flags for risky rollouts
  ├─ Monitoring and alerting configured
  └─ Rollback procedure verified
```

**Blocking steps**: 1, 2, 4, 5 (must pass to merge)
**Warning steps**: 3, 6, 7, 8 (flag for review, don't block)

## Quality Metrics Dashboard

### Code Health Indicators
| Metric | Green | Yellow | Red |
|--------|-------|--------|-----|
| Unit coverage | >= 80% | 60-80% | < 60% |
| Cyclomatic complexity | <= 10 | 11-20 | > 20 |
| Technical debt ratio | < 5% | 5-15% | > 15% |
| Security vulnerabilities (critical) | 0 | - | > 0 |
| Dependency age | < 6mo | 6-12mo | > 12mo |
| Test flakiness rate | 0% | < 2% | >= 2% |

### Performance Budgets
| Layer | Target | Max |
|-------|--------|-----|
| API response | < 100ms | 200ms |
| Page load (3G) | < 2s | 3s |
| Bundle (initial) | < 300KB | 500KB |
| Database query | < 50ms | 100ms |
| Memory (server) | < 256MB | 512MB |

## GRPO Quality Improvement Loop

Artibot uses Group Relative Policy Optimization for quality strategy selection:

```
1. OBSERVE: Record quality issue type, context, and outcome
2. COMPARE: Group similar issues, compare resolution strategies
3. RANK: Score strategies by success rate (resolved + no regression)
4. UPDATE: Increase weight for high-scoring strategies
5. APPLY: Prefer high-weight strategies in similar future contexts
6. TRANSFER: Share learned patterns across sessions (continuous-learning skill)
```

**Example learning**:
- Context: "TypeScript null reference errors in API handlers"
- Strategies compared: `Optional chaining`, `Explicit null checks`, `Result type`
- Winner (highest success rate): `Result type` pattern
- Future: Suggest `Result type` first for this context

## Knowledge Transfer Protocol

After completing any significant quality improvement:

1. **Pattern extraction**: What worked well?
2. **Root cause**: Why was quality issue introduced?
3. **Prevention**: What process prevents recurrence?
4. **Generalization**: Where else in the codebase could this apply?
5. **Documentation**: Update memory files if pattern is reusable

## Quality Gate Integration

### PR Checklist (Automated)
```yaml
quality_gates:
  required:
    - lint: "npm run lint && tsc --noEmit"
    - test: "npm test -- --coverage --threshold 80"
    - security: "npm audit --audit-level=high"
  recommended:
    - complexity: "eslint --rule 'complexity: [warn, 10]'"
    - performance: "bundlesize check"
    - docs: "typedoc --validation"
```

### Manual Review Checklist
- [ ] Business logic correct per requirements
- [ ] Edge cases tested (empty, null, max, concurrent)
- [ ] Error messages user-friendly and non-leaking
- [ ] Database queries optimized (no N+1)
- [ ] Breaking change documented and versioned
- [ ] Feature flag for risky changes

## Output Template

```
QUALITY VALIDATION REPORT
=========================
Project:    [project name]
Date:       [date]
Scope:      [file/module/project]

VALIDATION RESULTS
------------------
Step              | Status  | Details
------------------|---------|---------------------------
1. Syntax         | PASS/FAIL | [parser/formatter result]
2. Types          | PASS/FAIL | [type checker result]
3. Lint           | PASS/FAIL | [errors/warnings count]
4. Security       | PASS/FAIL | [vulnerabilities found]
5. Tests          | PASS/FAIL | [pass/fail count, coverage %]
6. Performance    | PASS/WARN | [response time, bundle size]
7. Documentation  | PASS/WARN | [coverage %, missing items]
8. Integration    | PASS/WARN | [breaking changes, flags]

QUALITY METRICS
---------------
Metric           | Value   | Status | Threshold
-----------------|---------|--------|----------
Unit coverage    | [n%]    | [G/Y/R]| >= 80%
Complexity avg   | [n]     | [G/Y/R]| <= 10
Tech debt ratio  | [n%]    | [G/Y/R]| < 5%
Test flakiness   | [n%]    | [G/Y/R]| 0%

BLOCKING ISSUES
---------------
[List of blocking issues that must be resolved before merge]

RECOMMENDATIONS
---------------
Priority | Action              | Impact
---------|---------------------|--------
P1       | [action]            | [impact]
```

## Output Template

```
QUALITY ASSESSMENT REPORT
==========================
Project:   [name]
Framework: ATLAS (Assess -> Test -> Limit -> Assure -> Sustain)
Date:      [YYYY-MM-DD]
Scope:     [files/modules assessed]

QUALITY GATE STATUS
───────────────────
Gate                | Score  | Threshold | Status
────────────────────|────────|───────────|──────────
Syntax & Parsing    | [val]  | PASS      | [PASS|FAIL]
Type Safety         | [val]  | PASS      | [PASS|FAIL]
Lint & Style        | [n err]| 0 errors  | [PASS|FAIL]
Security Scan       | [n vul]| 0 critical| [PASS|FAIL]
Test Coverage       | [%]    | >=80%     | [PASS|FAIL]
Performance Budget  | [val]  | [target]  | [PASS|FAIL]
Documentation       | [%]    | >=70%     | [PASS|FAIL]
Integration         | [pass] | All green | [PASS|FAIL]

RISK CLASSIFICATION (for failed gates)
──────────────────────────────────────
TIGERS (real, high-impact risks - address immediately)
  [1] [risk]: [impact] -> Fix: [action]
  [2] ...

PAPER TIGERS (appear dangerous but manageable)
  [1] [risk]: [why it looks bad] -> Reality: [why it is acceptable]
  [2] ...

ELEPHANTS (everyone sees but nobody addresses)
  [1] [risk]: [why it persists] -> Cost of inaction: [consequence]
  [2] ...

QUALITY METRICS SUMMARY
───────────────────────
Metric             | Current | Previous | Trend
───────────────────|─────────|──────────|──────
Statements         | [%]     | [%]      | [up/down/flat]
Branches           | [%]     | [%]      | [up/down/flat]
Functions          | [%]     | [%]      | [up/down/flat]
ESLint Warnings    | [n]     | [n]      | [up/down/flat]
Tech Debt (hours)  | [n]     | [n]      | [up/down/flat]

RECOMMENDATIONS
───────────────
Priority | Quality Area | Action               | Effort
---------|-------------|----------------------|--------
P1       | [area]      | [action]             | [L/M/H]
```


## Quick Reference

**Validation order**: Syntax -> Types -> Lint -> Security -> Tests -> Performance -> Docs -> Integration

**Coverage formula**:
```
Priority Weight = (Business Impact × 0.4) + (Change Frequency × 0.3) + (Complexity × 0.3)
Coverage Target = Base(70%) + (Priority Weight × 30%)
```

**Complexity thresholds**:
- Cyclomatic: <= 10 (simple), 11-15 (refactor), > 15 (must refactor)
- Cognitive: <= 15 (ok), 16-25 (warning), > 25 (block)
- Function length: <= 50 lines (ok), 51-100 (warning), > 100 (split)

**When to escalate**:
- Any critical security vulnerability -> Stop, fix immediately
- Coverage drops > 5% from baseline -> Require test additions
- Performance regression > 20% -> Block and investigate

## Workflow Checklist

Copy this checklist and track progress:

```
Progress:
- [ ] Step 1: SYNTAX — Run parser and formatter checks
- [ ] Step 2: TYPES — Run type checker (tsc, mypy, etc.)
- [ ] Step 3: LINT — Run linter with complexity thresholds
- [ ] Step 4: SECURITY — OWASP scan, secret detection, dep audit
- [ ] Step 5: TESTS — Unit (>=80%), integration (>=70%), E2E critical paths
- [ ] Step 6: PERFORMANCE — Response time, bundle size, memory checks
- [ ] Step 7: DOCUMENTATION — API docs, README, CHANGELOG updated
- [ ] Step 8: INTEGRATION — No breaking changes, feature flags, rollback ready
```

## Human Checkpoints

### Checkpoint 1: 검증 범위 선택 (Before Step 1)
**Context**: 8단계 검증 사이클 시작 전. 전체 실행 vs 선택적 실행 결정.
**Ask**: "8단계 검증 중 **어디에 집중할까요?**"
**Options**:
1. 전체 8단계 — 완전한 검증 사이클 실행
2. 블로킹 게이트만 — Step 1,2,4,5 (Syntax, Types, Security, Tests)
3. 보안 중심 — Step 4 (Security) + Step 5 (Tests) 심층 분석
4. 커스텀 — 특정 단계 직접 선택
**Default**: 2 (블로킹 게이트가 핵심)
**Skippable**: Yes — 기본값으로 진행
**Freedom**: MEDIUM

### Checkpoint 2: 보안 발견 대응 (After Step 4)
**Context**: 보안 스캔에서 취약점 발견됨. 심각도별 대응 결정 필요.
**Ask**: "보안 취약점 [N]건 발견. **비크리티컬 항목 처리 방침은?**"
**Options**:
1. 전체 수정 — 모든 취약점 즉시 수정
2. Critical + High만 — 긴급 항목만 수정, 나머지 트래킹
3. Critical만 — 최소 수정, 나머지 별도 태스크
4. 개별 판단 — 각 취약점별 수정/보류 결정
**Default**: 2 (Critical + High 우선)
**Skippable**: No — 보안은 스킵 불가
**Freedom**: LOW

### Checkpoint 3: 커버리지 대응 (After Step 5)
**Context**: 테스트 커버리지 측정 완료. 타겟 대비 결과 확인.
**Ask**: "커버리지 [X]% (타겟 [Y]%). **갭 대응 방침은?**"
**Options**:
1. 전체 보충 — 모든 미커버 영역 테스트 추가
2. 상위 3 리스크만 — 가장 위험한 미커버 영역만 보충
3. 현상 유지 — 현재 수준 수용 (사유 기록)
4. 타겟 변경 — 프로젝트 상황에 맞게 타겟 재설정
**Default**: 2 (리스크 기반 우선순위)
**Skippable**: Yes — 기본값으로 진행
**Freedom**: MEDIUM

### Checkpoint 4: 브레이킹 체인지 전략 (After Step 8)
**Context**: 통합 검증에서 브레이킹 체인지 감지됨. 릴리스 전략 결정 필요.
**Ask**: "브레이킹 체인지가 감지되었습니다. **릴리스 전략은?**"
**Options**:
1. 메이저 버전 범프 — semver 메이저 업데이트
2. 피처 플래그 — 점진적 롤아웃
3. 호환성 래퍼 — 하위호환 유지하며 내부 변경
4. 리버트 — 변경 취소, 대안 설계
**Default**: 2 (피처 플래그가 가장 안전)
**Skippable**: No — 브레이킹 체인지는 반드시 결정 필요
**Freedom**: LOW

## Freedom Levels

| Step | Freedom | Guidance |
|------|:-------:|----------|
| Syntax validation | LOW | Must pass, blocking gate |
| Type checking | LOW | Must pass, blocking gate |
| Lint rules | MEDIUM | Complexity thresholds defined, warnings reviewable |
| Security scan | LOW | Must pass, blocking gate — zero tolerance for critical |
| Test execution | LOW | Coverage thresholds are non-negotiable |
| Performance check | MEDIUM | Budgets defined, warning-level (review, don't block) |
| Documentation | MEDIUM | Required for public API, depth flexible |
| Integration check | MEDIUM | Breaking change policy defined, rollback approach flexible |
