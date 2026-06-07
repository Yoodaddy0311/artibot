---
context: fork
user-invocable: false
name: quality-framework
description: "ATLAS Quality Framework for Artibot: Automated, Tested, Learned, Adaptive, Secure. Defines 8-step validation cycle, coverage targets, and GRPO-driven continuous quality improvement. Use when performing code review, setting quality gates, running validation cycles, or assessing coverage. 코드 리뷰, 품질 게이트 설정, 커버리지 분석, 보안 검증 시 자동 활성화."
lang: [en, ko]

level: 3
triggers:
  - "quality"
  - "quality framework"
  - "ATLAS"
  - "validation cycle"
  - "커버리지 임계값"
  - "quality gate"
  - "코드 품질 검토"
  - "quality standards"
  - "testing standards"
  - "security validation"
  - "performance standards"
  - "quality metrics"
  - "품질"
  - "품질 게이트"
  - "커버리지"
  - "품질 검토"
agent: Explore
allowed-tools: [Read, Grep, Glob]
agents:
  - "tdd-guide"
  - "security-reviewer"
  - "performance-engineer"
  - "refactor-cleaner"
tokens: "~3K"
category: "code-quality"
platforms: [claude-code, gemini-cli, codex-cli, cursor]
source_hash: c3db3f38
whenNotToUse: "Do not run the full 8-step ATLAS cycle on every micro-PR or hotfix. For single-file changes under 50 lines, run only the blocking gates (Steps 1, 2, 4, 5). Reserve full cycle execution for release candidates and architecture-level changes."
---

# ATLAS Quality Framework

**Automated | Tested | Learned | Adaptive | Secure**

## Current State
!`npm run lint 2>&1 | tail -3`
!`npm test 2>&1 | tail -5`

## When This Skill Applies
- Code review and quality assessment
- Defining acceptance criteria for features
- Setting up CI/CD quality gates
- Post-implementation validation
- Security and performance audits
- Coverage analysis and improvement

## 8-Step Validation Cycle

| Step | Gate | Type |
|------|------|------|
| 1 | Syntax — linter, formatter | **Blocking** |
| 2 | Types — tsc/mypy/cargo check | **Blocking** |
| 3 | Lint — complexity ≤10 cyclomatic | Warning |
| 4 | Security — OWASP Top 10, secret scan | **Blocking** |
| 5 | Tests — unit ≥80%, integration ≥70% | **Blocking** |
| 6 | Performance — <200ms API, <3s page | Warning |
| 7 | Documentation — public API, CHANGELOG | Warning |
| 8 | Integration — no breaking changes, flags | Warning |

## Coverage Targets

| Level | Target |
|-------|--------|
| Unit | ≥ 80% |
| Integration | ≥ 70% |
| Type coverage | 100% (no `any`) |
| Security | OWASP Top 10 |

## Quick Reference

**Blocking gates**: Steps 1, 2, 4, 5 — must pass to merge.  
**Warning gates**: Steps 3, 6, 7, 8 — flag for review, don't block.

**Escalate immediately when**:
- Any critical security vulnerability found (Step 4)
- Coverage drops >5% from baseline (Step 5)
- Performance regression >20% (Step 6)

**Workflow checklist**: See `references/atlas-checklist.md`  
**Output templates**: See `references/output-templates.md`  
**Metrics dashboard**: See `references/metrics-dashboard.md`

## GRPO Quality Loop

After resolving any quality issue: observe context → compare strategies → rank by success rate → update weights → apply to future similar contexts. Enable via `artibot.config.json` quality pattern logging.

## Common Rationalizations
- "테스트는 나중에" → 위반: Step 5는 Blocking gate
- "커버리지 80%면 충분해" → 기준선이지 목표가 아님; 하락 추세가 문제
- "이번 PR은 작아서 ATLAS 안 해도 돼" → hotfix 제외 모든 PR에 최소 Blocking gates 적용
- "보안 이슈는 다음 스프린트에" → Step 4 critical = 즉시 차단, 다음 스프린트 없음

## Red Flags
- lint/type 오류 무시하고 머지
- 커버리지 수치 없이 "충분히 테스트했다" 주장
- security validation 건너뛰기
- quality gate 실패 후 재실행 없이 승인 요청
