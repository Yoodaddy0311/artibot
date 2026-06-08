---
context: fork
user-invocable: false
name: production-code-audit
description: |
  자율 코드베이스 스캔 방법론 - 라인별 분석, 보안/성능/아키텍처/품질 이슈 탐지, 기업급 변환 체크리스트.
  Auto-activates when: production readiness audit, codebase security scan, enterprise quality check.
  Triggers: production audit, code audit, make production-ready, 프로덕션 감사, 코드 감사
lang: [en, ko]
platforms: [claude-code]
level: progressive
progressive_disclosure:
  enabled: true
  level1_tokens: 200
  level2_tokens: 3500
triggers:
  - "production audit"
  - "code audit"
  - "production-ready"
  - "enterprise quality"
  - "프로덕션 감사"
  - "코드 감사"
  - "코드 품질 점검"
allowed-tools: [Read, Grep, Glob, Bash, Edit]
agents:
  - "code-reviewer"
  - "security-reviewer"
tokens: "~3.5K"
category: "quality"
version: "1.0.0"
risk: safe
lastVerified: "2026-06-08"
source_hash: 17d9f59e
whenNotToUse: "Do not run a full 4-phase audit on proof-of-concept branches, internal tooling with no external exposure, or code that is about to be deleted. Reserve audit depth for production-bound code or pre-release milestones."
---

# Production Code Audit

## When This Skill Applies
- "프로덕션 준비" 요청 시
- 코드베이스 전체 감사 필요 시
- 기업급/전문가급 품질 달성 필요 시
- 프로덕션 배포 전 최종 점검
- 보안 강화 요청 시

## Core Guidance (Level 1)

### 4-Phase Audit Process
1. **Discovery**: 전체 파일 스캔, 기술 스택 식별, 아키텍처 매핑
2. **Detection**: 라인별 이슈 탐지 (보안, 성능, 품질, 아키텍처, 테스트)
3. **Fix**: 우선순위별 자동 수정 (Critical → High → Medium → Low)
4. **Verify**: 테스트 실행, 개선 측정, 종합 리포트

### Issue Categories

| Category | Critical Examples |
|----------|-----------------|
| **Security** | SQL injection, hardcoded secrets, missing auth, weak hashing |
| **Performance** | N+1 queries, missing indexes, sync→async, missing cache |
| **Architecture** | Circular deps, god classes (>500 lines), tight coupling |
| **Code Quality** | High complexity (>10), duplication, magic numbers, dead code |
| **Testing** | Coverage <80%, missing edge cases, flaky tests |
| **Production** | Missing env vars, no logging, no health checks |

## Detailed Guide (Level 2)

### Phase 1: Autonomous Discovery
```bash
# 1. 파일 구조 전체 스캔
find . -type f -name "*.ts" -o -name "*.js" | head -100

# 2. 기술 스택 식별
cat package.json | grep -A 20 '"dependencies"'

# 3. 진입점 확인
grep -r "app.listen\|createServer\|express()" --include="*.ts" -l
```

### Phase 2: Issue Detection Checklist

**Security Scan**:
```bash
# SQL injection
grep -rn "SELECT.*\$\{" --include="*.ts"
grep -rn "query.*\`" --include="*.ts"

# Hardcoded secrets
grep -rn "password\s*=\s*['\"]" --include="*.ts"
grep -rn "API_KEY\s*=\s*['\"]" --include="*.ts"

# Missing input validation
grep -rn "req.body" --include="*.ts" | grep -v "validate\|schema\|parse"
```

**Performance Scan**:
```bash
# N+1 queries (loop 내 쿼리)
grep -B5 -A5 "await.*find\|await.*query" --include="*.ts" | grep -B5 "for\|forEach\|map"

# Missing indexes
grep -rn "findMany\|findAll" --include="*.ts" | grep "where"
```

**Architecture Scan**:
```bash
# God classes (500+ lines)
wc -l *.ts | sort -rn | head -20

# Circular dependencies
# 상호 import 패턴 탐지
```

### Phase 3: Priority-Based Fixes
1. **CRITICAL** (즉시): 보안 취약점, 데이터 손실 위험
2. **HIGH** (이번 스프린트): N+1, god class 분리, 인덱스 추가
3. **MEDIUM** (다음 스프린트): 코드 중복, 네이밍, 복잡도 축소
4. **LOW** (백로그): 문서화, 마이너 리팩토링

### Phase 4: Verification & Report

**Production Readiness Checklist**:
- [ ] Security: OWASP Top 10 준수
- [ ] Performance: API 응답 <200ms
- [ ] Testing: Coverage >80%
- [ ] Monitoring: 구조화된 로깅, 에러 트래킹
- [ ] Health: /health, /ready 엔드포인트
- [ ] Docs: API 문서, 배포 가이드

**Report Template**:
```markdown
# Production Audit Report
**Project**: [Name] | **Date**: [Date] | **Grade**: [A-F]

## Executive Summary
[2-3 문장 전체 상태]

## Findings by Category
| Category | Grade | Critical | High | Medium | Low |
|----------|-------|----------|------|--------|-----|
| Security | | | | | |
| Performance | | | | | |
| Architecture | | | | | |
| Testing | | | | | |

## Priority Actions
1. [Critical] - [Timeline]
2. [High] - [Timeline]
```

## Guidelines
1. 전체 파일 스캔 후 이슈 탐지 (부분 스캔 금지)
2. 이슈 발견 시 리포트만 하지 말고 실제 수정
3. Critical/High 우선 처리
4. 변경 후 테스트 통과 확인
5. Before/After 메트릭 포함한 리포트
6. 분기별 정기 감사 권장

## Rationalizations

The following table captures common excuses agents make to skip the rigor of this skill, paired with factual rebuttals.

| Excuse | Rebuttal |
|--------|----------|
| "linter caught everything" | linters do not check for business logic bugs or privacy leaks |
| "audit after ship, it is faster" | post-ship audits discover issues you cannot rollback; audit before |
| "code review covered this" | code review is per-PR; audit is cross-cutting — different lenses catch different bugs |
| "tests would have caught it" | tests catch what you thought to test; audits catch what you did not |
| "the scan is noisy" | triage the signal, tune the rules — noisy output is better than silent failure |

## Common Rationalizations

| Rationalization | Why it's wrong | What to do instead |
|---|---|---|
| "We already have a linter and tests so the audit is redundant" | Linters enforce style; tests verify what you chose to test; audits find cross-cutting issues that neither scans for (auth gaps, N+1 patterns, god classes) | Run the audit as a fourth layer after lint and tests — each layer has a different detection surface |
| "Critical issues will be caught in staging" | Staging environments rarely have production-scale data, production IAM roles, or production traffic patterns; audit catches structural issues that staging traffic never triggers | Fix Critical and High findings before the code reaches any shared environment |
| "The audit report is a list, not a priority — I'll handle items when convenient" | Unordered audit output gets triaged as low-priority indefinitely; Critical findings without deadlines never get fixed | Assign CRITICAL items to the current sprint, HIGH to the next one, track in your issue tracker |
| "Automated scanning already ran in CI, manual audit is overkill" | Automated scanners catch known vulnerability patterns; manual audit phases (Discovery, Architecture) require human judgment about design intent | Use automated scans as Phase 2 input, not as a replacement for Phase 1 Discovery or Phase 3 fixes |
| "We can't stop development for an audit" | Audits run on existing code, not blocking code in flight; schedule a time-boxed audit sprint quarterly without halting feature work | Time-box the audit to two days per quarter — that is the cost of a single production incident |

## Red Flags

- Audit report generated but no CRITICAL items linked to issues in the tracker
- Phase 1 Discovery skipped and scan started directly from grep patterns
- Audit findings reported as a markdown file with no owner assigned
- Before/After metrics absent from the audit report (no baseline to measure improvement)
- Security scan limited to dependency vulnerabilities only, missing injection and auth checks
- Audit run by the same engineer who wrote the code without a second reviewer on Critical findings
